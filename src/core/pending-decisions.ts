import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

import type { ArtifactLogRef, ResultLogRow, StoragePaths, ThrowLogRow } from "./storage.js";

export type PendingDecisionIndexRow = {
  decisionId: string;
  gameId: string;
  botUser: string;
  ts: string;
  payload: unknown;
  throwId?: string;
  predictionCommit?: ArtifactLogRef;
};

type PendingDecisionIndex = {
  identityVersion: 2;
  schema: "collider.agent1.pending-decisions.v1";
  rows: PendingDecisionIndexRow[];
  sourceBytes: {
    throws: number;
    results: number;
  };
  updatedAt: string;
};

const updateQueues = new Map<string, Promise<void>>();

function indexFile(paths: StoragePaths): string {
  return path.join(paths.rootDir, "pending-decisions.json");
}

async function scanJsonl(file: string, visit: (row: any) => void): Promise<void> {
  try {
    const stream = createReadStream(file, { encoding: "utf8" });
    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        visit(JSON.parse(trimmed));
      } catch {
        // Retain valid audit rows even if one line was interrupted.
      }
    }
  } catch {
    // A new data directory may not have either log yet.
  }
}

async function fileBytes(file: string): Promise<number> {
  try {
    return (await stat(file)).size;
  } catch {
    return 0;
  }
}

async function writeIndex(paths: StoragePaths, rows: PendingDecisionIndexRow[]): Promise<void> {
  const file = indexFile(paths);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const state: PendingDecisionIndex = {
    identityVersion: 2,
    schema: "collider.agent1.pending-decisions.v1",
    rows,
    sourceBytes: {
      throws: await fileBytes(paths.throwsFile),
      results: await fileBytes(paths.resultsFile),
    },
    updatedAt: new Date().toISOString(),
  };
  await writeFile(tmp, JSON.stringify(state), "utf8");
  await rename(tmp, file);
}

async function readIndex(paths: StoragePaths): Promise<PendingDecisionIndexRow[]> {
  try {
    const parsed = JSON.parse(await readFile(indexFile(paths), "utf8")) as Partial<PendingDecisionIndex>;
    return parsed.schema === "collider.agent1.pending-decisions.v1" && Array.isArray(parsed.rows)
      ? parsed.rows
      : [];
  } catch {
    return [];
  }
}

export async function ensurePendingDecisionIndex(paths: StoragePaths): Promise<void> {
  try {
    const parsed = JSON.parse(await readFile(indexFile(paths), "utf8")) as Partial<PendingDecisionIndex>;
    if (
      parsed.schema === "collider.agent1.pending-decisions.v1"
      && parsed.identityVersion === 2
      && Array.isArray(parsed.rows)
      && parsed.sourceBytes?.throws === await fileBytes(paths.throwsFile)
      && parsed.sourceBytes?.results === await fileBytes(paths.resultsFile)
    ) {
      return;
    }
  } catch {
    // Missing, stale, or interrupted index: rebuild once by streaming the logs.
  }
  await rebuildPendingDecisionIndex(paths);
}

export async function rebuildPendingDecisionIndex(paths: StoragePaths): Promise<void> {
  const submitted = new Map<string, PendingDecisionIndexRow>();
  const resolved = new Set<string>();
  await scanJsonl(paths.throwsFile, (row) => {
    const decisionId = String(row?.decisionId ?? "").trim();
    if (!decisionId || row?.submitted !== true || !row?.gameId || !row?.botUser) return;
    submitted.set(decisionId, {
      decisionId,
      gameId: String(row.gameId),
      botUser: String(row.botUser),
      ts: String(row.ts ?? ""),
      payload: row.payload ?? null,
      throwId: row.signedIntent?.throwId ?? undefined,
      predictionCommit: row.predictionCommit ?? undefined,
    });
  });
  await scanJsonl(paths.resultsFile, (row) => {
    const decisionId = String(row?.decisionId ?? "").trim();
    if (decisionId) resolved.add(decisionId);
  });
  await writeIndex(paths, [...submitted.values()].filter((row) => !resolved.has(row.decisionId)));
}

function queueIndexUpdate(paths: StoragePaths, update: (rows: PendingDecisionIndexRow[]) => PendingDecisionIndexRow[]): Promise<void> {
  const file = indexFile(paths);
  const previous = updateQueues.get(file) ?? Promise.resolve();
  const current = previous.then(async () => {
    await writeIndex(paths, update(await readIndex(paths)));
  });
  updateQueues.set(file, current.catch(() => undefined));
  return current;
}

export async function recordPendingDecision(paths: StoragePaths, row: ThrowLogRow): Promise<void> {
  if (!row.submitted) return;
  const indexed: PendingDecisionIndexRow = {
    decisionId: row.decisionId,
    gameId: row.gameId,
    botUser: row.botUser,
    ts: row.ts,
    payload: row.payload,
    throwId: row.signedIntent?.throwId ?? undefined,
    predictionCommit: row.predictionCommit,
  };
  await queueIndexUpdate(paths, (rows) => [
    ...rows.filter((entry) => entry.decisionId !== indexed.decisionId),
    indexed,
  ]);
}

export async function recordResolvedDecision(paths: StoragePaths, row: ResultLogRow): Promise<void> {
  await queueIndexUpdate(paths, (rows) => rows.filter((entry) => entry.decisionId !== row.decisionId));
}

export async function readPendingDecisions(
  paths: StoragePaths,
  botUser: string,
): Promise<PendingDecisionIndexRow[]> {
  const normalizedUser = String(botUser).toLowerCase().replace(/^0x/, "");
  return (await readIndex(paths))
    .filter((row) => String(row.botUser).toLowerCase().replace(/^0x/, "") === normalizedUser)
    .sort((a, b) => new Date(a.ts || 0).getTime() - new Date(b.ts || 0).getTime());
}
