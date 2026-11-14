import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { appendResultLog, appendThrowLog, gameHistoryFile, initStorage } from "./storage.js";

test("throw and result appends maintain isolated per-game history indexes", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent1-game-history-"));
  try {
    const storage = await initStorage(dir);
    const gameA = "0x" + "aa".repeat(32);
    const gameB = "0x" + "bb".repeat(32);
    await appendThrowLog(storage, { gameId: gameA, decisionId: "a", submitted: true } as any);
    await appendThrowLog(storage, { gameId: gameB, decisionId: "b", submitted: true } as any);
    await appendResultLog(storage, { gameId: gameA, decisionId: "a" } as any);
    const throwsA = (await readFile(gameHistoryFile(storage, "throws", gameA), "utf8")).trim().split(/\r?\n/);
    const throwsB = (await readFile(gameHistoryFile(storage, "throws", gameB), "utf8")).trim().split(/\r?\n/);
    const resultsA = (await readFile(gameHistoryFile(storage, "results", gameA), "utf8")).trim().split(/\r?\n/);
    assert.equal(throwsA.length, 1);
    assert.equal(JSON.parse(throwsA[0]).decisionId, "a");
    assert.equal(throwsB.length, 1);
    assert.equal(JSON.parse(throwsB[0]).decisionId, "b");
    assert.equal(resultsA.length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
