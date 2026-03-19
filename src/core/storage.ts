import { mkdir, appendFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

export type StoragePaths = {
  rootDir: string;
  runsFile: string;
  throwsFile: string;
  resultsFile: string;
};

export type RunLogRow = {
  ts: string;
  sessionId: string;
  mode: "dry-run" | "live";
  gameId: string | null;
  botUser: string;
  submitted: boolean;
  stoppedBy?: string;
  game?: {
    throws?: number;
    stake?: string;
    minThrowValue?: string;
    status?: number;
  };
  search?: {
    generatedCandidates?: number;
    eligibleCandidates?: number;
    examinedCount?: number;
    maxCandidates?: number;
    maxMillis?: number;
    includeSlip1?: boolean;
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
  chosenPayload?: unknown;
};

export type ThrowLogRow = {
  ts: string;
  sessionId: string;
  decisionId: string;
  gameId: string;
  botUser: string;
  submitted: boolean;
  dryRun: boolean;
  payload: unknown;
  score?: {
    final?: number;
    weightedTotal?: number;
    worstCaseTotal?: number;
    bestCaseTotal?: number;
    fragilityPenalty?: number;
  };
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