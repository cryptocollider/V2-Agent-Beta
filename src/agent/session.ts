import { setTimeout as sleep } from "node:timers/promises";
import type { AgentPolicy } from "../policy/schema.js";
import type { Hex32 } from "../collider/types.js";
import type { WasmVizRuntime } from "../sim/wasm.js";
import type { StoragePaths } from "../core/storage.js";
import { appendResultLog } from "../core/storage.js";
import { getRuntimeSettings, getControlState, updateControlState } from "../core/runtime-state.js";
import { matchReportToSubmittedThrow, type ExpectedThrowSummary } from "./report-match.js";
import { runAgentOnce, type ColliderClientLike, type LoopConfig } from "./loop.js";

export type ColliderClientSessionLike = ColliderClientLike & {
  getGameReport(gameId: Hex32): Promise<unknown>;
};

export type SessionConfig = {
  pollMs: number;
  maxCycles?: number;
  cooldownMsPerGame?: number;
};

type SubmittedDecision = {
  decisionId: string;
  gameId: Hex32;
  submittedAt: number;
  expected?: ExpectedThrowSummary;
};

type RecentShot = {
  x: number;
  y: number;
  angleDeg: number;
  speedPct: number;
  spinPct: number;
};

function extractGameStatus(raw: unknown): number | null {
  const r = raw as Record<string, any> | null;
  if (!r || typeof r !== "object") return null;
  if (Number.isFinite(Number(r.status))) return Number(r.status);
  if (r.game && Number.isFinite(Number(r.game.status))) return Number(r.game.status);
  return null;
}

function extractSettledHeight(raw: unknown): number | null {
  const r = raw as Record<string, any> | null;
  if (!r || typeof r !== "object") return null;
  if (Number.isFinite(Number(r.settled_height))) return Number(r.settled_height);
  if (r.game && Number.isFinite(Number(r.game.settled_height))) return Number(r.game.settled_height);
  return null;
}

function payloadToRecentShot(payload: unknown): RecentShot | null {
  const p = payload as Record<string, any> | null;
  if (!p) return null;

  const x = Number(p?.init_pose?.pos?.x ?? NaN);
  const y = Number(p?.init_pose?.pos?.y ?? NaN);
  const angleRad = Number(p?.init_pose?.angle_rad ?? NaN);
  const vx = Number(p?.init_linvel?.x ?? NaN);
  const vy = Number(p?.init_linvel?.y ?? NaN);
  const angVel = Number(p?.init_angvel ?? NaN);

  if (![x, y, angleRad, vx, vy, angVel].every(Number.isFinite)) return null;

  return {
    x,
    y,
    angleDeg: (angleRad * 180) / Math.PI,
    speedPct: Math.sqrt(vx * vx + vy * vy),
    spinPct: angVel,
  };
}

function payloadToExpectedSummary(payload: unknown): ExpectedThrowSummary {
  const p = payload as Record<string, any>;
  return {
    payload: {
      asset: p?.asset != null ? String(p.asset) : undefined,
      amount: p?.amount != null ? String(p.amount) : undefined,
      x: Number.isFinite(Number(p?.init_pose?.pos?.x)) ? Number(p.init_pose.pos.x) : undefined,
      y: Number.isFinite(Number(p?.init_pose?.pos?.y)) ? Number(p.init_pose.pos.y) : undefined,
      angle_rad: Number.isFinite(Number(p?.init_pose?.angle_rad)) ? Number(p.init_pose.angle_rad) : undefined,
      vx: Number.isFinite(Number(p?.init_linvel?.x)) ? Number(p.init_linvel.x) : undefined,
      vy: Number.isFinite(Number(p?.init_linvel?.y)) ? Number(p.init_linvel.y) : undefined,
      angVel: Number.isFinite(Number(p?.init_angvel)) ? Number(p.init_angvel) : undefined,
    },
  };
}

export async function runAgentSession(
  client: ColliderClientSessionLike,
  wasm: WasmVizRuntime,
  basePolicy: AgentPolicy,
  baseLoopCfg: LoopConfig,
  sessionCfg: SessionConfig,
): Promise<void> {
  const cooldownMsPerGame = sessionCfg.cooldownMsPerGame ?? 20_000;
  const maxCycles = sessionCfg.maxCycles ?? Number.MAX_SAFE_INTEGER;

  const recentGameTouches = new Map<string, number>();
  const sessionThrowCounts = new Map<string, number>();
  const pendingSubmitted: SubmittedDecision[] = [];
  const recentShots: RecentShot[] = [];

  let totalLiveThrows = 0;
  let lastLiveThrowAt = 0;

  for (let cycle = 0; cycle < maxCycles; cycle++) {
    const now = Date.now();

    try {
      const rt = getRuntimeSettings();
      const ctl = getControlState();

      if (ctl.state === "paused") {
        await sleep(Number(rt.pollMs ?? sessionCfg.pollMs));
        continue;
      }

      const effectivePolicy: AgentPolicy = {
        ...basePolicy,
        maxThrowsPerGame: Number(rt.maxThrowsPerGame ?? basePolicy.maxThrowsPerGame ?? 3),
        maxThrowsPerSession: Number(rt.maxThrowsPerSession ?? basePolicy.maxThrowsPerSession ?? 50),
        minMillisBetweenLiveThrows: Number(
          rt.minMillisBetweenLiveThrows ?? basePolicy.minMillisBetweenLiveThrows ?? 20_000,
        ),
      };

      const effectiveLoopCfg: LoopConfig = {
        ...baseLoopCfg,
        defaultAsset: rt.asset || baseLoopCfg.defaultAsset,
        defaultAmount: String(rt.amount || baseLoopCfg.defaultAmount),
        candidateBudget: {
          ...baseLoopCfg.candidateBudget,
          maxCandidates: Number(rt.maxCandidates ?? baseLoopCfg.candidateBudget?.maxCandidates ?? 50),
          maxMillis: Number(rt.maxMs ?? baseLoopCfg.candidateBudget?.maxMillis ?? 20_000),
        },
        scoreConfig: {
          ...baseLoopCfg.scoreConfig,
          recentShots,
        },
      };

      for (let i = pendingSubmitted.length - 1; i >= 0; i--) {
        const p = pendingSubmitted[i];
        try {
          const gameRaw = await client.getGame(p.gameId);
          const status = extractGameStatus(gameRaw);
          const settledHeight = extractSettledHeight(gameRaw);
          const isSettled = (status != null && status >= 4) || (settledHeight != null && settledHeight > 0);
          if (!isSettled) continue;

          const report = await client.getGameReport(p.gameId);
          const matched = matchReportToSubmittedThrow(report, effectiveLoopCfg.botUser, p.expected);
          const holeType = matched?.throwMatch?.hole_type;
          const scoreboard = matched?.wholeGame?.per_user_scoreboard;
          if (holeType == null || !Array.isArray(scoreboard) || scoreboard.length === 0) {
            console.warn(`[session] settled report still incomplete for ${p.gameId} decision=${p.decisionId}; waiting for full fields`);
            continue;
          }

          if (effectiveLoopCfg.storage) {
            await appendResultLog(effectiveLoopCfg.storage as StoragePaths, {
              ts: new Date().toISOString(),
              sessionId: effectiveLoopCfg.sessionId,
              decisionId: p.decisionId,
              gameId: p.gameId,
              botUser: effectiveLoopCfg.botUser,
              actual: matched,
              expected: p.expected ?? {},
            });
          }

          pendingSubmitted.splice(i, 1);
        } catch (err) {
          console.warn(`[session] report not ready for ${p.gameId} decision=${p.decisionId}:`, err);
        }
      }

      if (!effectiveLoopCfg.dryRun) {
        if (totalLiveThrows >= (effectivePolicy.maxThrowsPerSession ?? Infinity)) {
          updateControlState({
            state: "paused",
            mode: ctl.mode || "regular",
            lastMessage: `Paused after reaching maxThrowsPerSession=${effectivePolicy.maxThrowsPerSession}.`,
            lastAction: { action: "auto_pause_max_throws", ts: new Date().toISOString(), throwsTarget: effectivePolicy.maxThrowsPerSession ?? null, exclusive: false },
          });
          console.log("[session] maxThrowsPerSession reached, pausing");
          await sleep(Number(rt.pollMs ?? sessionCfg.pollMs));
          continue;
        }

        if (now - lastLiveThrowAt < (effectivePolicy.minMillisBetweenLiveThrows ?? 0)) {
          await sleep(Number(rt.pollMs ?? sessionCfg.pollMs));
          continue;
        }
      }

      const filteredClient: ColliderClientLike = {
        listGames: async (statusMask?: number) => {
          const games = await client.listGames(statusMask);
          return games.filter((g) => {
            const lastTouch = recentGameTouches.get(g.game_id) ?? 0;
            const perGameCount = sessionThrowCounts.get(g.game_id) ?? 0;
            if (now - lastTouch < cooldownMsPerGame) return false;
            if (perGameCount >= (effectivePolicy.maxThrowsPerGame ?? Infinity)) return false;
            return true;
          });
        },
        getGame: (gameId: Hex32) => client.getGame(gameId),
        getSimInput: (gameId: Hex32) => client.getSimInput(gameId),
        getBalances: (user: Hex32) => client.getBalances(user),
        placeThrow: (args: unknown) => client.placeThrow(args),
      };

      const result = await runAgentOnce(filteredClient, wasm, effectivePolicy, effectiveLoopCfg);

      if (result.gameId) recentGameTouches.set(result.gameId, now);

      if (result.winnerSubmitted && result.decisionId && result.gameId) {
        totalLiveThrows += 1;
        lastLiveThrowAt = now;
        sessionThrowCounts.set(result.gameId, (sessionThrowCounts.get(result.gameId) ?? 0) + 1);
        pendingSubmitted.push({
          decisionId: result.decisionId,
          gameId: result.gameId,
          submittedAt: now,
          expected: payloadToExpectedSummary(result.winnerPayload),
        });

        const shot = payloadToRecentShot(result.winnerPayload);
        if (shot) {
          recentShots.push(shot);
          while (recentShots.length > 20) recentShots.shift();
        }

        updateControlState({ lastMessage: `Submitted throw into ${result.gameId.slice(0, 10)}...` });
      } else {
        const diag = result.diagnostics;
        const reason = result.stoppedBy === "empty_no_eligible_candidates"
          ? `No throw placed: no eligible candidates after filters (${diag?.eligibleCandidates ?? 0}/${diag?.generatedCandidates ?? 0}).`
          : `No throw placed: ${result.stoppedBy ?? "unknown"}`;
        updateControlState({ lastMessage: reason });
      }

      console.log(
        `[session] cycle=${cycle + 1} submitted=${result.winnerSubmitted ? "yes" : "no"} pendingResults=${pendingSubmitted.length} totalLiveThrows=${totalLiveThrows}`,
      );
    } catch (err) {
      console.error("[session] cycle error, continuing:", err);
      updateControlState({ lastMessage: `[session] error: ${String(err)}` });
    }

    try {
      const rt = getRuntimeSettings();
      await sleep(Number(rt.pollMs ?? sessionCfg.pollMs));
    } catch {
      await sleep(sessionCfg.pollMs);
    }
  }
}
