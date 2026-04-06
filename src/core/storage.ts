import { mkdir, appendFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { AssetPlanningEntry, CandidateFilterSummary, GameEligibilityEntry } from "../agent/eligibility.js";
import type { OverlayAdjustment, ScoreView } from "../strategy/tactical-overlay.js";

export type StoragePaths = {
  rootDir: string;
  runsFile: string;
  throwsFile: string;
  resultsFile: string;
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
};

export type ResultLogRow = {
  ts: string;
  sessionId: string;
  decisionId: string;
  gameId: string;
  botUser: string;
  actual?: Record<string, unknown>;
  expected?: Record<string, unknown>;
};

export function makeSessionId(): string {
  return crypto.randomBytes(8).toString("hex");
}

export function makeDecisionId(): string {
  return crypto.randomBytes(10).toString("hex");
}

export async function initStorage(rootDir = "./data"): Promise<StoragePaths> {
  await mkdir(rootDir, { recursive: true });

  return {
    rootDir,
    runsFile: path.join(rootDir, "runs.jsonl"),
    throwsFile: path.join(rootDir, "throws.jsonl"),
    resultsFile: path.join(rootDir, "results.jsonl"),
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
