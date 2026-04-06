import { setTimeout as sleep } from "node:timers/promises";
import type { AgentPolicy } from "../policy/schema.js";
import type { GameListItem, Hex32 } from "../collider/types.js";
import type { WasmVizRuntime } from "../sim/wasm.js";
import type { StoragePaths } from "../core/storage.js";
import { appendResultLog, appendRunLog } from "../core/storage.js";
import { getRuntimeSettings, getControlState, updateControlState } from "../core/runtime-state.js";
import { getManagerCandidateSet, getManagerOverlay, setLatestCandidateContext, setLatestEligibilitySnapshot } from "../core/manager-state.js";
import { buildEligibilityCompactCode, evaluateGamesForEligibility, type LatestEligibilitySnapshot, type SessionEligibilityContext } from "./eligibility.js";
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

function hasPreciseSettledOutcome(matched: {
  matched?: boolean;
  throwMatch?: {
    hole_type?: number;
    endFrame?: number;
  };
  wholeGame?: {
    hole_type_counts?: Record<string, number>;
  };
} | null | undefined): boolean {
  if (!matched?.matched) return false;
  if (!Number.isFinite(matched.throwMatch?.hole_type)) return false;
  if (!Number.isFinite(matched.throwMatch?.endFrame)) return false;
  const holeTypeCounts = matched.wholeGame?.hole_type_counts;
  return !!holeTypeCounts && Object.keys(holeTypeCounts).length > 0;
}

function parseOptionalNumber(v: unknown): number | undefined {
  if (v == null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function parseStringArray(v: unknown): string[] | undefined {
  if (Array.isArray(v)) {
    const out = v.map((x) => String(x).trim()).filter(Boolean);
    return out.length ? out : undefined;
  }
  if (typeof v === "string") {
    const out = v.split(",").map((x) => x.trim()).filter(Boolean);
    return out.length ? out : undefined;
  }
  return undefined;
}

function parseBool(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;
  const s = String(v ?? "").trim().toLowerCase();
  if (!s) return undefined;
  if (["true", "1", "yes", "on"].includes(s)) return true;
  if (["false", "0", "no", "off"].includes(s)) return false;
  return undefined;
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

  if (![x, y, angleRad, vx, vy, angVel].every(Number.isFinite)) {
    return null;
  }

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

function buildSessionEligibilityContext(
  now: number,
  cooldownMsPerGame: number,
  recentGameTouches: Map<string, number>,
  sessionThrowCounts: Map<string, number>,
  maxThrowsPerGame: number | undefined,
): SessionEligibilityContext {
  return {
    now,
    cooldownMsPerGame,
    recentGameTouches: Object.fromEntries(recentGameTouches.entries()),
    sessionThrowCounts: Object.fromEntries(sessionThrowCounts.entries()),
    maxThrowsPerGame,
  };
}

async function publishSessionGate(params: {
  ts: string;
  reason: "cooldown" | "session_cap" | "target_profit";
  stoppedBy: string;
  policy: AgentPolicy;
  loopCfg: LoopConfig;
  prefetchedGames: GameListItem[];
  sessionEligibility: SessionEligibilityContext;
  notes?: string[];
}): Promise<string> {
  const { ts, reason, stoppedBy, policy, loopCfg, prefetchedGames, sessionEligibility, notes = [] } = params;
  const { entries: perGame, selectedGame } = evaluateGamesForEligibility(prefetchedGames, policy, sessionEligibility);

  const snapshot: LatestEligibilitySnapshot = {
    ts,
    globalReasons: [reason],
    selectedGameId: selectedGame?.game_id ?? null,
    perGame,
    assetPlanning: [],
    candidateFilterSummary: {
      reasonCounts: {},
      totalRawCandidates: 0,
      totalEligibleCandidates: 0,
      limitedCandidates: 0,
      plannedCandidates: 0,
    },
    notes,
  };

  const eligibilityCode = buildEligibilityCompactCode(snapshot);
  setLatestEligibilitySnapshot(snapshot);
  setLatestCandidateContext({
    ts,
    gameId: selectedGame?.game_id ?? null,
    stoppedBy,
    winnerCandidateHash: null,
    overlay: getManagerOverlay(),
    managerCandidateSet: getManagerCandidateSet(),
    candidates: [],
  });

  if (loopCfg.storage) {
    await appendRunLog(loopCfg.storage as StoragePaths, {
      ts,
      sessionId: loopCfg.sessionId,
      mode: loopCfg.dryRun ? "dry-run" : "live",
      gameId: selectedGame?.game_id ?? null,
      botUser: loopCfg.botUser,
      submitted: false,
      stoppedBy,
      eligibilityCode,
      game: selectedGame
        ? {
            throws: selectedGame.throws,
            stake: selectedGame.stake,
            minThrowValue: selectedGame.throw_min_value,
            status: selectedGame.status,
          }
        : undefined,
      eligibility: {
        globalReasons: snapshot.globalReasons,
        perGame,
        assetPlanning: [],
      },
      search: {
        generatedCandidates: 0,
        eligibleCandidates: 0,
        limitedCandidates: 0,
        plannedCandidates: 0,
        examinedCount: 0,
        maxCandidates: loopCfg.candidateBudget?.maxCandidates,
        maxMillis: loopCfg.candidateBudget?.maxMillis,
        includeSlip1: loopCfg.includeSlip1,
        candidateFilterSummary: snapshot.candidateFilterSummary,
      },
      top: [],
    });
  }

  return eligibilityCode;
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
  let cumulativeRealizedProfit = 0;

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
        minGameStakeUsd: parseOptionalNumber(rt.minGameStakeUsd),
        maxSingleThrowUsd: parseOptionalNumber(rt.maxSingleThrowUsd),
        maxGameExposureUsd: parseOptionalNumber(rt.maxGameExposureUsd),
        minThrowUsd: parseOptionalNumber(rt.minThrowUsd),
        maxThrowUsd: parseOptionalNumber(rt.maxThrowUsd),
        riskMode: String(rt.riskMode || basePolicy.riskMode || "balanced") as AgentPolicy["riskMode"],
        copySlammerWhenSameHoleType: parseBool(rt.copySlammerWhenSameHoleType),
        allowedAssets: parseStringArray(rt.allowedAssets),
        blockedAssets: parseStringArray(rt.blockedAssets),
        keepAssets: parseStringArray(rt.keepAssets),
        disposeAssets: parseStringArray(rt.disposeAssets),
        reserveBalanceBase: rt.reserveBalanceBase != null ? String(rt.reserveBalanceBase) : undefined,
        targetBalanceUsd: parseOptionalNumber(rt.targetBalanceUsd),
        targetProfitUsd: parseOptionalNumber(rt.targetProfitUsd),
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
          const report = await client.getGameReport(p.gameId);
          const matched = matchReportToSubmittedThrow(report, effectiveLoopCfg.botUser, p.expected);

          if (!hasPreciseSettledOutcome(matched)) {
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

          const realizedPnl = Number((matched as any)?.wholeGame?.pnl_usd ?? 0);
          if (Number.isFinite(realizedPnl)) {
            cumulativeRealizedProfit += realizedPnl;
          }

          pendingSubmitted.splice(i, 1);
        } catch {
          // report not ready yet
        }
      }

      const prefetchedGames = await client.listGames(effectiveLoopCfg.gameStatusMask);
      const sessionEligibility = buildSessionEligibilityContext(
        now,
        cooldownMsPerGame,
        recentGameTouches,
        sessionThrowCounts,
        effectivePolicy.maxThrowsPerGame,
      );
      const gateTs = new Date().toISOString();

      if (!effectiveLoopCfg.dryRun) {
        if (
          effectivePolicy.targetProfitUsd != null &&
          cumulativeRealizedProfit >= effectivePolicy.targetProfitUsd
        ) {
          updateControlState({
            state: "paused",
            mode: ctl.mode || "regular",
            lastMessage: `Paused after reaching targetProfitUsd=${effectivePolicy.targetProfitUsd}.`,
            lastAction: { action: "auto_pause_target_profit", ts: gateTs, throwsTarget: null, exclusive: false },
          });
          await publishSessionGate({
            ts: gateTs,
            reason: "target_profit",
            stoppedBy: "target_profit",
            policy: effectivePolicy,
            loopCfg: effectiveLoopCfg,
            prefetchedGames,
            sessionEligibility,
            notes: [`cumulativeRealizedProfit=${cumulativeRealizedProfit.toFixed(6)}`],
          });
          console.log("[session] targetProfitUsd reached, pausing");
          await sleep(Number(rt.pollMs ?? sessionCfg.pollMs));
          continue;
        }

        if (totalLiveThrows >= (effectivePolicy.maxThrowsPerSession ?? Infinity)) {
          updateControlState({
            state: "paused",
            mode: ctl.mode || "regular",
            lastMessage: `Paused after reaching maxThrowsPerSession=${effectivePolicy.maxThrowsPerSession}.`,
            lastAction: { action: "auto_pause_max_throws", ts: gateTs, throwsTarget: effectivePolicy.maxThrowsPerSession ?? null, exclusive: false },
          });
          await publishSessionGate({
            ts: gateTs,
            reason: "session_cap",
            stoppedBy: "max_throws_per_session",
            policy: effectivePolicy,
            loopCfg: effectiveLoopCfg,
            prefetchedGames,
            sessionEligibility,
            notes: [`totalLiveThrows=${totalLiveThrows}`],
          });
          console.log("[session] maxThrowsPerSession reached, pausing");
          await sleep(Number(rt.pollMs ?? sessionCfg.pollMs));
          continue;
        }

        if (now - lastLiveThrowAt < (effectivePolicy.minMillisBetweenLiveThrows ?? 0)) {
          const remainingMs = (effectivePolicy.minMillisBetweenLiveThrows ?? 0) - (now - lastLiveThrowAt);
          await publishSessionGate({
            ts: gateTs,
            reason: "cooldown",
            stoppedBy: "cooldown",
            policy: effectivePolicy,
            loopCfg: effectiveLoopCfg,
            prefetchedGames,
            sessionEligibility,
            notes: [`remainingCooldownMs=${Math.max(0, remainingMs)}`],
          });
          await sleep(Number(rt.pollMs ?? sessionCfg.pollMs));
          continue;
        }
      }

      const result = await runAgentOnce(
        client,
        wasm,
        effectivePolicy,
        {
          ...effectiveLoopCfg,
          prefetchedGames,
          sessionEligibility,
        },
      );

      if (result.gameId) {
        recentGameTouches.set(result.gameId, now);
      }

      if (result.winnerSubmitted && result.decisionId && result.gameId) {
        totalLiveThrows += 1;
        lastLiveThrowAt = now;

        sessionThrowCounts.set(
          result.gameId,
          (sessionThrowCounts.get(result.gameId) ?? 0) + 1,
        );

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

        updateControlState({
          lastMessage: `Submitted throw into ${result.gameId.slice(0, 10)}...`,
        });
      } else {
        updateControlState({
          lastMessage: `No throw placed: ${result.eligibilityCode ?? result.stoppedBy ?? "unknown"}`,
        });
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

