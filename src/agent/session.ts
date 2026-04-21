import { readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { AgentPolicy } from "../policy/schema.js";
import type { GameListItem, Hex32 } from "../collider/types.js";
import type { WasmVizRuntime } from "../sim/wasm.js";
import type { ArtifactLogRef, HonestScoreLogView, StoragePaths } from "../core/storage.js";
import { appendResultLog, appendRunLog, writeArtifactJson } from "../core/storage.js";
import { getRuntimeSettings, getControlState, updateControlState } from "../core/runtime-state.js";
import { resolveAgentProfile } from "../core/agent-profile.js";
import { getManagerCandidateSet, getManagerOverlay, setLatestCandidateContext, setLatestEligibilitySnapshot } from "../core/manager-state.js";
import { buildEligibilityCompactCode, evaluateGamesForEligibility, type LatestEligibilitySnapshot, type SessionEligibilityContext } from "./eligibility.js";
import { matchReportToSubmittedThrow, type ExpectedThrowSummary } from "./report-match.js";
import { buildPredictionRevealBundle, type PredictionHistoryEntry } from "./honest-score.js";
import type { PredictionCommitPayload } from "./prediction-artifact.js";
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
  predictionCommitPayload?: PredictionCommitPayload;
  predictionCommitRef?: ArtifactLogRef;
};


type RecentShot = {
  x: number;
  y: number;
  angleDeg: number;
  speedPct: number;
  spinPct: number;
};

function cleanHex(value: unknown): string {
  return String(value ?? "").toLowerCase().replace(/^0x/, "");
}

function parseJsonLines(text: string): any[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((row) => row && typeof row === "object");
}

async function loadPredictionHistoryForGame(params: {
  storage: StoragePaths;
  gameId: string;
  botUser: string;
}): Promise<PredictionHistoryEntry[]> {
  const { storage, gameId, botUser } = params;
  const targetGameId = cleanHex(gameId);
  const targetBotUser = cleanHex(botUser);
  const resolvedByDecision = new Map<string, { resolvedActualThrowId: string | null; ts: string | null }>();

  try {
    const resultText = await readFile(storage.resultsFile, "utf8");
    for (const row of parseJsonLines(resultText)) {
      if (cleanHex(row?.gameId) !== targetGameId) continue;
      if (cleanHex(row?.botUser) !== targetBotUser) continue;
      const decisionKey = cleanHex(row?.decisionId);
      if (!decisionKey) continue;
      const rowTs = new Date(row?.ts || 0).getTime();
      const prev = resolvedByDecision.get(decisionKey);
      const prevTs = new Date(prev?.ts || 0).getTime();
      if (!prev || rowTs >= prevTs) {
        resolvedByDecision.set(decisionKey, {
          resolvedActualThrowId: cleanHex(row?.actual?.throwMatch?.throw_id) || null,
          ts: row?.ts ?? null,
        });
      }
    }
  } catch {
    // no prior settled rows yet
  }

  const throwRowsByDecision = new Map<string, any>();
  try {
    const throwText = await readFile(storage.throwsFile, "utf8");
    for (const row of parseJsonLines(throwText)) {
      if (cleanHex(row?.gameId) !== targetGameId) continue;
      if (cleanHex(row?.botUser) !== targetBotUser) continue;
      if (row?.submitted === false) continue;
      if (!row?.predictionCommit) continue;
      const decisionKey = cleanHex(row?.decisionId);
      if (!decisionKey) continue;
      const rowTs = new Date(row?.ts || 0).getTime();
      const prev = throwRowsByDecision.get(decisionKey);
      const prevTs = new Date(prev?.ts || 0).getTime();
      if (!prev || rowTs >= prevTs) throwRowsByDecision.set(decisionKey, row);
    }
  } catch {
    return [];
  }

  const history: PredictionHistoryEntry[] = [];
  const orderedRows = [...throwRowsByDecision.values()].sort(
    (a, b) => new Date(a?.ts || 0).getTime() - new Date(b?.ts || 0).getTime(),
  );

  for (const row of orderedRows) {
    const commitRef = row.predictionCommit as ArtifactLogRef | null;
    if (!commitRef) continue;
    const localPath = commitRef.localPath || (commitRef.cid ? path.join(storage.predictionCommitsDir, `${commitRef.cid}.json`) : "");
    if (!localPath) continue;
    try {
      const commitText = await readFile(localPath, "utf8");
      const commit = JSON.parse(commitText) as PredictionCommitPayload;
      if (!commit || commit.schema !== "collider.prediction.commit.v1") continue;
      const resolution = resolvedByDecision.get(cleanHex(row?.decisionId));
      history.push({
        commit,
        commitRef: {
          ...commitRef,
          localPath,
        },
        decisionId: row?.decisionId ?? commit.decisionId ?? null,
        resolvedActualThrowId: resolution?.resolvedActualThrowId ?? null,
        ts: row?.ts ?? null,
      });
    } catch {
      // skip unreadable or stale commit artifacts
    }
  }

  return history;
}

async function loadPredictionCommitPayload(
  storage: StoragePaths,
  commitRef: ArtifactLogRef | null | undefined,
): Promise<PredictionCommitPayload | undefined> {
  if (!commitRef) return undefined;
  const localPath = commitRef.localPath || (commitRef.cid ? path.join(storage.predictionCommitsDir, `${commitRef.cid}.json`) : "");
  if (!localPath) return undefined;
  try {
    const commitText = await readFile(localPath, "utf8");
    const commit = JSON.parse(commitText) as PredictionCommitPayload;
    return commit && commit.schema === "collider.prediction.commit.v1" ? commit : undefined;
  } catch {
    return undefined;
  }
}

async function loadPendingSubmittedDecisions(params: {
  storage: StoragePaths;
  botUser: string;
}): Promise<SubmittedDecision[]> {
  const { storage, botUser } = params;
  const targetBotUser = cleanHex(botUser);
  const resolvedByDecision = new Set<string>();

  try {
    const resultText = await readFile(storage.resultsFile, "utf8");
    for (const row of parseJsonLines(resultText)) {
      if (cleanHex(row?.botUser) !== targetBotUser) continue;
      const decisionKey = cleanHex(row?.decisionId);
      if (!decisionKey) continue;
      resolvedByDecision.add(decisionKey);
    }
  } catch {
    // no settled rows yet
  }

  const latestSubmittedByDecision = new Map<string, any>();
  try {
    const throwText = await readFile(storage.throwsFile, "utf8");
    for (const row of parseJsonLines(throwText)) {
      if (cleanHex(row?.botUser) !== targetBotUser) continue;
      if (row?.submitted === false) continue;
      const decisionKey = cleanHex(row?.decisionId);
      if (!decisionKey || !row?.gameId) continue;
      const rowTs = new Date(row?.ts || 0).getTime();
      const prev = latestSubmittedByDecision.get(decisionKey);
      const prevTs = new Date(prev?.ts || 0).getTime();
      if (!prev || rowTs >= prevTs) latestSubmittedByDecision.set(decisionKey, row);
    }
  } catch {
    return [];
  }

  const out: SubmittedDecision[] = [];
  const orderedRows = [...latestSubmittedByDecision.values()]
    .filter((row) => !resolvedByDecision.has(cleanHex(row?.decisionId)))
    .sort((a, b) => new Date(a?.ts || 0).getTime() - new Date(b?.ts || 0).getTime());

  for (const row of orderedRows) {
    const predictionCommitRef = row?.predictionCommit as ArtifactLogRef | undefined;
    out.push({
      decisionId: String(row.decisionId),
      gameId: String(row.gameId) as Hex32,
      submittedAt: new Date(row?.ts || 0).getTime() || 0,
      expected: payloadToExpectedSummary(row?.payload),
      predictionCommitPayload: predictionCommitRef
        ? await loadPredictionCommitPayload(storage, predictionCommitRef)
        : undefined,
      predictionCommitRef: predictionCommitRef ?? undefined,
    });
  }

  return out;
}

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
  if (baseLoopCfg.storage) {
    const recoveredPending = await loadPendingSubmittedDecisions({
      storage: baseLoopCfg.storage,
      botUser: baseLoopCfg.botUser,
    });
    pendingSubmitted.push(...recoveredPending);
    if (recoveredPending.length) {
      console.log(`[session] recovered ${recoveredPending.length} unresolved submitted decisions from storage`);
    }
  }
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

      const baselineResetActive = String(ctl.mode || "").startsWith("baseline-reset-")
        && (ctl.throwsTarget == null || ctl.throwsTarget > 0);
      const baselineProfile = baselineResetActive
        ? resolveAgentProfile({
            ...rt,
            doctrinePack: "baseline",
            riskMode: "balanced",
            customStrategy: null,
            copySlammerWhenSameHoleType: false,
          })
        : null;
      const profile = baselineProfile ?? resolveAgentProfile(rt);
      const customStrategy = String(profile.effective.customStrategy || "").trim();
      const copySlammersEnabled = profile.effective.copySlammerWhenSameHoleType;

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
        riskMode: profile.effective.riskMode ?? String(rt.riskMode || basePolicy.riskMode || "balanced") as AgentPolicy["riskMode"],
        customStrategy: customStrategy || undefined,
        copySlammerWhenSameHoleType: copySlammersEnabled,
        allowedAssets: parseStringArray(rt.allowedAssets),
        blockedAssets: parseStringArray(rt.blockedAssets),
        keepAssets: parseStringArray(rt.keepAssets),
        disposeAssets: parseStringArray(rt.disposeAssets),
        reserveBalanceBase: rt.reserveBalanceBase != null ? String(rt.reserveBalanceBase) : undefined,
        targetBalanceUsd: parseOptionalNumber(rt.targetBalanceUsd),
        targetProfitUsd: parseOptionalNumber(rt.targetProfitUsd),
      };

      if (baselineResetActive) {
        const baselineMinUsd = effectivePolicy.minThrowUsd ?? parseOptionalNumber(basePolicy.minThrowUsd);
        effectivePolicy.riskMode = "balanced";
        effectivePolicy.customStrategy = undefined;
        effectivePolicy.copySlammerWhenSameHoleType = false;
        if (baselineMinUsd != null) {
          effectivePolicy.minThrowUsd = baselineMinUsd;
          effectivePolicy.maxThrowUsd = baselineMinUsd;
          effectivePolicy.maxSingleThrowUsd = baselineMinUsd;
        }
      }

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
        preferredGameId: ctl.targetGameId || undefined,
        selectionMode: baselineResetActive ? "random" : "best",
        agentProfile: profile,
      };

      for (let i = pendingSubmitted.length - 1; i >= 0; i--) {
        const p = pendingSubmitted[i];

        try {
          const report = await client.getGameReport(p.gameId);
          const matched = matchReportToSubmittedThrow(report, effectiveLoopCfg.botUser, p.expected);

          if (!hasPreciseSettledOutcome(matched)) {
            continue;
          }

          const resultTs = new Date().toISOString();
          let predictionReveal: ArtifactLogRef | undefined;
          let honestScore: HonestScoreLogView | undefined;

          if (p.predictionCommitPayload && p.predictionCommitRef) {
            try {
              const settledInput = await client.getSimInput(p.gameId);
              const predictionHistory = effectiveLoopCfg.storage
                ? await loadPredictionHistoryForGame({
                    storage: effectiveLoopCfg.storage,
                    gameId: p.gameId,
                    botUser: effectiveLoopCfg.botUser,
                  })
                : [];
              const revealBundle = buildPredictionRevealBundle({
                createdAt: resultTs,
                sessionId: effectiveLoopCfg.sessionId,
                decisionId: p.decisionId,
                botUser: effectiveLoopCfg.botUser,
                commit: p.predictionCommitPayload,
                commitRef: p.predictionCommitRef,
                report,
                settledInput,
                matchedThrowId: matched.throwMatch?.throw_id ?? null,
                history: predictionHistory,
              });
              honestScore = revealBundle.honestScore;

              if (effectiveLoopCfg.storage) {
                predictionReveal = await writeArtifactJson({
                  dir: effectiveLoopCfg.storage.predictionRevealsDir,
                  schema: revealBundle.payload.schema,
                  payload: revealBundle.payload,
                });
              }
            } catch (revealErr) {
              console.error("[session] honest-score reveal error:", revealErr);
            }
          }

          if (effectiveLoopCfg.storage) {
            await appendResultLog(effectiveLoopCfg.storage as StoragePaths, {
              ts: resultTs,
              sessionId: effectiveLoopCfg.sessionId,
              decisionId: p.decisionId,
              gameId: p.gameId,
              botUser: effectiveLoopCfg.botUser,
              actual: matched,
              expected: p.expected ?? {},
              predictionCommit: p.predictionCommitRef,
              predictionReveal,
              honestScore,
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
          predictionCommitPayload: result.predictionCommitPayload ?? undefined,
          predictionCommitRef: result.predictionCommit ?? undefined,
        });

        const shot = payloadToRecentShot(result.winnerPayload);
        if (shot) {
          recentShots.push(shot);
          while (recentShots.length > 20) recentShots.shift();
        }

        if (baselineResetActive && ctl.throwsTarget != null) {
          const remainingBaselineThrows = Math.max(0, ctl.throwsTarget - 1);
          if (remainingBaselineThrows === 0) {
            updateControlState({
              mode: "regular",
              throwsTarget: null,
              exclusive: false,
              lastMessage: "Baseline reset complete. Raw HPS stays canonical; local baseline lift now references the new reset window.",
            });
          } else {
            updateControlState({
              throwsTarget: remainingBaselineThrows,
              lastMessage: `Baseline reset in progress (${remainingBaselineThrows} throws remaining).`,
            });
          }
        }

        if (ctl.targetGameId && result.gameId === ctl.targetGameId) {
          updateControlState({
            targetGameId: null,
            lastMessage: `Submitted priority throw into ${result.gameId.slice(0, 10)}...`,
          });
        } else if (!baselineResetActive) {
          updateControlState({
            lastMessage: `Submitted throw into ${result.gameId.slice(0, 10)}...`,
          });
        }
      } else {
        updateControlState({
          lastMessage: ctl.targetGameId
            ? `No throw placed: ${result.eligibilityCode ?? result.stoppedBy ?? "unknown"} (priority ${ctl.targetGameId.slice(0, 10)}...)`
            : `No throw placed: ${result.eligibilityCode ?? result.stoppedBy ?? "unknown"}`,
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







