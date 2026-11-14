import { readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { AgentPolicy } from "../policy/schema.js";
import { normalizeMapPriorities } from "../core/map-priority.js";
import type { GameListItem, Hex32 } from "../collider/types.js";
import type { WasmVizRuntime } from "../sim/wasm.js";
import type { ArtifactLogRef, HonestScoreLogView, StoragePaths } from "../core/storage.js";
import { appendResultLog, appendRunLog, gameHistoryFile, writeArtifactJson } from "../core/storage.js";
import { readPendingDecisions } from "../core/pending-decisions.js";
import { readJsonlTail } from "../core/jsonl.js";
import {SubmissionGateClosed,runtimeSnapshotMatches,submissionStillAllowed} from "./submission-gate.js";
import { getRuntimeSettings, getControlState, updateControlState } from "../core/runtime-state.js";
import { resolveAgentProfile } from "../core/agent-profile.js";
import { getManagerCandidateSet, getManagerOverlay, setLatestCandidateContext, setLatestEligibilitySnapshot } from "../core/manager-state.js";
import { buildEligibilityCompactCode, evaluateGamesForEligibility, type LatestEligibilitySnapshot, type SessionEligibilityContext } from "./eligibility.js";
import { matchReportToSubmittedThrow, type ExpectedThrowSummary } from "./report-match.js";
import { buildPredictionRevealBundle, type PredictionHistoryEntry } from "./honest-score.js";
import type { PredictionCommitPayload } from "./prediction-artifact.js";
import { filterGamesByAllowlist, runAgentOnce, type ColliderClientLike, type LoopConfig } from "./loop.js";
import { recordReconciledAcceptedThrow } from "./signed-intent-recovery.js";

export type ColliderClientSessionLike = ColliderClientLike & {
  getGameReport(gameId: Hex32): Promise<unknown>;
  reconcilePendingSignedIntent?(timeoutMs?: number): Promise<import("../collider/client.js").ReconciledStoredThrow | null>;
};

export type SessionConfig = {
  accelerated?: {startIntervalMs:number;maxThrows:number;stopAtMs:number};
  pollMs: number;
  maxCycles?: number;
  cooldownMsPerGame?: number;
  stopWhenSessionCapReached?: boolean;
  maybeAutoConvert?: () => Promise<void>;
  serviceBondedConfirmations?: () => Promise<boolean>;
  reconciliationOnly?: boolean;
  canReconcile?: () => Promise<boolean>;
  signal?: AbortSignal;
  stopAtMs?: number;
};

export function sessionCapExitAction(
  enabled: boolean,
  capReached: boolean,
  pendingResults: number,
): "normal" | "drain" | "exit" {
  if (!enabled || !capReached) return "normal";
  return pendingResults > 0 ? "drain" : "exit";
}

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

export async function loadPredictionHistoryForGame(params: {
  storage: StoragePaths;
  gameId: string;
  botUser: string;
  report?: unknown;
}): Promise<PredictionHistoryEntry[]> {
  const { storage, gameId, botUser } = params;
  const targetGameId = cleanHex(gameId);
  const targetBotUser = cleanHex(botUser);
  const reportHex = (value: unknown) => Array.isArray(value) ? Buffer.from(value).toString("hex") : cleanHex(value);
  const report = params.report as Record<string, any> | undefined;
  const canonicalHistory = !!report && reportHex(report.game_id) === targetGameId && Array.isArray(report.throws_raw);
  const canonicalIds = new Map<string, Set<string>>();
  if (canonicalHistory) for (const row of report!.throws_raw) {
    if (reportHex(row.user) !== targetBotUser) continue;
    const hash = reportHex(row.data_commit), id = reportHex(row.id ?? row.throw_id);
    if (!/^[a-f0-9]{64}$/.test(hash) || !/^[a-f0-9]{64}$/.test(id)) continue;
    const ids = canonicalIds.get(hash) ?? new Set<string>(); ids.add(id); canonicalIds.set(hash, ids);
  }
  const resolvedByDecision = new Map<string, { resolvedActualThrowId: string | null; ts: string | null }>();
  const indexedThrows = await readJsonlTail<any>(gameHistoryFile(storage, "throws", gameId), 256);
  const useGameIndex = indexedThrows.fileBytes > 0;

  try {
    const resultTail = await readJsonlTail<any>(
      useGameIndex ? gameHistoryFile(storage, "results", gameId) : storage.resultsFile,
      useGameIndex ? 256 : 10_000,
    );
    for (const row of resultTail.rows) {
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
    const throwTail = useGameIndex ? indexedThrows : await readJsonlTail<any>(storage.throwsFile, 10_000);
    for (const row of throwTail.rows) {
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
      const ids = canonicalIds.get(cleanHex(commitRef.sha256Hex));
      history.push({
        commit,
        commitRef: {
          ...commitRef,
          localPath,
        },
        decisionId: row?.decisionId ?? commit.decisionId ?? null,
        resolvedActualThrowId: canonicalHistory ? (ids?.size === 1 ? [...ids][0] : null) : resolution?.resolvedActualThrowId ?? null,
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
  const rows = await readPendingDecisions(storage, botUser);
  const out: SubmittedDecision[] = [];

  for (const row of rows) {
    const predictionCommitRef = row.predictionCommit;
    out.push({
      decisionId: row.decisionId,
      gameId: row.gameId as Hex32,
      submittedAt: new Date(row.ts || 0).getTime() || 0,
      expected: { ...payloadToExpectedSummary(row.payload), throwId: row.throwId },
      predictionCommitPayload: predictionCommitRef
        ? await loadPredictionCommitPayload(storage, predictionCommitRef)
        : undefined,
      predictionCommitRef,
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

function resolveUnifiedMaxThrowUsd(...values: Array<unknown>): number | undefined {
  const normalized = values
    .map((value) => parseOptionalNumber(value))
    .filter((value): value is number => value != null);
  if (!normalized.length) return undefined;
  return Math.min(...normalized);
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
    for (const pending of recoveredPending) {
      sessionThrowCounts.set(pending.gameId, (sessionThrowCounts.get(pending.gameId) ?? 0) + 1);
    }
    if (recoveredPending.length) {
      console.log(`[session] recovered ${recoveredPending.length} unresolved submitted decisions from storage`);
    }
  }
  const recentShots: RecentShot[] = [];

  let totalLiveThrows = 0;
  let lastLiveThrowAt = 0;
  let lastAcceleratedStart=0;
  let cumulativeRealizedProfit = 0;
  let sessionCapReached = false;
  let reconciliationCursor = 0;

  for (let cycle = 0; cycle < maxCycles; cycle++) {
    const now = Date.now();

    try {
      if (sessionCfg.reconciliationOnly && sessionCfg.signal?.aborted) return;
      if (sessionCfg.reconciliationOnly && !(await sessionCfg.canReconcile?.())) {
        await sleep(sessionCfg.pollMs);
        continue;
      }
      const rt = getRuntimeSettings();
      const deadlineReached = sessionCfg.stopAtMs !== undefined && Date.now() >= sessionCfg.stopAtMs;
      if (deadlineReached) {
        updateControlState({state:"paused",lastMessage:"Timed play window complete; settled-result publication remains enabled.",lastAction:{action:"auto_pause_time_limit",ts:new Date().toISOString()}});
        if (!pendingSubmitted.length) { await sleep(sessionCfg.pollMs); continue; }
      }
      const ctl = getControlState();

      if (!deadlineReached && !sessionCfg.reconciliationOnly && !baseLoopCfg.dryRun && client.reconcilePendingSignedIntent) {
        const recovered = await client.reconcilePendingSignedIntent(0);
        if (recovered?.result.status === "pending") {
          updateControlState({
            lastMessage: `RC1 signed intent nonce ${recovered.result.nonce} is awaiting canonical reconciliation.`,
          });
          await sleep(Number(rt.pollMs ?? sessionCfg.pollMs));
          continue;
        }
        if (recovered) {
          const recorded = baseLoopCfg.storage
            ? await recordReconciledAcceptedThrow(baseLoopCfg.storage, recovered, baseLoopCfg.sessionId)
            : null;
          if (recorded) {
            pendingSubmitted.push({
              decisionId: recorded.decisionId,
              gameId: recorded.gameId as Hex32,
              submittedAt: recorded.submittedAt,
              expected: { ...payloadToExpectedSummary(recorded.expected), throwId: recovered.result.throwId ?? undefined },
              predictionCommitPayload: recorded.predictionCommitRef
                ? await loadPredictionCommitPayload(baseLoopCfg.storage!, recorded.predictionCommitRef)
                : undefined,
              predictionCommitRef: recorded.predictionCommitRef,
            });
          }
          console.log(`[rc1] reconciled signed intent nonce=${recovered.result.nonce} status=${recovered.result.status}`);
        }
      }

      // Existing principal obligations continue even while speculative throws are paused.
      if (!deadlineReached && !sessionCfg.reconciliationOnly && !baseLoopCfg.dryRun && sessionCfg.serviceBondedConfirmations) {
        try {
          if (await sessionCfg.serviceBondedConfirmations()) {
            await sleep(Math.min(1000, Number(rt.pollMs ?? sessionCfg.pollMs)));
            continue;
          }
        } catch {
          updateControlState({ state: "paused", lastMessage: "Bonded confirmation requires canonical reconciliation." });
          await sleep(Math.min(1000, Number(rt.pollMs ?? sessionCfg.pollMs)));
          continue;
        }
      }

      const pausedCapAction = sessionCapExitAction(
        !!sessionCfg.stopWhenSessionCapReached,
        sessionCapReached,
        pendingSubmitted.length,
      );
      if (ctl.state === "paused" && pausedCapAction === "exit") {
        console.log("[session] session cap reached and pending results drained, stopping");
        return;
      }
      // Pauses stop new throws, not read-only settlement feedback.

      if (!sessionCfg.reconciliationOnly && !baseLoopCfg.dryRun && ctl.state === "live" && sessionCfg.maybeAutoConvert) {
        try {
          await sessionCfg.maybeAutoConvert();
        } catch (error) {
          updateControlState({
            state: "paused",
            lastMessage: `Automatic points conversion paused safely: ${String(error)}`,
          });
          console.error("[session] automatic points conversion paused play:", error);
          await sleep(Number(rt.pollMs ?? sessionCfg.pollMs));
          continue;
        }
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
      const humanLearning = rt.humanLearning && typeof rt.humanLearning === "object"
        ? rt.humanLearning as Record<string, unknown>
        : {};
      const unifiedMaxThrowUsd = resolveUnifiedMaxThrowUsd(rt.maxThrowUsd, rt.maxSingleThrowUsd);

      const effectivePolicy: AgentPolicy = {
        ...basePolicy,
        maxThrowsPerGame: Number(rt.maxThrowsPerGame ?? basePolicy.maxThrowsPerGame ?? 3),
        maxThrowsPerSession: Number(rt.maxThrowsPerSession ?? basePolicy.maxThrowsPerSession ?? 50),
        minMillisBetweenLiveThrows: Number(
          rt.minMillisBetweenLiveThrows ?? basePolicy.minMillisBetweenLiveThrows ?? 20_000,
        ),
        minGameStakeUsd: parseOptionalNumber(rt.minGameStakeUsd),
        maxSingleThrowUsd: unifiedMaxThrowUsd,
        maxGameExposureUsd: parseOptionalNumber(rt.maxGameExposureUsd),
        maxSingleThrowBase: String(rt.maxSingleThrowBase ?? basePolicy.maxSingleThrowBase ?? "0"),
        minThrowUsd: parseOptionalNumber(rt.minThrowUsd),
        maxThrowUsd: unifiedMaxThrowUsd,
        riskMode: profile.effective.riskMode ?? String(rt.riskMode || basePolicy.riskMode || "balanced") as AgentPolicy["riskMode"],
        customStrategy: customStrategy || undefined,
        copySlammerWhenSameHoleType: copySlammersEnabled,
        learnFromManualThrows: humanLearning.enabled == null ? true : !!humanLearning.enabled,
        learnOwnManualThrows: humanLearning.learnOwnManualThrows == null ? true : !!humanLearning.learnOwnManualThrows,
        humanLearningAddresses: parseStringArray(humanLearning.addresses),
        humanLearningMaxSeeds: parseOptionalNumber(humanLearning.maxSeedsPerCycle) ?? undefined,
        allowedAssets: parseStringArray(rt.allowedAssets),
        mapPriorities: normalizeMapPriorities(rt.mapPriorities),
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
        effectivePolicy.learnFromManualThrows = false;
        effectivePolicy.learnOwnManualThrows = false;
        effectivePolicy.humanLearningAddresses = [];
        effectivePolicy.humanLearningMaxSeeds = undefined;
        if (baselineMinUsd != null) {
          effectivePolicy.minThrowUsd = baselineMinUsd;
          effectivePolicy.maxThrowUsd = baselineMinUsd;
          effectivePolicy.maxSingleThrowUsd = baselineMinUsd;
        }
      }

      const effectiveLoopCfg: LoopConfig = {
        ...baseLoopCfg,
        allowedGameIds: parseStringArray(rt.allowedGameIds),
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
        preferredGameId: ctl.targetGameId || baseLoopCfg.preferredGameId || undefined,
        selectionMode: baselineResetActive ? "random" : "best",
        agentProfile: profile,
      };

      let reconcileBatch: Set<string> | null = null;
      if (sessionCfg.reconciliationOnly && baseLoopCfg.storage) {
        const refreshed = await loadPendingSubmittedDecisions({ storage: baseLoopCfg.storage, botUser: baseLoopCfg.botUser });
        pendingSubmitted.splice(0, pendingSubmitted.length, ...refreshed);
        reconcileBatch = new Set<string>();
        for (let n = 0; n < Math.min(2, pendingSubmitted.length); n++) reconcileBatch.add(pendingSubmitted[(reconciliationCursor + n) % pendingSubmitted.length].decisionId);
        reconciliationCursor = pendingSubmitted.length ? (reconciliationCursor + 2) % pendingSubmitted.length : 0;
      }
      const cycleReports=new Map<string,Promise<unknown>>(),cycleInputs=new Map<string,Promise<any>>();
      if(sessionCfg.accelerated&&!deadlineReached&&!sessionCfg.reconciliationOnly){reconcileBatch=new Set<string>();for(let n=0;n<Math.min(4,pendingSubmitted.length);n++)reconcileBatch.add(pendingSubmitted[(reconciliationCursor+n)%pendingSubmitted.length].decisionId);reconciliationCursor=pendingSubmitted.length?(reconciliationCursor+4)%pendingSubmitted.length:0;}
      for (let i = pendingSubmitted.length - 1; i >= 0; i--) {
        const p = pendingSubmitted[i];
        if (reconcileBatch && !reconcileBatch.has(p.decisionId)) continue;

        try {
          if (sessionCfg.reconciliationOnly) {
            if (!(await sessionCfg.canReconcile?.())) break;
            const game = await client.getGame(p.gameId) as any;
            if (game?.status !== 4 || !game.has_result || !(Number(game.settled_height) > 0)) continue;
          }
          let reportRead=cycleReports.get(p.gameId);if(!reportRead){reportRead=client.getGameReport(p.gameId);cycleReports.set(p.gameId,reportRead);}const report=await reportRead;
          const holeRules = client.getHoleRules ? await client.getHoleRules() : undefined;
          const provisionalMatch = matchReportToSubmittedThrow(report, effectiveLoopCfg.botUser, p.expected);

          if (!hasPreciseSettledOutcome(provisionalMatch)) {
            continue;
          }

          let settledInput: Awaited<ReturnType<typeof client.getSimInput>> | undefined;
          try {
            let inputRead=cycleInputs.get(p.gameId);if(!inputRead){inputRead=client.getSimInput(p.gameId);cycleInputs.set(p.gameId,inputRead);}settledInput=await inputRead;
          } catch {
            settledInput = undefined;
          }

          const matched = settledInput
            ? matchReportToSubmittedThrow(report, effectiveLoopCfg.botUser, p.expected, settledInput, holeRules)
            : provisionalMatch;

          const resultTs = new Date().toISOString();
          if (sessionCfg.reconciliationOnly && !(await sessionCfg.canReconcile?.())) break;
          let predictionReveal: ArtifactLogRef | undefined;
          let honestScore: HonestScoreLogView | undefined;

          if (p.predictionCommitPayload && p.predictionCommitRef && settledInput) {
            try {
              const predictionHistory = effectiveLoopCfg.storage
                ? await loadPredictionHistoryForGame({
                    storage: effectiveLoopCfg.storage,
                    gameId: p.gameId,
                    botUser: effectiveLoopCfg.botUser,
                    report,
                  })
                : [];
              const revealBundle = buildPredictionRevealBundle({
                holeRules,
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
            if (sessionCfg.reconciliationOnly && !(await sessionCfg.canReconcile?.())) break;
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

      if (sessionCfg.reconciliationOnly) {
        await sleep(sessionCfg.pollMs);
        continue; // Hard boundary: no game selection, simulation, intent recovery or trading.
      }
      if (!sessionCfg.reconciliationOnly && (getControlState().state === "paused" || (sessionCfg.stopAtMs !== undefined && Date.now() >= sessionCfg.stopAtMs))) {
        await sleep(Number(rt.pollMs ?? sessionCfg.pollMs));
        continue;
      }
      if (ctl.state === "paused" && sessionCapExitAction(
        !!sessionCfg.stopWhenSessionCapReached,
        sessionCapReached,
        pendingSubmitted.length,
      ) !== "normal") {
        if (pendingSubmitted.length === 0) {
          console.log("[session] session cap reached and pending results drained, stopping");
          return;
        }
        await sleep(Number(rt.pollMs ?? sessionCfg.pollMs));
        continue;
      }

      if(!runtimeSnapshotMatches(rt,getRuntimeSettings()))continue;
      const prefetchedGames = filterGamesByAllowlist(
        await client.listGames(effectiveLoopCfg.gameStatusMask),
        effectiveLoopCfg.allowedGameIds,
      );
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
          sessionCapReached = true;
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
          if (sessionCfg.stopWhenSessionCapReached && pendingSubmitted.length === 0) return;
          await sleep(Number(rt.pollMs ?? sessionCfg.pollMs));
          continue;
        }

        const requiredSpacing=sessionCfg.accelerated?sessionCfg.accelerated.startIntervalMs:(effectivePolicy.minMillisBetweenLiveThrows??0);
        const lastPaceTime=sessionCfg.accelerated?lastAcceleratedStart:lastLiveThrowAt;
        if (now - lastPaceTime < requiredSpacing) {
          const remainingMs = requiredSpacing - (now - lastPaceTime);
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

      if(sessionCfg.accelerated){if(Date.now()>=sessionCfg.accelerated.stopAtMs||totalLiveThrows>=sessionCfg.accelerated.maxThrows){updateControlState({state:"paused",lastMessage:`Accelerated deadline or ${sessionCfg.accelerated.maxThrows}-throw limit reached`});continue;}lastAcceleratedStart=Date.now();}
      const planningEpoch=getControlState().lastAction?.ts??null;
      let result;try{result = await runAgentOnce(
        client,
        wasm,
        effectivePolicy,
        {
          ...effectiveLoopCfg,
          maySubmit:()=>submissionStillAllowed(rt,getRuntimeSettings(),planningEpoch,getControlState(),totalLiveThrows,sessionCfg.accelerated?.maxThrows??Infinity),
          prefetchedGames,
          sessionEligibility,
        },
      );

      }catch(e){if(e instanceof SubmissionGateClosed){console.log("[session] submission gated before signing; replan current context");continue;}throw e;}

      if (result.gameId) {
        recentGameTouches.set(result.gameId, now);
      }

      if (result.winnerSubmitted && result.decisionId && result.gameId) {
        totalLiveThrows += 1;
        lastLiveThrowAt = Date.now();

        sessionThrowCounts.set(
          result.gameId,
          (sessionThrowCounts.get(result.gameId) ?? 0) + 1,
        );

        pendingSubmitted.push({
          decisionId: result.decisionId,
          gameId: result.gameId,
          submittedAt: now,
          expected: { ...payloadToExpectedSummary(result.winnerPayload), throwId: result.signedSubmission?.throwId ?? undefined },
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







