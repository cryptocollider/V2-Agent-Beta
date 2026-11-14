import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";

import { SOAK_THROWS_PER_BATCH, acquireExclusiveLock, appendDurableJsonl,
  assertNoActiveMonitor, assertPinnedPerThrowCap, atomicWriteJson, boundedChildTimeoutMs, gateNextBatch,
  loadAndVerifyManifest, parseSoakManifest, validateOpenBatchResume,
  type SoakPolicy } from "./supervisor.js";

const prefix = "oct06s1";
const chain = "2dTFQSe9RQLSSfv8auy7Ns8LvZZqSxViyxvVrg1QqF7zXYGH9p";
const agent = "0x" + "00".repeat(12) + "3735dfb5b2235c0d2bd0eff981823ce2717bc759";

function fixture(index: number) {
  const run_id = prefix + String(index).padStart(2, "0");
  const raw = JSON.stringify({ status: "GAME_OPEN", game_id: "0x" + index.toString(16).padStart(64, "0") }, null, 2) + "\n";
  return { run_id, raw, hash: createHash("sha256").update(raw).digest("hex") };
}

function manifest() {
  return {
    agent, chain, common_height: 100, count: 8, created_unix: 1,
    games: Array.from({ length: 8 }, (_, i) => {
      const f = fixture(i + 1);
      return { case: ["classic", "mega", "shocadile", "blackhole"][i % 4],
        created_height: 90 + i, fixture_sha256: f.hash,
        game_id: "0x" + (i + 1).toString(16).padStart(64, "0"),
        name: "RC1-Agent1-canary-" + f.run_id, run_id: f.run_id, status: "GAME_OPEN" };
    }),
    prefix, state_hash: "0x" + "ab".repeat(32), status: "OPEN_FIVE_NODE_CONSISTENT",
  };
}

const policy: SoakPolicy = {
  maxDurationMs: 8 * 60 * 60_000, maxThrows: 144,
  maxGrossStakeBase: 1_300_000_000_000_000_000n,
  maxNetOutflowBase: 300_000_000_000_000_000n,
  minBalanceBase: 250_000_000_000_000_000n,
  maxBatchGrossStakeBase: 210_000_000_000_000_000n,
  paceMs: 180_000, batchSafetyWindowMs: 10 * 60_000,
};

test("parses a pinned eight-game manifest", () => {
  const parsed = parseSoakManifest(manifest(), { prefix, chain, agent });
  assert.equal(parsed.games.length, 8);
  assert.equal(parsed.games[3].case, "blackhole");
});

test("rejects stale or reordered run ids", () => {
  const value = manifest();
  value.games[0].run_id = "oct06s199";
  assert.throws(() => parseSoakManifest(value, { prefix, chain, agent }), /run_id order mismatch/);
});

test("verifies every individual fixture hash", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent1-soak-"));
  try {
    for (let i = 1; i <= 8; i += 1) {
      const f = fixture(i);
      await writeFile(path.join(dir, "fuji-agent1-game-" + f.run_id + ".json"), f.raw);
    }
    const file = path.join(dir, "fuji-agent1-soak-" + prefix + ".json");
    await writeFile(file, JSON.stringify(manifest()));
    const verified = await loadAndVerifyManifest(file, { prefix, chain, agent });
    assert.equal(verified.manifest.games.length, 8);
    await writeFile(path.join(dir, "fuji-agent1-game-oct06s101.json"), "{}\n");
    await assert.rejects(loadAndVerifyManifest(file, { prefix, chain, agent }), /hash mismatch/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("batch gate accepts a complete bounded tranche", () => {
  assert.deepEqual(gateNextBatch(policy, { startedAtMs: 1_000,
    initialBalanceBase: 1_000_000_000_000_000_000n,
    currentBalanceBase: 997_000_000_000_000_000n,
    acceptedThrows: 0, grossStakeBase: 0n }, 2_000), { ok: true });
  assert.equal(SOAK_THROWS_PER_BATCH, 24);
});

test("policy permits a 24-hour endurance campaign but rejects anything longer", () => {
  const counters = { startedAtMs: 0, initialBalanceBase: 2_000_000_000_000_000_000n,
    currentBalanceBase: 2_000_000_000_000_000_000n, acceptedThrows: 0, grossStakeBase: 0n };
  assert.deepEqual(gateNextBatch({ ...policy, maxDurationMs: 24 * 60 * 60_000 }, counters, 1), { ok: true });
  assert.throws(() => gateNextBatch({ ...policy, maxDurationMs: 24 * 60 * 60_000 + 1 }, counters, 1), /within 24 hours/);
});

test("batch gate fails closed on each monetary cap", () => {
  const common = { startedAtMs: 0, initialBalanceBase: 1_000n, acceptedThrows: 0, grossStakeBase: 0n };
  assert.deepEqual(gateNextBatch({ ...policy, minBalanceBase: 800n, maxBatchGrossStakeBase: 200n }, { ...common, currentBalanceBase: 999n }, 1), { ok: false, reason: "projected_balance_floor" });
  assert.deepEqual(gateNextBatch({ ...policy, maxNetOutflowBase: 300n, maxBatchGrossStakeBase: 200n, minBalanceBase: 0n }, { ...common, currentBalanceBase: 899n }, 1), { ok: false, reason: "projected_net_outflow_budget" });
  assert.deepEqual(gateNextBatch({ ...policy, maxGrossStakeBase: 300n, maxBatchGrossStakeBase: 200n }, { ...common, currentBalanceBase: 1_000n, grossStakeBase: 101n }, 1), { ok: false, reason: "gross_stake_budget" });
});

test("policy rejects a net cap smaller than one worst-case batch", () => {
  assert.throws(() => gateNextBatch({ ...policy,
    maxNetOutflowBase: policy.maxBatchGrossStakeBase - 1n }, {
    startedAtMs: 0, initialBalanceBase: 1_000_000_000_000_000_000n,
    currentBalanceBase: 1_000_000_000_000_000_000n,
    acceptedThrows: 0, grossStakeBase: 0n }, 1), /must cover one worst-case complete batch/);
});

test("live soak requires the exact positive pinned per-throw cap", () => {
  const expected = 8_750_000_000_000_000n;
  assert.equal(assertPinnedPerThrowCap("8750000000000000", expected), expected);
  assert.throws(() => assertPinnedPerThrowCap("0", expected), /must be positive/);
  assert.throws(() => assertPinnedPerThrowCap("8.75e15", expected), /unsigned base-unit integer/);
  assert.throws(() => assertPinnedPerThrowCap("8750000000000001", expected), /does not match/);
});

test("child timeout cannot overrun the campaign deadline", () => {
  assert.equal(boundedChildTimeoutMs(1_000_000, 100_000, 600_000, 60_000), 600_000);
  assert.equal(boundedChildTimeoutMs(1_000_000, 500_000, 600_000, 60_000), 440_000);
  assert.throws(() => boundedChildTimeoutMs(1_000_000, 950_000, 600_000, 60_000), /no safe child execution window/);
});

test("partial batch resume binds chain, nonce, pending decision, asset, and gross stake", () => {
  const ids = manifest().games.map((game) => game.game_id);
  const preflightGames = ids.map((id, i) => ({ id, status: 0, throws: i === 0 ? 1 : 0 }));
  const auditGames = ids.map((game_id, i) => ({ game_id, status: 0, throws: i === 0 ? 1 : 0,
    agent_throws: i === 0 ? 1 : 0,
    agent_stake_by_asset: i === 0 ? { ["0x" + "0b".repeat(32)]: "75" } : {} }));
  const localAcceptedAudits = [{ status: "throw_accepted", nonce: 47, signer: agent,
    gameId: ids[0], dataCommit: "abcd", metadata: { decisionId: "d1" } }];
  const pendingDecisions = [{ decisionId: "d1", gameId: ids[0], botUser: agent,
    payload: { user: agent, asset: "0b".repeat(32), amount: "75", data_commit: "abcd" } }];
  assert.deepEqual(validateOpenBatchResume({ manifestGameIds: ids, preflightGames, auditGames,
    localAcceptedAudits, pendingDecisions, currentNonce: 48, agent,
    linkAsset: "0x" + "0b".repeat(32), perThrowCap: 100n }), {
    existingThrows: 1, existingGrossStakeBase: 75n, remainingThrows: 23, firstNonce: 47,
  });
  assert.throws(() => validateOpenBatchResume({ manifestGameIds: ids, preflightGames,
    auditGames: auditGames.map((row, i) => i === 0 ? { ...row, agent_throws: 0 } : row),
    localAcceptedAudits, pendingDecisions, currentNonce: 48, agent,
    linkAsset: "0x" + "0b".repeat(32), perThrowCap: 100n }), /non-Agent1 or inconsistent/);
});

test("batch gate will not begin a partial final batch", () => {
  assert.deepEqual(gateNextBatch({ ...policy, maxThrows: 47 }, { startedAtMs: 0,
    initialBalanceBase: 1_000n, currentBalanceBase: 1_000n,
    acceptedThrows: 24, grossStakeBase: 0n }, 1), { ok: false, reason: "throw_budget" });
});

test("exclusive lock blocks a duplicate supervisor and releases cleanly", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent1-soak-lock-"));
  try {
    const file = path.join(dir, "supervisor.lock");
    const release = await acquireExclusiveLock(file);
    await assert.rejects(acquireExclusiveLock(file), /lock already exists/);
    await release();
    const releaseAgain = await acquireExclusiveLock(file);
    await releaseAgain();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("durable event log and atomic JSON state are parseable", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent1-soak-state-"));
  try {
    const log = path.join(dir, "events.jsonl");
    const state = path.join(dir, "state.json");
    await appendDurableJsonl(log, { event: "started", value: 1 });
    await atomicWriteJson(state, { status: "ok" });
    assert.equal(JSON.parse((await readFile(log, "utf8")).trim()).event, "started");
    assert.equal(JSON.parse(await readFile(state, "utf8")).status, "ok");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("monitor singleton gate rejects any occupied HTTP port", async () => {
  const server = createServer((_req, res) => { res.statusCode = 404; res.end("not-agent1"); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    await assert.rejects(assertNoActiveMonitor(address.port, 100), /port is occupied/);
  } finally { server.close(); await once(server, "close"); }
});

test("monitor singleton gate fails closed on a hanging listener", async () => {
  const server = createServer(() => { /* deliberately never respond */ });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    await assert.rejects(assertNoActiveMonitor(address.port, 50), /failed closed/);
  } finally { server.closeAllConnections(); server.close(); await once(server, "close"); }
});
