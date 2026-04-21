import { mkdir, appendFile, writeFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { AssetPlanningEntry, CandidateFilterSummary, GameEligibilityEntry } from "../agent/eligibility.js";
import type { OverlayAdjustment, ScoreView } from "../strategy/tactical-overlay.js";
import { buildContentAddressRefFromJson, type ContentAddressRef } from "./content-address.js";

export type StoragePaths = {
  rootDir: string;
  runsFile: string;
  throwsFile: string;
  resultsFile: string;
  predictionCommitsDir: string;
  predictionRevealsDir: string;
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
  ts: string;
  sessionId: string;
  mode: "dry-run" | "live";
  gameId: string | null;
  botUser: string;
  submitted: boolean;
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
  ts: string;
  sessionId: string;
  decisionId: string;
  gameId: string;
  botUser: string;
  submitted: boolean;
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

export async function initStorage(rootDir = "./data"): Promise<StoragePaths> {
  await mkdir(rootDir, { recursive: true });
  const predictionCommitsDir = path.join(rootDir, "prediction-commits");
  const predictionRevealsDir = path.join(rootDir, "prediction-reveals");
  await mkdir(predictionCommitsDir, { recursive: true });
  await mkdir(predictionRevealsDir, { recursive: true });

  return {
    rootDir,
    runsFile: path.join(rootDir, "runs.jsonl"),
    throwsFile: path.join(rootDir, "throws.jsonl"),
    resultsFile: path.join(rootDir, "results.jsonl"),
    predictionCommitsDir,
    predictionRevealsDir,
  };
}

async function appendJsonLine(file: string, row: unknown): Promise<void> {
  await appendFile(file, `${JSON.stringify(row)}\n`, "utf8");
}

export async function appendRunLog(paths: StoragePaths, row: RunLogRow): Promise<void> {
  await appendJsonLine(paths.runsFile, row);
}

export async function appendThrowLog(paths: StoragePaths, row: ThrowLogRow): Promise<void> {
  await appendJsonLine(paths.throwsFile, row);
}

export async function appendResultLog(paths: StoragePaths, row: ResultLogRow): Promise<void> {
  await appendJsonLine(paths.resultsFile, row);
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
