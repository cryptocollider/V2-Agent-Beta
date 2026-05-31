import { buildEligibilityCompactCode } from "../agent/eligibility.js";
import { buildSettingsAuditReport } from "../agent/settings-audit.js";
import { DEFAULT_GOAL_WEIGHTS, resolveAgentProfile } from "../core/agent-profile.js";
import { normalizeAssetsMetaPayload } from "../core/assets-meta.js";
import { buildBootstrapSummary } from "../core/bootstrap.js";
import { buildHonestPerformanceBaseline } from "../core/hps-baseline.js";
import {
  getLatestCandidateContext,
  getLatestEligibilitySnapshot,
  getManagerCandidateSet,
  getManagerOverlay,
  saveManagerCandidateSet,
  saveManagerOverlay,
} from "../core/manager-state.js";
import { DEFAULT_HUMAN_LEARNING_SETTINGS, DEFAULT_ONBOARDING_SETTINGS, loadSettings, normalizeSettings, saveSettings } from "../core/settings.js";
import { ColliderClient } from "../collider/client.js";
import { getControlState, getRuntimeSettings, applyControlAction, updateRuntimeSettings } from "../core/runtime-state.js";
import { getPublicManagerLlmState } from "./state.js";
import type { ManagerLlmAction, ManagerStateSnapshotForLlm } from "./types.js";
import { normalizeManagerCandidateSet, normalizeManagerTacticalOverlay } from "../strategy/tactical-overlay.js";
import { readFile } from "node:fs/promises";
import path from "node:path";

export type ManagerBridge = {
  getRuntimeSettings?: () => unknown | Promise<unknown>;
  updateRuntimeSettings?: (patch: Record<string, unknown>) => unknown | Promise<unknown>;
  getControlState?: () => unknown | Promise<unknown>;
  applyControlAction?: (request: { action: string; payload: Record<string, unknown> }) => unknown | Promise<unknown>;
  getLatestEligibilitySnapshot?: () => unknown | Promise<unknown>;
  getLatestCandidateContext?: () => unknown | Promise<unknown>;
  getManagerOverlay?: () => unknown | Promise<unknown>;
  saveManagerOverlay?: (overlay: unknown) => unknown | Promise<unknown>;
  getManagerCandidateSet?: () => unknown | Promise<unknown>;
  saveManagerCandidateSet?: (candidateSet: unknown) => unknown | Promise<unknown>;
};

function parseJsonl(text: string): any[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function safeReadText(file: string): Promise<string> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return "";
  }
}

function cleanHex(value: unknown): string {
  return String(value ?? "").toLowerCase().replace(/^0x/, "");
}

function summarizeHonestPerformanceRow(row: any): Record<string, unknown> {
  return {
    ts: row?.ts ?? null,
    sessionId: row?.sessionId ?? null,
    decisionId: row?.decisionId ?? null,
    gameId: row?.gameId ?? null,
    botUser: row?.botUser ?? null,
    honestScore: row?.honestScore ?? null,
    predictionCommit: row?.predictionCommit ?? null,
    predictionReveal: row?.predictionReveal ?? null,
  };
}

function buildLatestResultsByDecision(rows: any[]): any[] {
  const map = new Map<string, any>();
  const score = (row: any) => {
    let value = 0;
    if (row?.actual?.throwMatch) value += 4;
    if (row?.actual?.throwMatch?.hole_type != null) value += 8;
    if (row?.actual?.throwMatch?.value_usd_e8 != null) value += 4;
    if (row?.actual?.throwMatch?.matched) value += 2;
    if (Array.isArray(row?.actual?.wholeGame?.per_user_scoreboard)) value += 1;
    if (row?.actual?.expectationVsActual?.actual_hole_type != null) value += 2;
    return value;
  };
  for (const row of rows) {
    const key = String(row?.decisionId || "").trim();
    if (!key) continue;
    const prev = map.get(key);
    if (!prev) {
      map.set(key, row);
      continue;
    }
    const prevTs = new Date(prev?.ts || 0).getTime();
    const nextTs = new Date(row?.ts || 0).getTime();
    if (score(row) > score(prev) || (score(row) === score(prev) && nextTs >= prevTs)) {
      map.set(key, row);
    }
  }
  return [...map.values()].sort((a, b) => new Date(b?.ts || 0).getTime() - new Date(a?.ts || 0).getTime());
}

function buildHonestPerformanceSnapshot(rows: any[]): {
  revealRows: any[];
  scoredRows: any[];
  counts: {
    revealRows: number;
    scoredRows: number;
    uniqueGames: number;
  };
  baseline: ReturnType<typeof buildHonestPerformanceBaseline>;
} {
  const revealRows = buildLatestResultsByDecision(rows)
    .filter((row) => row?.predictionReveal?.localPath || row?.honestScore);
  const scoredRows = revealRows.filter((row) => row?.honestScore?.honestScore != null);
  const uniqueGames = new Set(
    revealRows
      .map((row) => cleanHex(row?.gameId || ""))
      .filter(Boolean),
  );
  return {
    revealRows,
    scoredRows,
    counts: {
      revealRows: revealRows.length,
      scoredRows: scoredRows.length,
      uniqueGames: uniqueGames.size,
    },
    baseline: buildHonestPerformanceBaseline(scoredRows),
  };
}

function safeRuntimeSettings(): Record<string, unknown> | null {
  try {
    return getRuntimeSettings();
  } catch {
    return null;
  }
}

const BRIDGE_READ_TIMEOUT_MS = 3000;

export type SaveSettingsAndRuntimeResult = {
  settings: ReturnType<typeof normalizeSettings>;
  runtime: unknown;
  runtimeSyncPending: boolean;
  runtimeSyncError: string | null;
};

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function fromBridge<T>(bridgeCall: (() => T | Promise<T>) | undefined, fallback: () => T | Promise<T>): Promise<T> {
  if (bridgeCall) return await bridgeCall();
  return await fallback();
}

async function fromBridgeWithArg<T, A>(
  bridgeCall: ((arg: A) => T | Promise<T>) | undefined,
  arg: A,
  fallback: (arg: A) => T | Promise<T>,
): Promise<T> {
  if (bridgeCall) return await bridgeCall(arg);
  return await fallback(arg);
}

async function fromBridgeRead<T>(
  bridgeCall: (() => T | Promise<T>) | undefined,
  fallback: () => T | Promise<T>,
  label: string,
  timeoutMs = BRIDGE_READ_TIMEOUT_MS,
): Promise<T> {
  if (!bridgeCall) return await fallback();
  try {
    return await withTimeout(Promise.resolve().then(() => bridgeCall()), timeoutMs, label);
  } catch {
    return await fallback();
  }
}

function emptyCandidateFilterSummary(): {
  reasonCounts: Record<string, number>;
  totalRawCandidates: number;
  totalEligibleCandidates: number;
  limitedCandidates: number;
  plannedCandidates: number;
} {
  return {
    reasonCounts: {},
    totalRawCandidates: 0,
    totalEligibleCandidates: 0,
    limitedCandidates: 0,
    plannedCandidates: 0,
  };
}

async function readLatestRunRow(dataDir: string): Promise<any | null> {
  const text = await safeReadText(path.join(dataDir, "runs.jsonl"));
  if (!text.trim()) return null;
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]);
    } catch {
      // Skip malformed tail lines and continue scanning backward.
    }
  }
  return null;
}

function buildEligibilitySnapshotFromRun(row: any): Record<string, unknown> | null {
  const eligibility = row?.eligibility;
  if (!eligibility || typeof eligibility !== "object") return null;
  const searchSummary = (row?.search?.candidateFilterSummary && typeof row.search.candidateFilterSummary === "object")
    ? row.search.candidateFilterSummary
    : emptyCandidateFilterSummary();
  return {
    ts: String(row?.ts || new Date().toISOString()),
    globalReasons: Array.isArray(eligibility.globalReasons) ? eligibility.globalReasons : [],
    selectedGameId: row?.gameId ?? null,
    perGame: Array.isArray(eligibility.perGame) ? eligibility.perGame : [],
    assetPlanning: Array.isArray(eligibility.assetPlanning) ? eligibility.assetPlanning : [],
    candidateFilterSummary: (eligibility.candidateFilterSummary && typeof eligibility.candidateFilterSummary === "object")
      ? eligibility.candidateFilterSummary
      : searchSummary,
    notes: Array.isArray(eligibility.notes) ? eligibility.notes : [],
  };
}

function buildCandidateContextFromRun(
  row: any,
  overlay: unknown,
  managerCandidateSet: unknown,
): Record<string, unknown> | null {
  const topDetailed = Array.isArray(row?.topDetailed) ? row.topDetailed : [];
  if (!topDetailed.length && !row?.gameId && !row?.stoppedBy) return null;
  return {
    ts: String(row?.ts || new Date().toISOString()),
    gameId: row?.gameId ?? null,
    stoppedBy: row?.stoppedBy ?? null,
    winnerCandidateHash: typeof topDetailed[0]?.candidateHash === "string" ? topDetailed[0].candidateHash : null,
    overlay: overlay ?? null,
    managerCandidateSet: managerCandidateSet ?? null,
    candidates: topDetailed.map((entry: any, index: number) => ({
      rank: Number.isFinite(Number(entry?.rank)) ? Number(entry.rank) : index + 1,
      candidateHash: String(entry?.candidateHash || ""),
      candidate: {
        source: String(entry?.source || "grid"),
        x: Number(entry?.x ?? 0),
        y: Number(entry?.y ?? 0),
        angleDeg: Number(entry?.angleDeg ?? 0),
        speedPct: Number(entry?.speedPct ?? 0),
        spinPct: Number(entry?.spinPct ?? 0),
        asset: cleanHex(entry?.asset || row?.chosenPayload?.asset || ""),
        amount: String(entry?.amount ?? row?.chosenPayload?.amount ?? "0"),
      },
      baseScore: entry?.baseScore ?? entry?.adjustedScore ?? {
        weightedTotal: 0,
        worstCaseTotal: 0,
        bestCaseTotal: 0,
        fragilityPenalty: 0,
        final: 0,
      },
      adjustedScore: entry?.adjustedScore ?? entry?.baseScore ?? {
        weightedTotal: 0,
        worstCaseTotal: 0,
        bestCaseTotal: 0,
        fragilityPenalty: 0,
        final: 0,
      },
      basePrediction: entry?.basePrediction ?? null,
      adjustedPrediction: entry?.managerAdjustedPrediction ?? entry?.adjustedPrediction ?? null,
      overlay: entry?.overlay ?? { active: false, scoreDelta: 0, adjustments: [] },
    })),
  };
}

function mergeEffectiveSettings(
  settings: Awaited<ReturnType<typeof loadSettings>>,
  runtime: Record<string, unknown> | null | undefined,
): ReturnType<typeof normalizeSettings> {
  return (runtime && typeof runtime === "object")
    ? normalizeSettings({ ...settings, ...runtime })
    : settings;
}

function mergeSettingsPatch(
  current: Awaited<ReturnType<typeof loadSettings>>,
  patch: Record<string, unknown>,
): ReturnType<typeof normalizeSettings> {
  const goalWeightsPatch = (patch?.goalWeights && typeof patch.goalWeights === "object")
    ? patch.goalWeights as Partial<typeof DEFAULT_GOAL_WEIGHTS>
    : null;
  const onboardingPatch = (patch?.onboarding && typeof patch.onboarding === "object")
    ? patch.onboarding as Partial<typeof DEFAULT_ONBOARDING_SETTINGS>
    : null;
  const humanLearningPatch = (patch?.humanLearning && typeof patch.humanLearning === "object")
    ? patch.humanLearning as Partial<typeof DEFAULT_HUMAN_LEARNING_SETTINGS>
    : null;
  return normalizeSettings({
    ...current,
    ...patch,
    goalWeights: goalWeightsPatch
      ? {
        ...DEFAULT_GOAL_WEIGHTS,
        ...(current.goalWeights ?? {}),
        ...goalWeightsPatch,
      }
      : current.goalWeights,
    onboarding: onboardingPatch
      ? {
        ...DEFAULT_ONBOARDING_SETTINGS,
        ...(current.onboarding ?? {}),
        ...onboardingPatch,
      }
      : current.onboarding,
    humanLearning: humanLearningPatch
      ? {
        ...DEFAULT_HUMAN_LEARNING_SETTINGS,
        ...(current.humanLearning ?? {}),
        ...humanLearningPatch,
      }
      : current.humanLearning,
  });
}

export async function buildManagerStatePayload(dataDir: string, bridge: ManagerBridge): Promise<Record<string, unknown>> {
  const settings = await loadSettings(dataDir);
  const resultsText = await safeReadText(path.join(dataDir, "results.jsonl"));
  const honestPerformance = buildHonestPerformanceSnapshot(parseJsonl(resultsText));
  const latestRun = await readLatestRunRow(dataDir);
  const localOverlay = getManagerOverlay();
  const localCandidateSet = getManagerCandidateSet();
  const derivedEligibility = buildEligibilitySnapshotFromRun(latestRun);
  const derivedCandidates = buildCandidateContextFromRun(latestRun, localOverlay, localCandidateSet);
  const [
    latestEligibility,
    runtime,
    control,
    overlay,
    managerCandidateSet,
    latestCandidates,
  ] = await Promise.all([
    fromBridgeRead(
      bridge.getLatestEligibilitySnapshot,
      () => getLatestEligibilitySnapshot() ?? derivedEligibility,
      "manager latest eligibility",
    ),
    fromBridgeRead(
      bridge.getRuntimeSettings,
      () => safeRuntimeSettings(),
      "manager runtime settings",
    ),
    fromBridgeRead(
      bridge.getControlState,
      () => getControlState(),
      "manager control state",
    ),
    fromBridgeRead(
      bridge.getManagerOverlay,
      () => localOverlay,
      "manager overlay",
    ),
    fromBridgeRead(
      bridge.getManagerCandidateSet,
      () => localCandidateSet,
      "manager candidate set",
    ),
    fromBridgeRead(
      bridge.getLatestCandidateContext,
      () => getLatestCandidateContext() ?? derivedCandidates,
      "manager candidate context",
    ),
  ]);
  const settingsSource = (runtime && typeof runtime === "object")
    ? normalizeSettings({ ...settings, ...(runtime as Record<string, unknown>) })
    : settings;
  const profile = resolveAgentProfile(settingsSource);
  const eligibilityCode = latestEligibility
    ? buildEligibilityCompactCode(latestEligibility as any)
    : String(latestRun?.eligibilityCode || "").trim() || "CHECK";
  return {
    settings,
    runtime,
    onboarding: buildBootstrapSummary(settingsSource),
    profile,
    control,
    audit: buildSettingsAuditReport(settings),
    overlay,
    managerCandidateSet,
    latestEligibility,
    eligibilityCode,
    latestCandidates,
    honestPerformance: {
      counts: honestPerformance.counts,
      baseline: honestPerformance.baseline,
      latest: honestPerformance.revealRows[0] ? summarizeHonestPerformanceRow(honestPerformance.revealRows[0]) : null,
      latestScored: honestPerformance.scoredRows[0] ? summarizeHonestPerformanceRow(honestPerformance.scoredRows[0]) : null,
    },
    llmManager: getPublicManagerLlmState(),
  };
}

export function toManagerLlmSnapshot(payload: Record<string, unknown>): ManagerStateSnapshotForLlm {
  return {
    generatedAt: new Date().toISOString(),
    settings: (payload.settings && typeof payload.settings === "object") ? payload.settings as Record<string, unknown> : {},
    runtime: (payload.runtime && typeof payload.runtime === "object") ? payload.runtime as Record<string, unknown> : null,
    onboarding: (payload.onboarding && typeof payload.onboarding === "object") ? payload.onboarding as Record<string, unknown> : null,
    profile: (payload.profile && typeof payload.profile === "object") ? payload.profile as Record<string, unknown> : null,
    control: (payload.control && typeof payload.control === "object") ? payload.control as Record<string, unknown> : null,
    audit: (payload.audit && typeof payload.audit === "object") ? payload.audit as Record<string, unknown> : null,
    latestEligibility: (payload.latestEligibility && typeof payload.latestEligibility === "object") ? payload.latestEligibility as Record<string, unknown> : null,
    eligibilityCode: String(payload.eligibilityCode ?? "").trim() || null,
    latestCandidates: (payload.latestCandidates && typeof payload.latestCandidates === "object") ? payload.latestCandidates as Record<string, unknown> : null,
    overlay: (payload.overlay && typeof payload.overlay === "object") ? payload.overlay as Record<string, unknown> : null,
    managerCandidateSet: (payload.managerCandidateSet && typeof payload.managerCandidateSet === "object") ? payload.managerCandidateSet as Record<string, unknown> : null,
    honestPerformance: (payload.honestPerformance && typeof payload.honestPerformance === "object") ? payload.honestPerformance as Record<string, unknown> : null,
  };
}

export async function saveSettingsAndRuntime(
  patch: Record<string, unknown>,
  dataDir: string,
  bridge: ManagerBridge,
): Promise<SaveSettingsAndRuntimeResult> {
  const current = await loadSettings(dataDir);
  const merged = mergeSettingsPatch(current, patch);
  await saveSettings(merged, dataDir);
  let runtime: unknown = null;
  let runtimeSyncPending = false;
  let runtimeSyncError: string | null = null;
  try {
    runtime = await fromBridgeWithArg(
      bridge.updateRuntimeSettings,
      merged,
      (runtimePatch) => updateRuntimeSettings(runtimePatch),
    );
  } catch (err) {
    runtimeSyncPending = true;
    runtimeSyncError = String(err);
  }
  return {
    settings: mergeEffectiveSettings(
      merged,
      (runtime && typeof runtime === "object") ? runtime as Record<string, unknown> : null,
    ),
    runtime,
    runtimeSyncPending,
    runtimeSyncError,
  };
}

export async function captureManagerLlmActionSnapshot(
  dataDir: string,
  bridge: ManagerBridge,
): Promise<Record<string, unknown>> {
  const settings = await loadSettings(dataDir);
  const runtime = await fromBridge(bridge.getRuntimeSettings, () => safeRuntimeSettings());
  const control = await fromBridge(bridge.getControlState, () => getControlState());
  const overlay = await fromBridge(bridge.getManagerOverlay, () => getManagerOverlay());
  const managerCandidateSet = await fromBridge(bridge.getManagerCandidateSet, () => getManagerCandidateSet());
  return {
    capturedAt: new Date().toISOString(),
    settings,
    runtime: (runtime && typeof runtime === "object") ? runtime as Record<string, unknown> : null,
    control: (control && typeof control === "object") ? control as Record<string, unknown> : null,
    overlay: (overlay && typeof overlay === "object") ? overlay as Record<string, unknown> : overlay ?? null,
    managerCandidateSet: (managerCandidateSet && typeof managerCandidateSet === "object")
      ? managerCandidateSet as Record<string, unknown>
      : managerCandidateSet ?? null,
  };
}

export async function applyManagerLlmAction(
  action: ManagerLlmAction,
  dataDir: string,
  bridge: ManagerBridge,
): Promise<Record<string, unknown>> {
  switch (action.kind) {
    case "settings_patch": {
      if (!action.payload || typeof action.payload !== "object") throw new Error("settings_patch is missing a payload");
      return await saveSettingsAndRuntime(action.payload, dataDir, bridge);
    }
    case "overlay": {
      if (!action.payload || typeof action.payload !== "object") throw new Error("overlay is missing a payload");
      const normalized = normalizeManagerTacticalOverlay(action.payload);
      const overlay = await fromBridgeWithArg(
        bridge.saveManagerOverlay,
        normalized,
        (payload) => saveManagerOverlay(payload as any),
      );
      return { overlay };
    }
    case "candidate_set": {
      if (!action.payload || typeof action.payload !== "object") throw new Error("candidate_set is missing a payload");
      const normalized = normalizeManagerCandidateSet(action.payload);
      const managerCandidateSet = await fromBridgeWithArg(
        bridge.saveManagerCandidateSet,
        normalized,
        (payload) => saveManagerCandidateSet(payload as any),
      );
      return { managerCandidateSet };
    }
    case "target_game": {
      const gameId = cleanHex((action.payload as any)?.gameId || "");
      if (!gameId) throw new Error("target_game is missing gameId");
      const control = await fromBridgeWithArg(
        bridge.applyControlAction,
        { action: "target_game", payload: { gameId } },
        ({ action: nextAction, payload }) => applyControlAction(nextAction, payload),
      );
      return { control, targetGameId: gameId };
    }
    case "clear_target_game": {
      const control = await fromBridgeWithArg(
        bridge.applyControlAction,
        { action: "clear_target_game", payload: {} },
        ({ action: nextAction, payload }) => applyControlAction(nextAction, payload),
      );
      return { control, targetGameId: null };
    }
    default:
      throw new Error(`Unsupported LLM action kind: ${action.kind satisfies never}`);
  }
}

export async function fetchAssetsMeta(dataDir: string, bridge: ManagerBridge): Promise<Record<string, unknown>> {
  const settings = await loadSettings(dataDir);
  const runtime = await fromBridge(bridge.getRuntimeSettings, () => safeRuntimeSettings());
  const effective = mergeEffectiveSettings(settings, (runtime && typeof runtime === "object") ? runtime as Record<string, unknown> : null);
  const client = new ColliderClient(effective.rpc);
  return { assets: normalizeAssetsMetaPayload(await client.getAssetsMeta()) };
}
