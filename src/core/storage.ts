import { mkdir, appendFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { AssetPlanningEntry, CandidateFilterSummary, GameEligibilityEntry } from "../agent/eligibility.js";
import type { ManagerAdviceEvidence, OverlayAdjustment, ScoreView } from "../strategy/tactical-overlay.js";
import type { SignedThrowResult } from "../collider/types.js";
import { buildContentAddressRefFromJson, type ContentAddressRef } from "./content-address.js";
import {
  ensurePendingDecisionIndex,
  recordPendingDecision,
  recordResolvedDecision,
} from "./pending-decisions.js";

export type StoragePaths = {
  rootDir: string;
  archiveDir: string;
  runsFile: string;
  throwsFile: string;
  resultsFile: string;
  gameThrowsDir: string;
  gameResultsDir: string;
  predictionCommitsDir: string;
  predictionRevealsDir: string;
  maxActiveLogBytes: number;
};

export type ArtifactLogRef = ContentAddressRef & {
  schema: string;
  localPath: string;
};

export type PredictionCoverageLogView = {
  knownExistingThrowsTotal?: number;
  predictedTrackedThrowsTotal?: number;
  predictedUsersTotal?: number;
  predictedThrows?: number;
  evaluatedThrows?: number;
  outcomeCoveragePct?: number | null;
  valueCoveragePct?: number | null;
  gameCoveragePct?: number | null;
  temporalCoveragePct?: number | null;
  snapshotCount?: number;
  predictedGameTotals?: boolean;
  predictedTemporal?: boolean;
  predictedDynamicUpdates?: number;
  knownFutureUnknownThrowsMode?: string;
};

export type PredictionLogView = {
  pnlUsd?: number | null;
  bestPnlUsd?: number | null;
  worstPnlUsd?: number | null;
  scenarioCount?: number;
  winnerScenarioCount?: number;
  winnerValuePct?: number | null;
  holeType?: number | null;
  holeTypeCounts?: Record<string, number>;
  valueUsd?: number | null;
  valueUsdE8?: string | null;
  massUsd?: number | null;
  predictionCommit?: ArtifactLogRef | null;
  coverage?: PredictionCoverageLogView | null;
};

export type HonestScoreLogView = {
  schema: string;
  honestScore?: number | null;
  bce?: number | null;
  rps?: number | null;
  temporalError?: number | null;
  coverage?: PredictionCoverageLogView | null;
  sharpness?: {
    outcome?: number | null;
    value?: number | null;
    temporal?: number | null;
    focalOutcome?: number | null;
    focalValue?: number | null;
    focalTemporal?: number | null;
  };
  layers?: {
    outcome?: {
      score?: number | null;
      error?: number | null;
      evaluatedThrows?: number;
      predictedThrows?: number;
    };
    value?: {
      score?: number | null;
      error?: number | null;
      evaluatedThrows?: number;
      predictedThrows?: number;
    };
    game?: {
      score?: number | null;
      error?: number | null;
      actualFinalFrame?: number | null;
      predictedFinalFrame?: number | null;
      actualBotPnlUsd?: number | null;
      predictedBotPnlUsd?: number | null;
      actualReturnedUsdSum?: number | null;
      predictedReturnedUsdSum?: number | null;
    };
    temporal?: {
      score?: number | null;
      endFrameMae?: number | null;
      dynamicShiftError?: number | null;
      horizonAccuracy?: number | null;
      certaintyBreach?: number | null;
      evaluatedThrows?: number;
      predictedThrows?: number;
      historyPoints?: number;
      dynamicUpdates?: number;
    };
  };
};

export type OverlayLogView = {
  active: boolean;
  scoreDelta: number;
  adjustments: OverlayAdjustment[];
  policyId?: string | null;
  withoutOverlayWinnerHash?: string | null;
};

export type CandidateContextLogView = {
  rank: number;
  candidateHash: string;
  source: string;
  asset: string;
  amount: string;
  x: number;
  y: number;
  angleDeg: number;
  speedPct: number;
  spinPct: number;
  baseScore: ScoreView;
  adjustedScore: ScoreView;
  basePrediction?: PredictionLogView | null;
  managerAdjustedPrediction?: PredictionLogView | null;
  overlay: OverlayLogView;
};

export type RunLogRow = {
  managerAdvice?:ManagerAdviceEvidence;
  ts: string;
  sessionId: string;
  mode: "dry-run" | "live";
  gameId: string | null;
  botUser: string;
  submitted: boolean;
  signedIntent?: SignedThrowResult | null;
  stoppedBy?: string;
  eligibilityCode?: string;
  game?: {
    throws?: number;
    stake?: string;
    minThrowValue?: string;
    status?: number;
  };
  eligibility?: {
    globalReasons?: string[];
    perGame?: GameEligibilityEntry[];
    assetPlanning?: AssetPlanningEntry[];
  };
  search?: {
    generatedCandidates?: number;
    eligibleCandidates?: number;
    limitedCandidates?: number;
    plannedCandidates?: number;
    examinedCount?: number;
    maxCandidates?: number;
    maxMillis?: number;
    includeSlip1?: boolean;
    candidateFilterSummary?: CandidateFilterSummary;
  };
  top: Array<{
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
  }>;
  topDetailed?: CandidateContextLogView[];
  chosenPayload?: unknown;
  prediction?: PredictionLogView;
  basePrediction?: PredictionLogView;
  managerAdjustedPrediction?: PredictionLogView;
  baseScore?: ScoreView;
  adjustedScore?: ScoreView;
  overlay?: OverlayLogView;
  predictionCommit?: ArtifactLogRef;
};

export type ThrowLogRow = {
  managerAdvice?:ManagerAdviceEvidence;
  ts: string;
  sessionId: string;
  decisionId: string;
  gameId: string;
  botUser: string;
  submitted: boolean;
  signedIntent?: SignedThrowResult | null;
  dryRun: boolean;
  eligibilityCode?: string;
  candidateHash?: string;
  payload: unknown;
  score?: ScoreView;
  baseScore?: ScoreView;
  adjustedScore?: ScoreView;
  prediction?: PredictionLogView;
  basePrediction?: PredictionLogView;
  managerAdjustedPrediction?: PredictionLogView;
  overlay?: OverlayLogView;
  predictionCommit?: ArtifactLogRef;
};

export type ResultLogRow = {
  ts: string;
  sessionId: string;
  decisionId: string;
  gameId: string;
  botUser: string;
  actual?: Record<string, unknown>;
  expected?: Record<string, unknown>;
  predictionCommit?: ArtifactLogRef;
  predictionReveal?: ArtifactLogRef;
  honestScore?: HonestScoreLogView;
};

export function makeSessionId(): string {
  return crypto.randomBytes(8).toString("hex");
}

export function makeDecisionId(): string {
  return crypto.randomBytes(10).toString("hex");
}

export async function initStorage(
  rootDir = "./data",
  options: { maxActiveLogBytes?: number } = {},
): Promise<StoragePaths> {
  await mkdir(rootDir, { recursive: true });
  const archiveDir = path.join(rootDir, "archive");
  const predictionCommitsDir = path.join(rootDir, "prediction-commits");
  const predictionRevealsDir = path.join(rootDir, "prediction-reveals");
  const gameThrowsDir = path.join(rootDir, "game-history", "throws");
  const gameResultsDir = path.join(rootDir, "game-history", "results");
  await mkdir(archiveDir, { recursive: true });
  await mkdir(predictionCommitsDir, { recursive: true });
  await mkdir(predictionRevealsDir, { recursive: true });
  await mkdir(gameThrowsDir, { recursive: true });
  await mkdir(gameResultsDir, { recursive: true });

  const paths: StoragePaths = {
    rootDir,
    archiveDir,
    runsFile: path.join(rootDir, "runs.jsonl"),
    throwsFile: path.join(rootDir, "throws.jsonl"),
    resultsFile: path.join(rootDir, "results.jsonl"),
    gameThrowsDir,
    gameResultsDir,
    predictionCommitsDir,
    predictionRevealsDir,
    maxActiveLogBytes: Math.max(1024 * 1024, options.maxActiveLogBytes ?? 64 * 1024 * 1024),
  };
  await ensurePendingDecisionIndex(paths);
  return paths;
}

const appendQueues = new Map<string, Promise<void>>();

async function rotateIfNeeded(paths: StoragePaths, file: string, incomingBytes: number): Promise<void> {
  // Runs are presentation/search diagnostics and can be segmented safely.
  // Throw/result logs remain active until their per-game history index lands,
  // preserving current HPS and settlement lookup semantics.
  if (file !== paths.runsFile) return;
  let currentBytes = 0;
  try {
    currentBytes = (await stat(file)).size;
  } catch {
    return;
  }
  if (currentBytes === 0 || currentBytes + incomingBytes <= paths.maxActiveLogBytes) return;
  const parsed = path.parse(file);
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
  const archive = path.join(paths.archiveDir, `${parsed.name}.${stamp}.${crypto.randomBytes(4).toString("hex")}.jsonl`);
  await rename(file, archive);
}

async function appendJsonLine(paths: StoragePaths, file: string, row: unknown): Promise<void> {
  const line = `${JSON.stringify(row)}\n`;
  const previous = appendQueues.get(file) ?? Promise.resolve();
  const current = previous.then(async () => {
    await rotateIfNeeded(paths, file, Buffer.byteLength(line));
    await appendFile(file, line, "utf8");
  });
  appendQueues.set(file, current.catch(() => undefined));
  await current;
}

export async function appendRunLog(paths: StoragePaths, row: RunLogRow): Promise<void> {
  await appendJsonLine(paths, paths.runsFile, row);
}

export function gameHistoryFile(paths: StoragePaths, kind: "throws" | "results", gameId: string): string {
  const clean = String(gameId ?? "").trim().toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{64}$/.test(clean)) throw new Error("game history requires a canonical 32-byte game id");
  return path.join(kind === "throws" ? paths.gameThrowsDir : paths.gameResultsDir, clean + ".jsonl");
}

export async function appendThrowLog(paths: StoragePaths, row: ThrowLogRow): Promise<void> {
  await appendJsonLine(paths, paths.throwsFile, row);
  await appendJsonLine(paths, gameHistoryFile(paths, "throws", row.gameId), row);
  await recordPendingDecision(paths, row);
}

export async function appendResultLog(paths: StoragePaths, row: ResultLogRow): Promise<void> {
  await appendJsonLine(paths, paths.resultsFile, row);
  await appendJsonLine(paths, gameHistoryFile(paths, "results", row.gameId), row);
  await recordResolvedDecision(paths, row);
}

export async function writeArtifactJson(params: {
  dir: string;
  schema: string;
  payload: unknown;
}): Promise<ArtifactLogRef> {
  const { dir, schema, payload } = params;
  await mkdir(dir, { recursive: true });
  const addressed = buildContentAddressRefFromJson(payload);
  const localPath = path.join(dir, `${addressed.cid}.json`);
  await writeFile(localPath, addressed.canonicalJson, "utf8");
  return {
    schema,
    sha256Hex: addressed.sha256Hex,
    cid: addressed.cid,
    ipfsUri: addressed.ipfsUri,
    bytes: addressed.bytes,
    localPath,
  };
}
