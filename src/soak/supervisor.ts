import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export const SOAK_GAME_COUNT = 8;
export const SOAK_THROWS_PER_GAME = 3;
export const SOAK_THROWS_PER_BATCH = SOAK_GAME_COUNT * SOAK_THROWS_PER_GAME;

const HEX32 = /^0x[0-9a-f]{64}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const PREFIX = /^[a-z0-9]{1,16}$/;
const MAP_CASES = ["classic", "mega", "shocadile", "blackhole"] as const;

export type SoakMapCase = typeof MAP_CASES[number];
export type SoakManifestGame = {
  case: SoakMapCase;
  created_height: number;
  fixture_sha256: string;
  game_id: string;
  name: string;
  run_id: string;
  status: "GAME_OPEN";
};
export type SoakManifest = {
  agent: string;
  chain: string;
  common_height: number;
  count: number;
  created_unix: number;
  games: SoakManifestGame[];
  prefix: string;
  state_hash: string;
  status: "OPEN_FIVE_NODE_CONSISTENT";
};
export type SoakPolicy = {
  maxDurationMs: number;
  maxThrows: number;
  maxGrossStakeBase: bigint;
  maxNetOutflowBase: bigint;
  minBalanceBase: bigint;
  maxBatchGrossStakeBase: bigint;
  paceMs: number;
  batchSafetyWindowMs: number;
};
export type SoakCounters = {
  startedAtMs: number;
  initialBalanceBase: bigint;
  currentBalanceBase: bigint;
  acceptedThrows: number;
  grossStakeBase: bigint;
};
export type BatchGate = { ok: true } | { ok: false; reason: string };

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(label + " must be an object");
  return value as Record<string, unknown>;
}

function stringField(row: Record<string, unknown>, name: string): string {
  const value = row[name];
  if (typeof value !== "string" || !value.trim()) throw new Error("manifest " + name + " is missing");
  return value.trim();
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error(label + " must be a positive integer");
  return Number(value);
}

export function parseSoakManifest(
  value: unknown,
  expected: { prefix: string; chain: string; agent: string },
): SoakManifest {
  if (!PREFIX.test(expected.prefix)) throw new Error("expected prefix is invalid");
  const row = record(value, "manifest");
  const prefix = stringField(row, "prefix");
  const chain = stringField(row, "chain");
  const agent = stringField(row, "agent").toLowerCase();
  const stateHash = stringField(row, "state_hash").toLowerCase();
  if (prefix !== expected.prefix) throw new Error("manifest prefix mismatch: " + prefix);
  if (chain !== expected.chain) throw new Error("manifest chain mismatch: " + chain);
  if (agent !== expected.agent.toLowerCase()) throw new Error("manifest agent mismatch: " + agent);
  if (row.status !== "OPEN_FIVE_NODE_CONSISTENT") throw new Error("manifest is not open/five-node-consistent");
  if (row.count !== SOAK_GAME_COUNT) throw new Error("manifest count must be " + SOAK_GAME_COUNT);
  if (!HEX32.test(stateHash)) throw new Error("manifest state_hash is not canonical hex32");
  const commonHeight = positiveInteger(row.common_height, "manifest common_height");
  if (typeof row.created_unix !== "number" || !Number.isFinite(row.created_unix) || row.created_unix <= 0) {
    throw new Error("manifest created_unix is invalid");
  }
  if (!Array.isArray(row.games) || row.games.length !== SOAK_GAME_COUNT) {
    throw new Error("manifest must contain exactly " + SOAK_GAME_COUNT + " games");
  }
  const ids = new Set<string>();
  const runIds = new Set<string>();
  const games = row.games.map((raw, index): SoakManifestGame => {
    const game = record(raw, "manifest game " + (index + 1));
    const runId = stringField(game, "run_id");
    const expectedRunId = prefix + String(index + 1).padStart(2, "0");
    const gameId = stringField(game, "game_id").toLowerCase();
    const mapCase = stringField(game, "case") as SoakMapCase;
    const fixtureSha = stringField(game, "fixture_sha256").toLowerCase();
    const name = stringField(game, "name");
    if (runId !== expectedRunId) throw new Error("manifest run_id order mismatch: " + runId);
    if (runIds.has(runId)) throw new Error("duplicate manifest run_id: " + runId);
    if (!HEX32.test(gameId)) throw new Error("invalid manifest game_id: " + gameId);
    if (ids.has(gameId)) throw new Error("duplicate manifest game_id: " + gameId);
    if (!MAP_CASES.includes(mapCase)) throw new Error("unsupported manifest map case: " + mapCase);
    if (!SHA256.test(fixtureSha)) throw new Error("invalid fixture SHA256 for " + runId);
    if (game.status !== "GAME_OPEN") throw new Error("fixture " + runId + " is not GAME_OPEN");
    const createdHeight = positiveInteger(game.created_height, runId + " created_height");
    if (createdHeight > commonHeight) throw new Error(runId + " created after manifest common height");
    if (!name.endsWith(runId)) throw new Error(runId + " name does not bind its run id");
    ids.add(gameId);
    runIds.add(runId);
    return { case: mapCase, created_height: createdHeight, fixture_sha256: fixtureSha,
      game_id: gameId, name, run_id: runId, status: "GAME_OPEN" };
  });
  return { agent, chain, common_height: commonHeight, count: SOAK_GAME_COUNT,
    created_unix: row.created_unix, games, prefix, state_hash: stateHash,
    status: "OPEN_FIVE_NODE_CONSISTENT" };
}

export async function loadAndVerifyManifest(
  manifestFile: string,
  expected: { prefix: string; chain: string; agent: string },
): Promise<{ manifest: SoakManifest; manifestSha256: string }> {
  const manifestBytes = await readFile(manifestFile);
  const manifest = parseSoakManifest(JSON.parse(manifestBytes.toString("utf8")), expected);
  const directory = path.dirname(manifestFile);
  for (const game of manifest.games) {
    const fixture = path.join(directory, "fuji-agent1-game-" + game.run_id + ".json");
    const bytes = await readFile(fixture);
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== game.fixture_sha256) throw new Error("fixture hash mismatch: " + game.run_id);
    const parsed = record(JSON.parse(bytes.toString("utf8")), "fixture " + game.run_id);
    if (String(parsed.game_id).toLowerCase() !== game.game_id || parsed.status !== "GAME_OPEN") {
      throw new Error("fixture content mismatch: " + game.run_id);
    }
  }
  return { manifest, manifestSha256: createHash("sha256").update(manifestBytes).digest("hex") };
}

export function validateSoakPolicy(policy: SoakPolicy): void {
  if (!Number.isSafeInteger(policy.maxDurationMs) || policy.maxDurationMs <= 0 || policy.maxDurationMs > 24 * 60 * 60_000) {
    throw new Error("max duration must be within 24 hours");
  }
  if (!Number.isSafeInteger(policy.maxThrows) || policy.maxThrows < SOAK_THROWS_PER_BATCH) {
    throw new Error("max throws must allow at least one complete 24-throw batch");
  }
  if (!Number.isSafeInteger(policy.paceMs) || policy.paceMs < 1_000) throw new Error("pace must be at least 1 second");
  if (!Number.isSafeInteger(policy.batchSafetyWindowMs) || policy.batchSafetyWindowMs < 0) throw new Error("batch safety window is invalid");
  const amounts: Array<[string, bigint]> = [
    ["max gross stake", policy.maxGrossStakeBase], ["max net outflow", policy.maxNetOutflowBase],
    ["minimum balance", policy.minBalanceBase], ["max batch gross stake", policy.maxBatchGrossStakeBase],
  ];
  for (const [label, amount] of amounts) if (amount < 0n) throw new Error(label + " cannot be negative");
  if (policy.maxBatchGrossStakeBase <= 0n || policy.maxBatchGrossStakeBase > policy.maxGrossStakeBase) {
    throw new Error("max batch gross stake must be positive and within the total gross cap");
  }
  if (policy.maxNetOutflowBase < policy.maxBatchGrossStakeBase) {
    throw new Error("max net outflow must cover one worst-case complete batch");
  }
}

export function gateNextBatch(policy: SoakPolicy, counters: SoakCounters, nowMs: number): BatchGate {
  validateSoakPolicy(policy);
  const elapsed = nowMs - counters.startedAtMs;
  if (!Number.isFinite(elapsed) || elapsed < 0) return { ok: false, reason: "clock_regressed" };
  const requiredWindow = (SOAK_THROWS_PER_BATCH - 1) * policy.paceMs + policy.batchSafetyWindowMs;
  if (elapsed + requiredWindow > policy.maxDurationMs) return { ok: false, reason: "duration_budget" };
  if (counters.acceptedThrows + SOAK_THROWS_PER_BATCH > policy.maxThrows) return { ok: false, reason: "throw_budget" };
  if (counters.grossStakeBase + policy.maxBatchGrossStakeBase > policy.maxGrossStakeBase) return { ok: false, reason: "gross_stake_budget" };
  if (counters.currentBalanceBase < policy.minBalanceBase + policy.maxBatchGrossStakeBase) {
    return { ok: false, reason: "projected_balance_floor" };
  }
  const netOutflow = counters.initialBalanceBase > counters.currentBalanceBase
    ? counters.initialBalanceBase - counters.currentBalanceBase : 0n;
  if (netOutflow + policy.maxBatchGrossStakeBase > policy.maxNetOutflowBase) {
    return { ok: false, reason: "projected_net_outflow_budget" };
  }
  return { ok: true };
}

export async function acquireExclusiveLock(lockFile: string): Promise<() => Promise<void>> {
  await mkdir(path.dirname(lockFile), { recursive: true });
  let handle;
  try { handle = await open(lockFile, "wx"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("supervisor lock already exists: " + lockFile);
    throw error;
  }
  await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + "\n", "utf8");
  await handle.sync();
  await handle.close();
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await unlink(lockFile).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
  };
}

export async function appendDurableJsonl(file: string, row: Record<string, unknown>): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const handle = await open(file, "a");
  try { await handle.writeFile(JSON.stringify(row) + "\n", "utf8"); await handle.sync(); }
  finally { await handle.close(); }
}

export async function atomicWriteJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp-" + process.pid;
  await writeFile(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  await rename(tmp, file);
}

export async function assertNoActiveMonitor(port: number, timeoutMs = 750): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetch("http://127.0.0.1:" + port + "/api/control/status", { signal: controller.signal });
    throw new Error("monitor port is occupied: " + port);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("monitor port is occupied")) throw error;
    const cause = error && typeof error === "object" ? (error as { cause?: { code?: string } }).cause : undefined;
    if (cause?.code === "ECONNREFUSED") return;
    throw new Error("monitor singleton probe failed closed on port " + port + ": "
      + (error instanceof Error ? error.message : String(error)));
  } finally { clearTimeout(timer); }
}

export async function fileExists(file: string): Promise<boolean> {
  try { return (await stat(file)).isFile(); } catch { return false; }
}

export function parseExactBase(value: string, label: string): bigint {
  if (!/^\d+$/.test(value)) throw new Error(label + " must be an unsigned base-unit integer");
  return BigInt(value);
}

export function assertPinnedPerThrowCap(value: unknown, expected: bigint): bigint {
  if (expected <= 0n) throw new Error("expected per-throw cap must be positive");
  if (typeof value !== "string" || !/^\d+$/.test(value.trim())) {
    throw new Error("live soak maxSingleThrowBase must be an unsigned base-unit integer");
  }
  const actual = BigInt(value.trim());
  if (actual <= 0n) throw new Error("live soak maxSingleThrowBase must be positive");
  if (actual !== expected) throw new Error("live soak maxSingleThrowBase does not match the pinned campaign cap");
  return actual;
}

export function boundedChildTimeoutMs(
  campaignDeadlineMs: number,
  nowMs: number,
  configuredTimeoutMs: number,
  shutdownReserveMs = 60_000,
): number {
  if (![campaignDeadlineMs, nowMs, configuredTimeoutMs, shutdownReserveMs].every(Number.isSafeInteger)
    || configuredTimeoutMs <= 0 || shutdownReserveMs < 0) {
    throw new Error("invalid bounded child timeout inputs");
  }
  const remaining = campaignDeadlineMs - nowMs - shutdownReserveMs;
  if (remaining <= 0) throw new Error("campaign deadline leaves no safe child execution window");
  return Math.min(configuredTimeoutMs, remaining);
}

export function validateOpenBatchResume(input: {
  manifestGameIds: string[];
  preflightGames: unknown[];
  auditGames: unknown[];
  localAcceptedAudits: unknown[];
  pendingDecisions: unknown[];
  currentNonce: number;
  agent: string;
  linkAsset: string;
  perThrowCap: bigint;
}): { existingThrows: number; existingGrossStakeBase: bigint; remainingThrows: number; firstNonce: number } {
  const ids = input.manifestGameIds.map((value) => value.toLowerCase());
  if (ids.length !== SOAK_GAME_COUNT || new Set(ids).size !== SOAK_GAME_COUNT) {
    throw new Error("resume requires exactly eight unique manifest games");
  }
  if (input.preflightGames.length !== SOAK_GAME_COUNT || input.auditGames.length !== SOAK_GAME_COUNT) {
    throw new Error("resume preflight/audit game counts differ from manifest");
  }
  if (!Number.isSafeInteger(input.currentNonce) || input.currentNonce < 0 || input.perThrowCap <= 0n) {
    throw new Error("invalid resume nonce or per-throw cap");
  }
  const linkAsset = input.linkAsset.toLowerCase().replace(/^0x/, "");
  const agent = input.agent.toLowerCase().replace(/^0x/, "");
  let existingThrows = 0;
  let existingGrossStakeBase = 0n;
  for (let i = 0; i < SOAK_GAME_COUNT; i += 1) {
    const preflight = record(input.preflightGames[i], "resume preflight game");
    const audit = record(input.auditGames[i], "resume audit game");
    const throws = Number(preflight.throws);
    if (String(preflight.id).toLowerCase() !== ids[i] || preflight.status !== 0
      || !Number.isSafeInteger(throws) || throws < 0 || throws >= SOAK_THROWS_PER_GAME) {
      throw new Error("unsafe partial preflight state for manifest game " + (i + 1));
    }
    if (String(audit.game_id).toLowerCase() !== ids[i] || audit.status !== 0
      || audit.throws !== throws || audit.agent_throws !== throws) {
      throw new Error("partial batch contains non-Agent1 or inconsistent throws");
    }
    const stakes = record(audit.agent_stake_by_asset, "resume agent stakes");
    for (const [asset, raw] of Object.entries(stakes)) {
      const amount = parseExactBase(String(raw), "resume stake");
      if (amount > 0n && asset.toLowerCase().replace(/^0x/, "") !== linkAsset) {
        throw new Error("partial batch used an unexpected asset");
      }
      if (asset.toLowerCase().replace(/^0x/, "") === linkAsset) existingGrossStakeBase += amount;
    }
    existingThrows += throws;
  }
  if (existingThrows >= SOAK_THROWS_PER_BATCH) throw new Error("partial batch is already complete");
  if (existingGrossStakeBase > BigInt(existingThrows) * input.perThrowCap) {
    throw new Error("partial batch gross stake exceeds the pinned per-throw cap");
  }
  const accepted = input.localAcceptedAudits.map((value) => record(value, "resume local accepted audit"));
  if (accepted.length !== existingThrows || input.pendingDecisions.length !== existingThrows) {
    throw new Error("partial batch local audit/pending-decision counts do not match chain state");
  }
  const firstNonce = input.currentNonce - existingThrows;
  if (firstNonce < 0) throw new Error("partial batch nonce range is invalid");
  accepted.sort((a, b) => Number(a.nonce) - Number(b.nonce));
  const byDecision = new Map<string, Record<string, unknown>>();
  for (let i = 0; i < accepted.length; i += 1) {
    const row = accepted[i];
    const metadata = record(row.metadata, "resume audit metadata");
    if (row.status !== "throw_accepted" || Number(row.nonce) !== firstNonce + i
      || !ids.includes(String(row.gameId).toLowerCase())
      || String(row.signer).toLowerCase().replace(/^0x/, "") !== agent) {
      throw new Error("partial batch local accepted audit is not exact/contiguous");
    }
    const decisionId = String(metadata.decisionId ?? "");
    if (!decisionId || byDecision.has(decisionId)) throw new Error("partial batch decision ids are missing or duplicated");
    byDecision.set(decisionId, row);
  }
  let pendingGross = 0n;
  for (const value of input.pendingDecisions) {
    const pending = record(value, "resume pending decision");
    const payload = record(pending.payload, "resume pending payload");
    const acceptedRow = byDecision.get(String(pending.decisionId ?? ""));
    if (!acceptedRow || String(pending.gameId).toLowerCase() !== String(acceptedRow.gameId).toLowerCase()
      || !ids.includes(String(pending.gameId).toLowerCase())
      || String(pending.botUser).toLowerCase().replace(/^0x/, "") !== agent
      || String(payload.user).toLowerCase().replace(/^0x/, "") !== agent
      || String(payload.asset).toLowerCase().replace(/^0x/, "") !== linkAsset
      || String(payload.data_commit).toLowerCase().replace(/^0x/, "")
        !== String(acceptedRow.dataCommit).toLowerCase().replace(/^0x/, "")) {
      throw new Error("pending decision does not bind to its accepted partial throw");
    }
    const amount = parseExactBase(String(payload.amount), "pending decision amount");
    if (amount <= 0n || amount > input.perThrowCap) throw new Error("pending decision violates per-throw cap");
    pendingGross += amount;
  }
  if (pendingGross !== existingGrossStakeBase) throw new Error("pending decision gross does not match five-node audit");
  return { existingThrows, existingGrossStakeBase,
    remainingThrows: SOAK_THROWS_PER_BATCH - existingThrows, firstNonce };
}
