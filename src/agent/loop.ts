import { readFile } from "node:fs/promises";
import type { AgentPolicy } from "../policy/schema.js";
import type {
  AgentControlThrow,
  GameListItem,
  Hex32,
  SimRunInput,
} from "../collider/types.js";
import {
  appendRunLog,
  appendThrowLog,
  makeDecisionId,
  writeArtifactJson,
  type ArtifactLogRef,
  type CandidateContextLogView,
  type OverlayLogView,
  type PredictionCoverageLogView,
  type PredictionLogView,
  type StoragePaths,
} from "../core/storage.js";
import { buildContentAddressRefFromJson } from "../core/content-address.js";
import type { WasmVizRuntime } from "../sim/wasm.js";
import type { ResolvedAgentProfile } from "../core/agent-profile.js";
import { generateGridCandidates, shuffleCandidates, type Candidate } from "../strategy/candidate-gen.js";
import { chooseBestRanked, rankPlannedCandidates, type RankedCandidate, type SearchBudget } from "../strategy/choose.js";
import {
  runCandidateAcrossQueueScenarios,
  type PlannerScenarioOverride,
} from "../sim/planner.js";
import {
  buildQueueScenarioSet,
  controlThrowToPlaceThrowArgs,
} from "../collider/throw-builder.js";
import type { RecentShot } from "../strategy/score.js";
import { summarizePredictionFromPlan, type PredictionSummary } from "./prediction-log.js";
import {
  buildPredictionCommitBundle,
  type PredictionCommitPayload,
} from "./prediction-artifact.js";
import {
  buildAssetPlanningResult,
  buildEligibilityCompactCode,
  estimateCandidateUsd,
  evaluateGamesForEligibility,
  getCandidateFilterReasons,
  incrementReasonCount,
  type CandidateFilterSummary,
  type EligibilityReasonCode,
  type LatestEligibilitySnapshot,
  type SessionEligibilityContext,
} from "./eligibility.js";
import {
  getManagerCandidateSet,
  getManagerOverlay,
  setLatestCandidateContext,
  setLatestEligibilitySnapshot,
} from "../core/manager-state.js";
import {
  applyOverlayToCandidate,
  buildManagerCandidateSpecMap,
  buildManagerCandidates,
  hashCandidate,
  scoreViewFromRobustScore,
  type LatestCandidateContext,
  type ManagerCandidateSet,
  type ManagerCandidateSpec,
  type OverlayAdjustment,
  type RankedCandidateContext,
} from "../strategy/tactical-overlay.js";

export type ColliderClientLike = {
  listGames(statusMask?: number): Promise<GameListItem[]>;
  getGame(gameId: Hex32): Promise<unknown>;
  getSimInput(gameId: Hex32): Promise<SimRunInput>;
  getBalances(user: Hex32): Promise<Record<string, string>>;
  placeThrow(args: unknown): Promise<unknown>;
};

export type LoopConfig = {
  gameStatusMask: number;
  botUser: Hex32;
  defaultAsset: Hex32;
  defaultAmount: string;
  dryRun?: boolean;
  includeSlip1?: boolean;
  candidateBudget?: SearchBudget;
  candidateGen?: {
    xSteps?: number;
    ySteps?: number;
    angleDegs?: number[];
    speedPcts?: number[];
    spinPcts?: number[];
  };
  scoreConfig?: {
    preferredHoleTypes?: number[];
    blockedHoleTypes?: number[];
    robustnessWeight?: number;
    fragilityWeight?: number;
    recentShots?: RecentShot[];
  };
  prefetchedGames?: GameListItem[];
  sessionEligibility?: SessionEligibilityContext;
  preferredGameId?: Hex32 | string;
  selectionMode?: "best" | "random";
  sessionId: string;
  storage?: StoragePaths;
  agentProfile?: ResolvedAgentProfile;
};

export type TopCandidateView = {
  rank: number;
  final: number;
  weightedTotal: number;
  worstCaseTotal: number;
  bestCaseTotal: number;
  fragilityPenalty: number;
  x: number;
  y: number;
  angleDeg: number;
  speedPct: number;
  spinPct: number;
};

export type RunOnceResult = {
  decisionId: string | null;
  gameId: Hex32 | null;
  winnerSubmitted: boolean;
  winnerPayload?: unknown;
  winnerCandidateHash?: string | null;
  predictionCommit?: ArtifactLogRef | null;
  predictionCommitPayload?: PredictionCommitPayload | null;
  top: TopCandidateView[];
  eligibilityCode?: string;
  stoppedBy?: string;
};

type RankedCandidateMeta = {
  candidateHash: string;
  baseScore: ReturnType<typeof scoreViewFromRobustScore>;
  adjustedScore: ReturnType<typeof scoreViewFromRobustScore>;
  basePrediction: PredictionSummary | null;
  adjustedPrediction: PredictionSummary | null;
  overlayActive: boolean;
  overlayScoreDelta: number;
  overlayAdjustments: OverlayAdjustment[];
};

type PredictionSummaryLike = {
  scenarioCount: number;
  winnerScenarioCount: number;
  pnlUsd: number | null;
  bestPnlUsd: number | null;
  worstPnlUsd: number | null;
  holeType: number | null;
  holeTypeCounts: Record<string, number>;
  valueUsd: number | null;
  valueUsdE8: string | null;
  massUsd: number | null;
  winnerValuePct: number | null;
};

function cleanHex(value: string): string {
  return String(value || "").replace(/^0x/i, "").toLowerCase();
}

type AssetPriceHintState = {
  epoch: number;
  usdPerBase: number;
};

let cachedInternalPriceHintState: Record<string, AssetPriceHintState> = {};

function normalizeSimAssetHex(value: unknown): string {
  return Array.isArray(value)
    ? value.map((b) => Number(b).toString(16).padStart(2, "0")).join("")
    : cleanHex(String(value || ""));
}

function collectAssetPriceHintState(simInput: SimRunInput): Record<string, AssetPriceHintState> {
  const out: Record<string, AssetPriceHintState> = {};
  for (const throwRecord of simInput.throws || []) {
    const asset = normalizeSimAssetHex((throwRecord as { asset?: unknown }).asset);
    if (!asset) continue;
    const epoch = Number((throwRecord as { price_epoch?: unknown }).price_epoch ?? 0);
    const amountBase = Number((throwRecord as { amount?: unknown }).amount ?? 0);
    const valueUsd = Number((throwRecord as { value_usd_e8?: unknown }).value_usd_e8 ?? 0) / 1e8;
    if (!(amountBase > 0) || !Number.isFinite(valueUsd) || valueUsd <= 0) continue;
    const usdPerBase = valueUsd / amountBase;
    const prev = out[asset];
    if (!prev || epoch >= prev.epoch) {
      out[asset] = { epoch, usdPerBase };
    }
  }
  return out;
}

function mergeAssetPriceHintState(...sources: Array<Record<string, AssetPriceHintState> | null | undefined>): Record<string, AssetPriceHintState> {
  const merged: Record<string, AssetPriceHintState> = {};
  for (const source of sources) {
    for (const [asset, hint] of Object.entries(source || {})) {
      if (!hint || !(hint.usdPerBase > 0)) continue;
      const cleanAsset = cleanHex(asset);
      const prev = merged[cleanAsset];
      if (!prev || Number(hint.epoch ?? 0) >= Number(prev.epoch ?? -1)) {
        merged[cleanAsset] = { epoch: Number(hint.epoch ?? 0), usdPerBase: Number(hint.usdPerBase) };
      }
    }
  }
  return merged;
}

function toUsdPerBaseHints(state: Record<string, AssetPriceHintState>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(state)
      .filter(([, hint]) => hint && hint.usdPerBase > 0)
      .map(([asset, hint]) => [asset, hint.usdPerBase]),
  );
}

function requiredPricingAssets(policy: AgentPolicy, defaultAsset: Hex32): string[] {
  const assets = new Set<string>([cleanHex(String(defaultAsset || ""))]);
  for (const asset of policy.allowedAssets ?? []) {
    const cleanAsset = cleanHex(String(asset || ""));
    if (cleanAsset) assets.add(cleanAsset);
  }
  return [...assets].filter(Boolean);
}

function hasPriceCoverageForAssets(state: Record<string, AssetPriceHintState>, assets: string[]): boolean {
  return assets.every((asset) => {
    const hint = state[cleanHex(asset)];
    return !!hint && hint.usdPerBase > 0;
  });
}

async function buildPriceHintsUsdPerBase(params: {
  client: ColliderClientLike;
  games: GameListItem[];
  selectedGameId: Hex32;
  selectedSimInput: SimRunInput;
  policy: AgentPolicy;
  defaultAsset: Hex32;
}): Promise<Record<string, number>> {
  const { client, games, selectedGameId, selectedSimInput, policy, defaultAsset } = params;
  const neededAssets = requiredPricingAssets(policy, defaultAsset);
  let merged = mergeAssetPriceHintState(
    cachedInternalPriceHintState,
    collectAssetPriceHintState(selectedSimInput),
  );

  if (!hasPriceCoverageForAssets(merged, neededAssets)) {
    const fallbackGames = games
      .filter((game) => cleanHex(String(game.game_id || "")) !== cleanHex(String(selectedGameId || "")))
      .filter((game) => Number(game.throws || 0) > 0)
      .sort((a, b) => Number(b.last_throw_height || 0) - Number(a.last_throw_height || 0));

    for (const fallbackGame of fallbackGames.slice(0, 4)) {
      try {
        const fallbackInput = await client.getSimInput(fallbackGame.game_id);
        merged = mergeAssetPriceHintState(merged, collectAssetPriceHintState(fallbackInput));
      } catch {
        // keep the strongest internal price evidence already collected
      }
      if (hasPriceCoverageForAssets(merged, neededAssets)) break;
    }
  }

  cachedInternalPriceHintState = mergeAssetPriceHintState(cachedInternalPriceHintState, merged);
  return toUsdPerBaseHints(cachedInternalPriceHintState);
}

function emptyCandidateFilterSummary(): CandidateFilterSummary {
  return {
    reasonCounts: {},
    totalRawCandidates: 0,
    totalEligibleCandidates: 0,
    limitedCandidates: 0,
    plannedCandidates: 0,
  };
}

function buildArtifactRefFromPayload(schema: string, payload: unknown): ArtifactLogRef {
  const addressed = buildContentAddressRefFromJson(payload);
  return {
    schema,
    sha256Hex: addressed.sha256Hex,
    cid: addressed.cid,
    ipfsUri: addressed.ipfsUri,
    bytes: addressed.bytes,
    localPath: "",
  };
}

function toPredictionCoverageLogView(commit: PredictionCommitPayload | null | undefined): PredictionCoverageLogView | null {
  if (!commit) return null;
  const snapshot = commit.snapshots[0];
  return {
    knownExistingThrowsTotal: commit.coverage.knownExistingThrowsTotal,
    predictedTrackedThrowsTotal: commit.coverage.predictedTrackedThrowsTotal,
    predictedUsersTotal: commit.coverage.predictedUsersTotal,
    predictedThrows: commit.coverage.predictedTrackedThrowsTotal,
    outcomeCoveragePct: snapshot?.coverage?.trackedThrowsPct ?? null,
    valueCoveragePct: snapshot?.coverage?.trackedThrowsPct ?? null,
    gameCoveragePct: snapshot?.coverage?.gameForecastPct ?? (commit.coverage.predictedGameTotals ? 1 : 0),
    temporalCoveragePct: snapshot?.coverage?.temporalPct ?? (commit.coverage.predictedTemporal ? 1 : 0),
    snapshotCount: commit.coverage.snapshotCount,
    predictedGameTotals: commit.coverage.predictedGameTotals,
    predictedTemporal: commit.coverage.predictedTemporal,
    predictedDynamicUpdates: commit.coverage.predictedDynamicUpdates,
    knownFutureUnknownThrowsMode: commit.coverage.knownFutureUnknownThrowsMode,
  };
}

function toPredictionLogView(
  prediction: PredictionSummaryLike | null | undefined,
  options: {
    predictionCommit?: ArtifactLogRef | null;
    coverage?: PredictionCoverageLogView | null;
  } = {},
): PredictionLogView | undefined {
  if (!prediction) return undefined;
  return {
    pnlUsd: prediction.pnlUsd,
    bestPnlUsd: prediction.bestPnlUsd,
    worstPnlUsd: prediction.worstPnlUsd,
    scenarioCount: prediction.scenarioCount,
    winnerScenarioCount: prediction.winnerScenarioCount,
    winnerValuePct: prediction.winnerValuePct,
    holeType: prediction.holeType,
    holeTypeCounts: prediction.holeTypeCounts,
    valueUsd: prediction.valueUsd,
    valueUsdE8: prediction.valueUsdE8,
    massUsd: prediction.massUsd,
    predictionCommit: options.predictionCommit ?? null,
    coverage: options.coverage ?? null,
  };
}

function toOverlayLogView(meta: RankedCandidateMeta | null): OverlayLogView | undefined {
  if (!meta) return undefined;
  return {
    active: meta.overlayActive,
    scoreDelta: meta.overlayScoreDelta,
    adjustments: meta.overlayAdjustments,
  };
}

function nextAcceptedHeightFromGame(game: unknown): number {
  const g = game as Record<string, unknown>;
  const lastThrowHeight = Number(g.last_throw_height ?? 0);
  return lastThrowHeight + 1;
}

async function loadHistoricalWinningSeeds(
  storage: StoragePaths | undefined,
  assetHex: string,
  amount: string,
): Promise<Candidate[]> {
  if (!storage) return [];
  try {
    const txt = await readFile(storage.resultsFile, "utf8");
    const lines = txt.trim().split(/\r?\n/).filter(Boolean).slice(-300);
    const out: Candidate[] = [];
    for (const line of lines.reverse()) {
      let row: any;
      try { row = JSON.parse(line); } catch { continue; }
      const holeType = Number(row?.actual?.throwMatch?.hole_type ?? NaN);
      if (!Number.isFinite(holeType) || holeType !== 3) continue;
      const payload = row?.expected?.payload;
      if (!payload) continue;
      out.push({
        x: Number(payload.x),
        y: Number(payload.y),
        angleDeg: Number(payload.angle_rad) * 180 / Math.PI,
        speedPct: 65,
        spinPct: 0,
        asset: assetHex,
        amount,
        source: "history",
        tags: ["winning-history-seed"],
      });
      if (out.length >= 12) break;
    }
    return out.filter((candidate) => [candidate.x, candidate.y, candidate.angleDeg, candidate.speedPct, candidate.spinPct].every(Number.isFinite));
  } catch {
    return [];
  }
}

function samePlannedControl(
  a: AgentControlThrow,
  b: AgentControlThrow,
): boolean {
  return (
    a.x === b.x &&
    a.y === b.y &&
    a.angleDeg === b.angleDeg &&
    a.speedPct === b.speedPct &&
    a.spinPct === b.spinPct &&
    cleanHex(a.asset) === cleanHex(b.asset) &&
    String(a.amount) === String(b.amount)
  );
}

function printCycleSummary(
  game: GameListItem,
  top: TopCandidateView[],
  stoppedBy: string | undefined,
  submitted: boolean,
): void {
  const now = new Date().toLocaleTimeString();
  console.log(
    `[${now}] game ${game.game_id.slice(0, 10)}... | throws=${game.throws} | stake=${game.stake} | minThrow=${game.throw_min_value}`,
  );
  console.log(`search stopped=${stoppedBy ?? "unknown"} submitted=${submitted ? "yes" : "no"}`);

  for (const row of top.slice(0, 3)) {
    console.log(
      `  #${row.rank} x=${row.x} y=${row.y} ang=${row.angleDeg} spd=${row.speedPct} spin=${row.spinPct} final=${row.final.toFixed(2)} robust=${row.weightedTotal.toFixed(2)} frag=${row.fragilityPenalty.toFixed(2)}`,
    );
  }
}

function buildCandidateContextLogView(context: RankedCandidateContext): CandidateContextLogView {
  return {
    rank: context.rank,
    candidateHash: context.candidateHash,
    source: context.candidate.source,
    asset: context.candidate.asset,
    amount: context.candidate.amount,
    x: context.candidate.x,
    y: context.candidate.y,
    angleDeg: context.candidate.angleDeg,
    speedPct: context.candidate.speedPct,
    spinPct: context.candidate.spinPct,
    baseScore: context.baseScore,
    adjustedScore: context.adjustedScore,
    basePrediction: toPredictionLogView(context.basePrediction) ?? null,
    managerAdjustedPrediction: toPredictionLogView(context.adjustedPrediction) ?? null,
    overlay: {
      active: context.overlay.active,
      scoreDelta: context.overlay.scoreDelta,
      adjustments: context.overlay.adjustments,
    },
  };
}

function buildTopView(rank: number, candidate: Candidate, score: ReturnType<typeof scoreViewFromRobustScore>): TopCandidateView {
  return {
    rank,
    final: score.final,
    weightedTotal: score.weightedTotal,
    worstCaseTotal: score.worstCaseTotal,
    bestCaseTotal: score.bestCaseTotal,
    fragilityPenalty: score.fragilityPenalty,
    x: candidate.x,
    y: candidate.y,
    angleDeg: candidate.angleDeg,
    speedPct: candidate.speedPct,
    spinPct: candidate.spinPct,
  };
}

function extractRankedCandidateMeta(row: RankedCandidate | null): RankedCandidateMeta | null {
  if (!row?.meta) return null;
  return row.meta as RankedCandidateMeta;
}

function uniqueReasons(reasons: EligibilityReasonCode[]): EligibilityReasonCode[] {
  return reasons.filter((value, index, arr) => arr.indexOf(value) === index);
}

function deriveStoppedBy(snapshot: LatestEligibilitySnapshot, fallback?: string | null): string {
  const reasons = new Set(snapshot.globalReasons);
  const counts = snapshot.candidateFilterSummary.reasonCounts;

  if (reasons.has("target_balance")) return "target_balance";
  if (reasons.has("target_profit")) return "target_profit";
  if (reasons.has("session_cap")) return "session_cap";
  if (reasons.has("reserve_balance")) return "reserve_balance";
  if (reasons.has("no_balance_for_amounts")) return "no_balance_for_amounts";
  if (reasons.has("missing_price_basis")) return "missing_price_basis";
  if (reasons.has("asset_blocked")) return "asset_blocked";
  if (reasons.has("asset_not_allowed")) return "asset_not_allowed";
  if (reasons.has("search_budget_stop")) return "search_budget_stop";
  if (counts.below_game_min_throw || counts.below_min_throw_usd || counts.above_max_throw_usd) return "candidate_min_limits";
  if (counts.above_max_single_throw_usd || counts.above_game_exposure) return "candidate_risk_limits";
  if (reasons.has("no_candidates_after_filter")) return "no_candidates_after_filter";
  if (snapshot.perGame.length > 0 && snapshot.perGame.every((entry) => entry.reasons.includes("cooldown"))) return "cooldown";
  if (snapshot.perGame.length > 0 && snapshot.perGame.every((entry) => entry.reasons.includes("per_game_cap"))) return "max_throws_per_game";
  if (snapshot.perGame.length > 0 && snapshot.perGame.every((entry) => entry.reasons.includes("below_min_game_stake"))) return "below_min_game_stake";
  if (fallback && fallback !== "empty" && fallback !== "complete") return fallback;
  return fallback ?? "no_game";
}

function buildSearchSummary(params: {
  rawCount: number;
  filteredCount: number;
  limitedCount: number;
  plannedCount: number;
  examinedCount: number;
  maxCandidates: number | undefined;
  maxMillis: number | undefined;
  includeSlip1: boolean | undefined;
  candidateFilterSummary: CandidateFilterSummary;
}) {
  return {
    generatedCandidates: params.rawCount,
    eligibleCandidates: params.filteredCount,
    limitedCandidates: params.limitedCount,
    plannedCandidates: params.plannedCount,
    examinedCount: params.examinedCount,
    maxCandidates: params.maxCandidates,
    maxMillis: params.maxMillis,
    includeSlip1: params.includeSlip1,
    candidateFilterSummary: params.candidateFilterSummary,
  };
}

function setManagerSnapshots(snapshot: LatestEligibilitySnapshot, candidateContext: LatestCandidateContext): void {
  setLatestEligibilitySnapshot(snapshot);
  setLatestCandidateContext(candidateContext);
}

function estimateKnownWalletUsd(
  balances: Record<string, string>,
  simInput: SimRunInput,
  priceHintsUsdPerBase?: Record<string, number>,
): number {
  return Object.entries(balances || {}).reduce((sum, [assetHex, amount]) => {
    const usd = estimateCandidateUsd(String(amount), cleanHex(assetHex), simInput, priceHintsUsdPerBase);
    return usd == null ? sum : sum + usd;
  }, 0);
}

function dedupeCandidates(candidates: Candidate[]): Candidate[] {
  const seen = new Set<string>();
  const deduped: Candidate[] = [];
  for (const candidate of candidates) {
    const key = hashCandidate(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(candidate);
  }
  return deduped;
}

function managerCandidateScenarioOverrides(
  simInput: SimRunInput,
  nextAcceptedHeight: number,
  candidateSpec: ManagerCandidateSpec | undefined,
  includeSlip1: boolean | undefined,
): PlannerScenarioOverride[] | undefined {
  if (!candidateSpec?.futureScenarios?.length) return undefined;

  const defaultScenarios = buildQueueScenarioSet(simInput, nextAcceptedHeight)
    .filter((scenario, index) => includeSlip1 !== false || index === 0)
    .map((scenario) => ({
      ...scenario,
      futureThrows: [],
    }));

  const customScenarios: PlannerScenarioOverride[] = candidateSpec.futureScenarios
    .filter((scenario) => (scenario.futureThrows ?? []).some((futureThrow) => futureThrow.enabled !== false))
    .map((scenario, index) => ({
      label: scenario.label || scenario.id || `manager-scenario-${index + 1}`,
      enterFrame: defaultScenarios[0]?.enterFrame ?? 0,
      acceptedAtHeight: nextAcceptedHeight,
      weight: Number.isFinite(Number(scenario.weight)) ? Number(scenario.weight) : 1,
      futureThrows: (scenario.futureThrows ?? [])
        .filter((futureThrow) => futureThrow.enabled !== false)
        .map((futureThrow) => ({
          x: futureThrow.x,
          y: futureThrow.y,
          angleDeg: futureThrow.angleDeg,
          speedPct: futureThrow.speedPct,
          spinPct: futureThrow.spinPct,
          asset: futureThrow.asset,
          amount: futureThrow.amount,
          user: futureThrow.user,
          label: futureThrow.label,
          enterFrameOffset: futureThrow.enterFrameOffset,
          acceptedAtHeightOffset: futureThrow.acceptedAtHeightOffset,
        })),
    }));

  return [...defaultScenarios, ...customScenarios];
}

function buildCandidateContextRows(rows: RankedCandidate[]): RankedCandidateContext[] {
  return rows.slice(0, 10).map((row, index) => {
    const meta = extractRankedCandidateMeta(row);
    if (!meta) {
      throw new Error("missing ranked candidate metadata");
    }
    return {
      rank: index + 1,
      candidateHash: meta.candidateHash,
      candidate: { ...row.candidate },
      baseScore: meta.baseScore,
      adjustedScore: meta.adjustedScore,
      basePrediction: meta.basePrediction,
      adjustedPrediction: meta.adjustedPrediction,
      overlay: {
        active: meta.overlayActive,
        scoreDelta: meta.overlayScoreDelta,
        adjustments: meta.overlayAdjustments,
      },
    };
  });
}

function buildManagerNotes(managerCandidateSet: ManagerCandidateSet | null, managerCandidates: Candidate[]): string[] {
  if (!managerCandidateSet) return [];
  const futureScenarioCount = (managerCandidateSet.candidates ?? []).reduce(
    (sum, candidate) => sum + (candidate.futureScenarios?.length ?? 0),
    0,
  );
  return [
    `managerCandidateSetId=${managerCandidateSet.id}`,
    `managerCandidatesEnabled=${managerCandidates.length}`,
    `managerFutureScenarios=${futureScenarioCount}`,
  ];
}

function buildBaseCandidateContext(
  ts: string,
  gameId: string | null,
  stoppedBy: string | null,
  managerCandidateSet: ManagerCandidateSet | null,
): LatestCandidateContext {
  return {
    ts,
    gameId,
    stoppedBy,
    winnerCandidateHash: null,
    overlay: getManagerOverlay(),
    managerCandidateSet,
    candidates: [],
  };
}

function shuffleRankedRows<T>(rows: T[]): T[] {
  const out = [...rows];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export async function runAgentOnce(
  client: ColliderClientLike,
  wasm: WasmVizRuntime,
  policy: AgentPolicy,
  cfg: LoopConfig,
): Promise<RunOnceResult> {
  const nowIso = new Date().toISOString();
  const games = cfg.prefetchedGames ?? await client.listGames(cfg.gameStatusMask);
  const { entries: perGame, selectedGame: defaultSelectedGame } = evaluateGamesForEligibility(games, policy, cfg.sessionEligibility);
  const preferredGameId = String(cfg.preferredGameId || '').trim();
  const selectedGame = preferredGameId
    ? (games.find((game) => String(game.game_id) === preferredGameId && perGame.find((entry) => entry.gameId === game.game_id)?.eligible) ?? defaultSelectedGame)
    : defaultSelectedGame;
  const managerCandidateSet = getManagerCandidateSet();

  if (!selectedGame) {
    const snapshot: LatestEligibilitySnapshot = {
      ts: nowIso,
      globalReasons: uniqueReasons(perGame.flatMap((entry) => entry.reasons.length ? entry.reasons : ["no_game"])),
      selectedGameId: null,
      perGame,
      assetPlanning: [],
      candidateFilterSummary: emptyCandidateFilterSummary(),
      notes: buildManagerNotes(managerCandidateSet, []),
    };
    const eligibilityCode = buildEligibilityCompactCode(snapshot);
    const stoppedBy = deriveStoppedBy(snapshot, "no_game");
    setManagerSnapshots(snapshot, buildBaseCandidateContext(nowIso, null, stoppedBy, managerCandidateSet));

    if (cfg.storage) {
      await appendRunLog(cfg.storage, {
        ts: nowIso,
        sessionId: cfg.sessionId,
        mode: cfg.dryRun ? "dry-run" : "live",
        gameId: null,
        botUser: cfg.botUser,
        submitted: false,
        stoppedBy,
        eligibilityCode,
        eligibility: {
          globalReasons: snapshot.globalReasons,
          perGame,
          assetPlanning: [],
        },
        search: buildSearchSummary({
          rawCount: 0,
          filteredCount: 0,
          limitedCount: 0,
          plannedCount: 0,
          examinedCount: 0,
          maxCandidates: cfg.candidateBudget?.maxCandidates,
          maxMillis: cfg.candidateBudget?.maxMillis,
          includeSlip1: cfg.includeSlip1,
          candidateFilterSummary: snapshot.candidateFilterSummary,
        }),
        top: [],
      });
    }

    return {
      decisionId: null,
      gameId: null,
      winnerSubmitted: false,
      top: [],
      eligibilityCode,
      stoppedBy,
    };
  }

  const gameId = selectedGame.game_id;
  const game = await client.getGame(gameId);
  const simInput = await client.getSimInput(gameId);
  const balances = await client.getBalances(cfg.botUser);
  const priceHintsUsdPerBase = await buildPriceHintsUsdPerBase({
    client,
    games,
    selectedGameId: gameId,
    selectedSimInput: simInput,
    policy,
    defaultAsset: cfg.defaultAsset,
  });
  const knownWalletUsd = estimateKnownWalletUsd(balances, simInput, priceHintsUsdPerBase);

  if (policy.targetBalanceUsd != null && knownWalletUsd >= policy.targetBalanceUsd) {
    const snapshot: LatestEligibilitySnapshot = {
      ts: nowIso,
      globalReasons: ["target_balance"],
      selectedGameId: gameId,
      perGame,
      assetPlanning: [],
      candidateFilterSummary: emptyCandidateFilterSummary(),
      notes: [...buildManagerNotes(managerCandidateSet, []), `knownWalletUsd=${knownWalletUsd.toFixed(6)}`],
    };
    const eligibilityCode = buildEligibilityCompactCode(snapshot);
    const stoppedBy = deriveStoppedBy(snapshot, "target_balance");
    setManagerSnapshots(snapshot, buildBaseCandidateContext(nowIso, gameId, stoppedBy, managerCandidateSet));

    if (cfg.storage) {
      await appendRunLog(cfg.storage, {
        ts: nowIso,
        sessionId: cfg.sessionId,
        mode: cfg.dryRun ? "dry-run" : "live",
        gameId,
        botUser: cfg.botUser,
        submitted: false,
        stoppedBy,
        eligibilityCode,
        game: {
          throws: selectedGame.throws,
          stake: selectedGame.stake,
          minThrowValue: selectedGame.throw_min_value,
          status: selectedGame.status,
        },
        eligibility: {
          globalReasons: snapshot.globalReasons,
          perGame,
          assetPlanning: [],
        },
        search: buildSearchSummary({
          rawCount: 0,
          filteredCount: 0,
          limitedCount: 0,
          plannedCount: 0,
          examinedCount: 0,
          maxCandidates: cfg.candidateBudget?.maxCandidates,
          maxMillis: cfg.candidateBudget?.maxMillis,
          includeSlip1: cfg.includeSlip1,
          candidateFilterSummary: snapshot.candidateFilterSummary,
        }),
        top: [],
      });
    }

    return {
      decisionId: null,
      gameId,
      winnerSubmitted: false,
      top: [],
      eligibilityCode,
      stoppedBy,
    };
  }

  const ib = simInput.map.physicsConfig.input_bounds;
  const bounds = {
    min_x: ib[0],
    min_y: ib[1],
    max_x: ib[2],
    max_y: ib[3],
  };

  const assetPlanning = buildAssetPlanningResult({
    policy,
    balances,
    simInput,
    defaultAsset: cfg.defaultAsset,
    defaultAmount: cfg.defaultAmount,
    priceHintsUsdPerBase,
  });

  const managerCandidates = buildManagerCandidates(managerCandidateSet);
  const managerCandidateSpecs = buildManagerCandidateSpecMap(managerCandidateSet);

  const rawCandidateGroups = await Promise.all(assetPlanning.assetAmountPairs.map(async ({ asset, amount }) => {
    const grid = generateGridCandidates(bounds, {
      xSteps: cfg.candidateGen?.xSteps ?? 3,
      ySteps: cfg.candidateGen?.ySteps ?? 2,
      angleDegs: cfg.candidateGen?.angleDegs,
      speedPcts: cfg.candidateGen?.speedPcts,
      spinPcts: cfg.candidateGen?.spinPcts,
      asset,
      amount,
    });
    const copied = policy.copySlammerWhenSameHoleType || String(policy.customStrategy || '').trim().toLowerCase() === 'copy_slammers'
      ? await loadHistoricalWinningSeeds(cfg.storage, asset, amount)
      : [];
    return [...copied, ...grid];
  }));

  const rawCandidates = dedupeCandidates([...rawCandidateGroups.flat(), ...managerCandidates]);
  const reasonCounts: CandidateFilterSummary["reasonCounts"] = {};
  const filtered: Candidate[] = [];
  for (const candidate of rawCandidates) {
    const reasons = getCandidateFilterReasons({
      candidate,
      chosenGame: selectedGame,
      policy,
      simInput,
      balances,
      priceHintsUsdPerBase,
    });
    if (reasons.length === 0) {
      filtered.push(candidate);
      continue;
    }
    for (const reason of reasons) incrementReasonCount(reasonCounts, reason);
  }

  const maxCandidates = cfg.candidateBudget?.maxCandidates ?? filtered.length;
  const shuffled = shuffleCandidates(filtered);
  const limited = shuffled.slice(0, maxCandidates);
  const nextAcceptedHeight = nextAcceptedHeightFromGame(game);

  const plannedSettled = await Promise.allSettled(
    limited.map((control) => {
      const candidateHash = hashCandidate(control);
      const managerSpec = managerCandidateSpecs.get(candidateHash);
      return runCandidateAcrossQueueScenarios(
        wasm,
        gameId,
        cfg.botUser,
        simInput,
        control,
        {
          nextAcceptedHeight,
          includeSlip1: cfg.includeSlip1 ?? true,
          scenarioOverrides: managerCandidateScenarioOverrides(
            simInput,
            nextAcceptedHeight,
            managerSpec,
            cfg.includeSlip1,
          ),
        },
      );
    }),
  );

  const planned: Awaited<ReturnType<typeof runCandidateAcrossQueueScenarios>>[] = [];
  let plannerFailureCount = 0;
  for (const result of plannedSettled) {
    if (result.status !== "fulfilled") {
      plannerFailureCount += 1;
      continue;
    }
    if (!Array.isArray(result.value?.perScenario) || result.value.perScenario.length === 0) {
      plannerFailureCount += 1;
      continue;
    }
    planned.push(result.value);
  }

  const overlay = getManagerOverlay();
  const baseRanked = rankPlannedCandidates(planned, cfg.scoreConfig);
  const contextualRanked: RankedCandidate[] = baseRanked.map((row) => {
    const plan = planned.find((candidatePlan) => samePlannedControl(candidatePlan.control, row.candidate)) ?? null;
    const basePrediction = plan ? summarizePredictionFromPlan(plan, cfg.botUser) : null;
    const candidateHash = hashCandidate(row.candidate);
    const baseScore = scoreViewFromRobustScore(row.score);
    const overlayApplication = applyOverlayToCandidate({
      overlay,
      candidate: row.candidate,
      candidateHash,
      baseScore,
      basePrediction,
    });

    return {
      ...row,
      score: {
        ...row.score,
        weightedTotal: overlayApplication.adjustedScore.weightedTotal,
        worstCaseTotal: overlayApplication.adjustedScore.worstCaseTotal,
        bestCaseTotal: overlayApplication.adjustedScore.bestCaseTotal,
        fragilityPenalty: overlayApplication.adjustedScore.fragilityPenalty,
        final: overlayApplication.adjustedScore.final,
      },
      meta: {
        ...row.meta,
        candidateHash,
        baseScore,
        adjustedScore: overlayApplication.adjustedScore,
        basePrediction,
        adjustedPrediction: overlayApplication.adjustedPrediction,
        overlayActive: overlayApplication.active,
        overlayScoreDelta: overlayApplication.scoreDelta,
        overlayAdjustments: overlayApplication.adjustments,
      },
    };
  }).sort((a, b) => b.score.final - a.score.final);

  const rankedForSelection = cfg.selectionMode === "random"
    ? shuffleRankedRows(contextualRanked)
    : contextualRanked;
  let chosen = chooseBestRanked(rankedForSelection, cfg.candidateBudget);
  if (cfg.selectionMode === "random" && chosen.ranked.length > 0) {
    chosen = {
      ...chosen,
      winner: chosen.ranked[Math.floor(Math.random() * chosen.ranked.length)] ?? chosen.winner,
    };
  }
  const candidateFilterSummary: CandidateFilterSummary = {
    reasonCounts,
    totalRawCandidates: rawCandidates.length,
    totalEligibleCandidates: filtered.length,
    limitedCandidates: limited.length,
    plannedCandidates: planned.length,
  };

  const globalReasons = [...assetPlanning.globalReasons];
  if (reasonCounts.reserve_balance) globalReasons.push("reserve_balance");
  if (reasonCounts.no_balance_for_amounts) globalReasons.push("no_balance_for_amounts");
  if (reasonCounts.missing_price_basis) globalReasons.push("missing_price_basis");
  if (reasonCounts.asset_not_allowed) globalReasons.push("asset_not_allowed");
  if (reasonCounts.asset_blocked) globalReasons.push("asset_blocked");
  if (filtered.length === 0) globalReasons.push("no_candidates_after_filter");
  if (chosen.stoppedBy === "budget_time" || chosen.stoppedBy === "budget_candidates") globalReasons.push("search_budget_stop");
  if (limited.length > 0 && planned.length === 0) globalReasons.push("search_budget_stop");

  const eligibilitySnapshot: LatestEligibilitySnapshot = {
    ts: nowIso,
    globalReasons: uniqueReasons(globalReasons),
    selectedGameId: gameId,
    perGame,
    assetPlanning: assetPlanning.entries,
    candidateFilterSummary,
    notes: [
      ...buildManagerNotes(managerCandidateSet, managerCandidates),
      ...(plannerFailureCount > 0 ? [`plannerFailedCandidates=${plannerFailureCount}/${limited.length || 0}`] : []),
    ],
  };
  const eligibilityCode = buildEligibilityCompactCode(eligibilitySnapshot);

  const candidateContextRows = buildCandidateContextRows(chosen.ranked);
  const topDetailed = candidateContextRows.map((context) => buildCandidateContextLogView(context));
  const top: TopCandidateView[] = chosen.ranked.slice(0, 5).map((row, index) => {
    const meta = extractRankedCandidateMeta(row);
    if (!meta) {
      throw new Error("missing top candidate metadata");
    }
    return buildTopView(index + 1, row.candidate, meta.adjustedScore);
  });

  const winnerMeta = extractRankedCandidateMeta(chosen.winner);
  const stoppedBy = deriveStoppedBy(eligibilitySnapshot, chosen.stoppedBy);

  setManagerSnapshots(eligibilitySnapshot, {
    ts: nowIso,
    gameId,
    stoppedBy,
    winnerCandidateHash: winnerMeta?.candidateHash ?? null,
    overlay,
    managerCandidateSet,
    candidates: candidateContextRows,
  });

  if (!chosen.winner) {
    printCycleSummary(selectedGame, top, stoppedBy, false);

    if (cfg.storage) {
      await appendRunLog(cfg.storage, {
        ts: nowIso,
        sessionId: cfg.sessionId,
        mode: cfg.dryRun ? "dry-run" : "live",
        gameId,
        botUser: cfg.botUser,
        submitted: false,
        stoppedBy,
        eligibilityCode,
        game: {
          throws: selectedGame.throws,
          stake: selectedGame.stake,
          minThrowValue: selectedGame.throw_min_value,
          status: selectedGame.status,
        },
        eligibility: {
          globalReasons: eligibilitySnapshot.globalReasons,
          perGame,
          assetPlanning: assetPlanning.entries,
        },
        search: buildSearchSummary({
          rawCount: rawCandidates.length,
          filteredCount: filtered.length,
          limitedCount: limited.length,
          plannedCount: planned.length,
          examinedCount: chosen.examinedCount,
          maxCandidates: cfg.candidateBudget?.maxCandidates,
          maxMillis: cfg.candidateBudget?.maxMillis,
          includeSlip1: cfg.includeSlip1,
          candidateFilterSummary,
        }),
        top,
        topDetailed,
      });
    }

    return {
      decisionId: null,
      gameId,
      winnerSubmitted: false,
      top,
      eligibilityCode,
      stoppedBy,
    };
  }

  const winnerCandidate = chosen.winner.candidate;
  const decisionId = makeDecisionId();
  const winnerPayload = controlThrowToPlaceThrowArgs(
    gameId,
    cfg.botUser,
    winnerCandidate,
    simInput,
  );
  const winnerPlan = planned.find((candidatePlan) => samePlannedControl(candidatePlan.control, winnerCandidate)) ?? null;
  if (!winnerPlan) {
    throw new Error("missing winner plan for prediction commit");
  }

  const predictionCommitBundle = buildPredictionCommitBundle({
    createdAt: nowIso,
    sessionId: cfg.sessionId,
    decisionId,
    gameId,
    botUser: cfg.botUser,
    candidateHash: winnerMeta?.candidateHash ?? null,
    plan: winnerPlan,
    simInput,
    agentProfile: cfg.agentProfile ?? null,
  });
  const predictionCoverage = toPredictionCoverageLogView(predictionCommitBundle.payload);
  const predictionCommit = cfg.storage
    ? await writeArtifactJson({
        dir: cfg.storage.predictionCommitsDir,
        schema: predictionCommitBundle.payload.schema,
        payload: predictionCommitBundle.payload,
      })
    : buildArtifactRefFromPayload(predictionCommitBundle.payload.schema, predictionCommitBundle.payload);
  const winnerPrediction = predictionCommitBundle.summary ?? winnerMeta?.basePrediction ?? null;

  winnerPayload.data_commit = predictionCommit.sha256Hex;

  if (!cfg.dryRun) {
    console.log("SUBMIT winnerPayload:", JSON.stringify(winnerPayload, null, 2));
    await client.placeThrow(winnerPayload);
  }

  printCycleSummary(selectedGame, top, stoppedBy, !cfg.dryRun);

  if (cfg.storage) {
    await appendRunLog(cfg.storage, {
      ts: nowIso,
      sessionId: cfg.sessionId,
      mode: cfg.dryRun ? "dry-run" : "live",
      gameId,
      botUser: cfg.botUser,
      submitted: !cfg.dryRun,
      stoppedBy,
      eligibilityCode,
      game: {
        throws: selectedGame.throws,
        stake: selectedGame.stake,
        minThrowValue: selectedGame.throw_min_value,
        status: selectedGame.status,
      },
      eligibility: {
        globalReasons: eligibilitySnapshot.globalReasons,
        perGame,
        assetPlanning: assetPlanning.entries,
      },
      search: buildSearchSummary({
        rawCount: rawCandidates.length,
        filteredCount: filtered.length,
        limitedCount: limited.length,
        plannedCount: planned.length,
        examinedCount: chosen.examinedCount,
        maxCandidates: cfg.candidateBudget?.maxCandidates,
        maxMillis: cfg.candidateBudget?.maxMillis,
        includeSlip1: cfg.includeSlip1,
        candidateFilterSummary,
      }),
      top,
      topDetailed,
      chosenPayload: winnerPayload,
      prediction: toPredictionLogView(winnerPrediction, {
        predictionCommit,
        coverage: predictionCoverage,
      }),
      basePrediction: toPredictionLogView(winnerPrediction, {
        predictionCommit,
        coverage: predictionCoverage,
      }),
      managerAdjustedPrediction: toPredictionLogView(winnerMeta?.adjustedPrediction),
      baseScore: winnerMeta?.baseScore,
      adjustedScore: winnerMeta?.adjustedScore,
      overlay: toOverlayLogView(winnerMeta),
      predictionCommit,
    });

    await appendThrowLog(cfg.storage, {
      ts: nowIso,
      sessionId: cfg.sessionId,
      decisionId,
      gameId,
      botUser: cfg.botUser,
      submitted: !cfg.dryRun,
      dryRun: !!cfg.dryRun,
      eligibilityCode,
      candidateHash: winnerMeta?.candidateHash,
      payload: winnerPayload,
      score: winnerMeta?.adjustedScore,
      baseScore: winnerMeta?.baseScore,
      adjustedScore: winnerMeta?.adjustedScore,
      prediction: toPredictionLogView(winnerPrediction, {
        predictionCommit,
        coverage: predictionCoverage,
      }),
      basePrediction: toPredictionLogView(winnerPrediction, {
        predictionCommit,
        coverage: predictionCoverage,
      }),
      managerAdjustedPrediction: toPredictionLogView(winnerMeta?.adjustedPrediction),
      overlay: toOverlayLogView(winnerMeta),
      predictionCommit,
    });
  }

  return {
    decisionId,
    gameId,
    winnerSubmitted: !cfg.dryRun,
    winnerPayload,
    winnerCandidateHash: winnerMeta?.candidateHash ?? null,
    predictionCommit,
    predictionCommitPayload: predictionCommitBundle.payload,
    top,
    eligibilityCode,
    stoppedBy,
  };
}

