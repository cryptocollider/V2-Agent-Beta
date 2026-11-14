import { readFile } from "node:fs/promises";
import path from "node:path";

import { loadSettings, normalizeSettings } from "../core/settings.js";
import { SOAK_GAME_COUNT, SOAK_THROWS_PER_BATCH, acquireExclusiveLock,
  appendDurableJsonl, assertNoActiveMonitor, atomicWriteJson, fileExists,
  assertPinnedPerThrowCap, boundedChildTimeoutMs, gateNextBatch, loadAndVerifyManifest,
  parseExactBase, validateOpenBatchResume, type SoakManifest,
  type SoakPolicy } from "../soak/supervisor.js";
import { runBoundedProcess, type ProcessResult } from "../soak/process.js";

type Json = Record<string, unknown>;
class LingeringWslChildError extends Error {}

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}
function flag(name: string): boolean { return process.argv.includes(name); }
function required(name: string): string {
  const value = arg(name)?.trim();
  if (!value) throw new Error("missing required argument " + name);
  return value;
}
function positiveNumber(name: string, fallback: string): number {
  const value = Number(arg(name, fallback));
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(name + " must be a positive integer");
  return value;
}
function object(value: unknown, label: string): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(label + " must be an object");
  return value as Json;
}
async function readJson(file: string): Promise<Json> {
  return object(JSON.parse(await readFile(file, "utf8")), file);
}
async function readJsonIfPresent(file: string): Promise<Json | null> {
  try { return await readJson(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
async function readJsonl(file: string): Promise<Json[]> {
  try {
    return (await readFile(file, "utf8")).split(/\r?\n/).filter(Boolean).map((line) => object(JSON.parse(line), file));
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}
function parseLastJson(text: string, label: string): Json {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return object(JSON.parse(lines[i]), label); } catch { /* continue */ }
  }
  throw new Error(label + " emitted no JSON result");
}

async function runWslPython(wslDir: string, script: string, args: string[], linuxTimeoutSeconds: number): Promise<ProcessResult> {
  return await runBoundedProcess("wsl.exe", ["-d", "Ubuntu", "--cd", wslDir, "--", "timeout",
    "--signal=INT", "--kill-after=30s", String(linuxTimeoutSeconds) + "s", "python3", script, ...args],
    { cwd: process.cwd(), timeoutMs: (linuxTimeoutSeconds + 60) * 1_000 });
}

async function wslChildMatches(wslDir: string, script: string, prefix: string): Promise<boolean> {
  const result = await runBoundedProcess("wsl.exe", ["-d", "Ubuntu", "--cd", wslDir, "--", "ps", "-eo", "args="],
    { cwd: process.cwd(), timeoutMs: 15_000 });
  return result.code === 0 && result.stdout.split(/\r?\n/).some((line) => line.includes(script) && line.includes(prefix));
}

async function requireWslChildStopped(wslDir: string, script: string, prefix: string): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (!(await wslChildMatches(wslDir, script, prefix))) return;
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  throw new LingeringWslChildError("Linux child is still active for " + script + " " + prefix + "; lock preserved");
}

async function wslPython(wslDir: string, script: string, args: string[], timeoutSeconds = 60): Promise<Json> {
  const result = await runWslPython(wslDir, script, args, timeoutSeconds);
  if (result.timedOut) throw new Error(script + " timed out");
  if (result.code !== 0) throw new Error(script + " failed with exit " + result.code + ": " + result.stderr.trim());
  return parseLastJson(result.stdout, script);
}

async function rpc(url: string, method: string, params: unknown[] = []): Promise<unknown> {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  if (!response.ok) throw new Error(method + " HTTP " + response.status);
  const envelope = object(await response.json(), method);
  if (envelope.error) throw new Error(method + " RPC error: " + JSON.stringify(envelope.error));
  return envelope.result;
}

async function assertSignedJournalsClear(dataDir: string): Promise<void> {
  const intent = await readJsonIfPresent(path.join(dataDir, "rc1-intent-state.json"));
  if (intent?.pending) throw new Error("unresolved signed intent journal");
  const withdrawal = await readJsonIfPresent(path.join(dataDir, "rc1-withdrawal-state.json"));
  if (withdrawal?.pending) throw new Error("unresolved signed withdrawal journal");
}

async function pendingDecisionRows(dataDir: string): Promise<Json[]> {
  const decisions = await readJsonIfPresent(path.join(dataDir, "pending-decisions.json"));
  if (!decisions) return [];
  if (!Array.isArray(decisions.rows)) throw new Error("pending prediction decisions are malformed");
  return decisions.rows.map((value) => object(value, "pending prediction decision"));
}

async function assertJournalsClear(dataDir: string): Promise<void> {
  await assertSignedJournalsClear(dataDir);
  if ((await pendingDecisionRows(dataDir)).length !== 0) throw new Error("pending prediction decisions are not empty");
}

function validatePreflight(receipt: Json, manifest: SoakManifest): { balance: bigint; games: Json[] } {
  if (receipt.status !== "SAFE_FOR_BOUNDED_RUN") throw new Error("backend preflight did not authorize bounded run");
  if (receipt.chain !== manifest.chain || receipt.agent !== manifest.agent) throw new Error("preflight chain/agent mismatch");
  if (receipt.open_games !== SOAK_GAME_COUNT || !Array.isArray(receipt.games)) throw new Error("preflight did not find eight open games");
  const rows = receipt.games.map((value) => object(value, "preflight game"));
  for (let i = 0; i < SOAK_GAME_COUNT; i += 1) {
    const throws = Number(rows[i].throws);
    if (String(rows[i].id).toLowerCase() !== manifest.games[i].game_id || rows[i].status !== 0
      || !Number.isSafeInteger(throws) || throws < 0 || throws >= 3) {
      throw new Error("preflight fixture mismatch: " + manifest.games[i].run_id);
    }
  }
  return { balance: parseExactBase(String(receipt.link_balance_base), "preflight LINK balance"), games: rows };
}

async function validateLocalNonce(dataDir: string, rpcUrl: string, agent: string): Promise<number> {
  const context = object(await rpc(rpcUrl, "colliderV2.getAuthContext", [agent]), "auth context");
  const user = object(context.user, "auth context user");
  const nonce = Number(user.accepted_next_nonce);
  if (!Number.isSafeInteger(nonce) || nonce < 0) throw new Error("invalid accepted wallet nonce");
  const audits = await readJsonl(path.join(dataDir, "rc1-signed-intents.jsonl"));
  const accepted = audits.filter((row) => row.status === "throw_accepted" && String(row.signer).toLowerCase() === agent.toLowerCase());
  if (accepted.length) {
    const localNext = Math.max(...accepted.map((row) => Number(row.nonce))) + 1;
    if (localNext !== nonce) throw new Error("local/canonical nonce mismatch: " + localNext + " != " + nonce);
  }
  return nonce;
}

function bigintJson(value: bigint): string { return value.toString(); }
function cleanHex(value: string): string { return value.trim().toLowerCase().replace(/^0x/, ""); }

async function createBatch(prefix: string, wslDir: string, remainingHours: number): Promise<void> {
  const createScript = "scripts/open.fuji.agent1-batch.py";
  const created = await runWslPython(wslDir, createScript,
    ["--prefix", prefix, "--count", "8", "--mixed-maps", "--execute"], 600);
  if (!created.closeObserved) {
    throw new LingeringWslChildError("Windows WSL launcher did not close for signed creation " + prefix + "; lock preserved");
  }
  if (created.timedOut || created.code !== 0) {
    await requireWslChildStopped(wslDir, createScript, prefix);
    throw new Error("AMBIGUOUS_SIGNED_CREATION for " + prefix + "; do not retry these run IDs");
  }
  const manifestScript = "scripts/write.fuji.agent1-batch-manifest.py";
  const written = await runWslPython(wslDir, manifestScript,
    ["--prefix", prefix, "--count", "8", "--required-runway-hours", String(Math.max(1, remainingHours)), "--save"], 120);
  if (!written.closeObserved) {
    throw new LingeringWslChildError("Windows WSL launcher did not close for manifest writer " + prefix + "; lock preserved");
  }
  if (written.timedOut) await requireWslChildStopped(wslDir, manifestScript, prefix);
  if (written.timedOut || written.code !== 0) throw new Error("manifest writer failed after signed creation for " + prefix);
}

async function main(): Promise<void> {
  const execute = flag("--execute");
  const allowCreate = flag("--allow-create");
  const dataDir = path.resolve(required("--data-dir"));
  const backendWin = path.resolve(required("--backend-dir-win"));
  const backendWsl = required("--backend-dir-wsl");
  if (!/^\/mnt\/[a-z]\/[A-Za-z0-9._\-/ ]+$/.test(backendWsl)) throw new Error("unsafe WSL backend path");
  const prefixes = required("--prefixes").split(",").map((value) => value.trim()).filter(Boolean);
  if (!prefixes.length || new Set(prefixes).size !== prefixes.length || prefixes.some((value) => !/^[a-z0-9]{1,16}$/.test(value))) {
    throw new Error("prefixes must be unique short lowercase alphanumeric values");
  }
  const campaignId = arg("--campaign-id", prefixes[0])!.trim();
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(campaignId)) throw new Error("campaign id must be short lowercase alphanumeric/hyphen text");
  const chain = required("--chain");
  const agent = required("--agent").toLowerCase();
  const linkAsset = required("--link-asset").toLowerCase();
  const maxHours = positiveNumber("--max-hours", "8");
  if (maxHours > 24) throw new Error("--max-hours cannot exceed 24");
  const requiredRunwayHours = positiveNumber("--required-runway-hours", String(maxHours));
  const policy: SoakPolicy = {
    maxDurationMs: maxHours * 60 * 60_000,
    maxThrows: positiveNumber("--max-throws", "144"),
    maxGrossStakeBase: parseExactBase(arg("--max-gross-link-base", "1300000000000000000")!, "max gross LINK"),
    maxNetOutflowBase: parseExactBase(arg("--max-net-outflow-link-base", "300000000000000000")!, "max net outflow LINK"),
    minBalanceBase: parseExactBase(arg("--min-link-balance-base", "250000000000000000")!, "minimum LINK balance"),
    maxBatchGrossStakeBase: parseExactBase(arg("--max-batch-gross-link-base", "210000000000000000")!, "max batch gross LINK"),
    paceMs: positiveNumber("--pace-ms", "180000"),
    batchSafetyWindowMs: positiveNumber("--batch-safety-window-ms", "600000"),
  };
  const batchTimeoutMs = positiveNumber("--batch-timeout-ms", "6600000");
  const campaignStartedAtRaw = arg("--campaign-started-at-ms")?.trim();
  const campaignStartedAtMs = campaignStartedAtRaw == null ? null : Number(campaignStartedAtRaw);
  if (campaignStartedAtMs != null && (!Number.isSafeInteger(campaignStartedAtMs)
    || campaignStartedAtMs <= 0 || campaignStartedAtMs > Date.now())) {
    throw new Error("--campaign-started-at-ms must be a past Unix millisecond timestamp");
  }
  const lockFile = path.join(dataDir, "soak-supervisor.lock");
  const eventsFile = path.join(dataDir, "soak-supervisor-events.jsonl");
  const stateFile = path.join(dataDir, "soak-supervisor-state-" + campaignId + ".json");
  const release = await acquireExclusiveLock(lockFile);
  let preserveLock = false;
  let stopReason = "error";
  const startedAtMs = campaignStartedAtMs ?? Date.now();
  try {
    if (execute && await fileExists(stateFile)) {
      throw new Error("existing soak supervisor state requires manual review; automatic resume is unsupported");
    }
    await appendDurableJsonl(eventsFile, { ts: new Date().toISOString(), event: "supervisor_started",
      campaignId, mode: execute ? "execute" : "validate_only", prefixes, policy: {
        maxDurationMs: policy.maxDurationMs, maxThrows: policy.maxThrows,
        maxGrossStakeBase: bigintJson(policy.maxGrossStakeBase), maxNetOutflowBase: bigintJson(policy.maxNetOutflowBase),
        minBalanceBase: bigintJson(policy.minBalanceBase), maxBatchGrossStakeBase: bigintJson(policy.maxBatchGrossStakeBase),
        paceMs: policy.paceMs, batchSafetyWindowMs: policy.batchSafetyWindowMs } });
    const settings = await loadSettings(dataDir);
    if (cleanHex(settings.user) !== cleanHex(agent)) throw new Error("settings wallet user does not match pinned soak agent");
    if (cleanHex(settings.asset) !== cleanHex(linkAsset)) throw new Error("settings default asset is not pinned LINK");
    if (!settings.signingKeyFile || !(await fileExists(settings.signingKeyFile))) throw new Error("pinned signing key file is unavailable");
    if (!settings.expectedNetworkDomain || !settings.expectedEvmAddress) throw new Error("wallet/network pins are incomplete");
    if (settings.maxThrowsPerGame !== 3) throw new Error("maxThrowsPerGame must be exactly 3");
    await assertNoActiveMonitor(settings.monitorPort);
    await assertSignedJournalsClear(dataDir);
    const startNonce = await validateLocalNonce(dataDir, settings.rpc, agent);
    let counters: { startedAtMs: number; initialBalanceBase: bigint; currentBalanceBase: bigint;
      acceptedThrows: number; grossStakeBase: bigint } | null = null;
    for (let index = 0; index < prefixes.length; index += 1) {
      const prefix = prefixes[index];
      const elapsedHours = Math.floor((Date.now() - startedAtMs) / 3_600_000);
      const remainingHours = Math.max(1, requiredRunwayHours - elapsedHours);
      const manifestFile = path.join(backendWin, "docs", "benchmarks", "fuji-agent1-soak-" + prefix + ".json");
      if (!(await fileExists(manifestFile))) {
        if (!execute || !allowCreate || index === 0) throw new Error("missing immutable manifest: " + prefix);
        await createBatch(prefix, backendWsl, remainingHours);
      }
      const verified = await loadAndVerifyManifest(manifestFile, { prefix, chain, agent });
      const receipt = await wslPython(backendWsl, "scripts/check.fuji.agent1-soak.py",
        ["--prefix", prefix, "--count", "8", "--required-runway-hours", String(remainingHours)]);
      const preflight = validatePreflight(receipt, verified.manifest);
      const balance = preflight.balance;
      const currentSettings = await loadSettings(dataDir);
      if (cleanHex(currentSettings.user) !== cleanHex(agent)
        || cleanHex(currentSettings.asset) !== cleanHex(linkAsset)) {
        throw new Error("settings wallet/asset pins changed before batch validation");
      }
      await assertSignedJournalsClear(dataDir);
      const currentNonce = await validateLocalNonce(dataDir, currentSettings.rpc, agent);
      const pinnedPerThrowCap = policy.maxBatchGrossStakeBase / BigInt(SOAK_THROWS_PER_BATCH);
      if (pinnedPerThrowCap * BigInt(SOAK_THROWS_PER_BATCH) > policy.maxBatchGrossStakeBase) {
        throw new Error("derived per-throw cap exceeds the batch cap");
      }
      const ids = new Set(verified.manifest.games.map((game) => game.game_id));
      const baselineAudit = await wslPython(backendWsl, "scripts/audit.fuji.agent1-batch.py",
        ["--prefix", prefix, "--count", "8"]);
      if (baselineAudit.status !== "FIVE_NODE_CONSISTENT" || baselineAudit.games_open !== 8
        || baselineAudit.games_settled !== 0 || !Array.isArray(baselineAudit.games)) {
        throw new Error("partial resume requires eight open, five-node-consistent games");
      }
      const localAcceptedAudits = (await readJsonl(path.join(dataDir, "rc1-signed-intents.jsonl"))).filter((row) =>
        ids.has(String(row.gameId).toLowerCase()) && row.status === "throw_accepted");
      const resume = validateOpenBatchResume({
        manifestGameIds: verified.manifest.games.map((game) => game.game_id),
        preflightGames: preflight.games,
        auditGames: baselineAudit.games,
        localAcceptedAudits,
        pendingDecisions: await pendingDecisionRows(dataDir),
        currentNonce,
        agent,
        linkAsset,
        perThrowCap: pinnedPerThrowCap,
      });
      if (Number(baselineAudit.agent_throws_all_games) !== resume.existingThrows) {
        throw new Error("five-node partial throw total does not match resume baseline");
      }
      if (resume.existingThrows > 0 && campaignStartedAtMs == null) {
        throw new Error("partial resume requires --campaign-started-at-ms to preserve the original duration budget");
      }
      if (index > 0 && resume.existingThrows !== 0) throw new Error("only the first campaign prefix may be resumed partially");
      if (!counters) counters = { startedAtMs,
        initialBalanceBase: balance + resume.existingGrossStakeBase, currentBalanceBase: balance,
        acceptedThrows: 0, grossStakeBase: 0n };
      else counters.currentBalanceBase = balance;
      const gate = gateNextBatch(policy, counters, Date.now());
      await appendDurableJsonl(eventsFile, { ts: new Date().toISOString(), event: "batch_validated", prefix,
        campaignId,
        manifestSha256: verified.manifestSha256, commonHeight: receipt.common_height,
        stateHash: receipt.state_hash, balanceBase: bigintJson(balance),
        existingThrows: resume.existingThrows,
        existingGrossStakeBase: bigintJson(resume.existingGrossStakeBase), gate });
      if (!gate.ok) { stopReason = gate.reason; break; }
      if (!execute) { stopReason = "validation_complete"; break; }
      const nextSettings = normalizeSettings({ ...currentSettings, allowedGameIds: verified.manifest.games.map((game) => game.game_id),
        maxThrowsPerGame: 3, maxThrowsPerSession: resume.remainingThrows,
        maxSingleThrowBase: pinnedPerThrowCap.toString(),
        minMillisBetweenLiveThrows: policy.paceMs, baselineResetThrows: resume.remainingThrows });
      await atomicWriteJson(path.join(dataDir, "settings.json"), nextSettings);
      const launchSettings = await loadSettings(dataDir);
      assertPinnedPerThrowCap(launchSettings.maxSingleThrowBase, pinnedPerThrowCap);
      const batchLog = path.join(dataDir, "soak-batch-" + prefix + ".log");
      const childTimeoutMs = boundedChildTimeoutMs(
        startedAtMs + policy.maxDurationMs, Date.now(), batchTimeoutMs,
      );
      const child = await runBoundedProcess(process.execPath, [path.resolve("dist/cli/main.js"), "--data-dir", dataDir,
        "--loop", "--exit-on-session-cap", "--no-monitor"], {
        cwd: process.cwd(), timeoutMs: childTimeoutMs, outputFile: batchLog,
        mirrorOutput: false, maxCaptureChars: 1_000_000,
      });
      if (child.timedOut) throw new Error("Agent1 batch timed out; canonical audit required before resume: " + prefix);
      if (child.code !== 0) throw new Error("Agent1 batch failed with exit " + child.code + ": " + prefix);
      const audits = (await readJsonl(path.join(dataDir, "rc1-signed-intents.jsonl"))).filter((row) =>
        ids.has(String(row.gameId).toLowerCase()) && row.status === "throw_accepted");
      if (audits.length !== SOAK_THROWS_PER_BATCH || audits.some((row) => row.status !== "throw_accepted")) {
        throw new Error("local accepted audit is incomplete for " + prefix);
      }
      const nonces = audits.map((row) => Number(row.nonce)).sort((a, b) => a - b);
      if (nonces.some((nonce, i) => nonce !== resume.firstNonce + i)) throw new Error("non-contiguous batch nonce audit for " + prefix);
      const results = (await readJsonl(path.join(dataDir, "results.jsonl"))).filter((row) => ids.has(String(row.gameId).toLowerCase()));
      if (results.length !== SOAK_THROWS_PER_BATCH || results.some((row) => !Number.isFinite(Number(object(row.honestScore, "honestScore").honestScore)))) {
        throw new Error("HPS result audit is incomplete for " + prefix);
      }
      const gross = results.reduce((sum, row) => sum + parseExactBase(String(object(object(row.expected, "expected").payload, "payload").amount), "stake amount"), 0n);
      const audit = await wslPython(backendWsl, "scripts/audit.fuji.agent1-batch.py", ["--prefix", prefix, "--count", "8"]);
      if (audit.status !== "FIVE_NODE_CONSISTENT" || audit.games_settled !== 8 || audit.agent_throws_all_games !== 24) {
        throw new Error("terminal five-node audit failed for " + prefix);
      }
      await assertJournalsClear(dataDir);
      const postBalances = object(await rpc(currentSettings.rpc, "colliderV2.getBalances", [agent]), "balances");
      const postBalance = parseExactBase(String(postBalances[linkAsset] ?? "0"), "post-batch LINK balance");
      counters.acceptedThrows += SOAK_THROWS_PER_BATCH;
      counters.grossStakeBase += gross;
      counters.currentBalanceBase = postBalance;
      if (counters.grossStakeBase > policy.maxGrossStakeBase) throw new Error("actual gross stake cap exceeded");
      if (postBalance < policy.minBalanceBase) throw new Error("post-batch balance floor crossed");
      const netOutflow = counters.initialBalanceBase > postBalance ? counters.initialBalanceBase - postBalance : 0n;
      if (netOutflow > policy.maxNetOutflowBase) throw new Error("post-batch net outflow cap exceeded");
      await atomicWriteJson(stateFile, { schema: "collider.agent1.soak-supervisor.v1", startedAtMs,
        campaignId, lastPrefix: prefix, nextNonce: resume.firstNonce + SOAK_THROWS_PER_BATCH,
        acceptedThrows: counters.acceptedThrows, grossStakeBase: bigintJson(counters.grossStakeBase),
        initialBalanceBase: bigintJson(counters.initialBalanceBase), currentBalanceBase: bigintJson(postBalance),
        manifestSha256: verified.manifestSha256, updatedAt: new Date().toISOString() });
      await appendDurableJsonl(eventsFile, { ts: new Date().toISOString(), event: "batch_terminal", prefix,
        campaignId,
        acceptedThrows: SOAK_THROWS_PER_BATCH, resumedThrows: resume.existingThrows,
        nonceStart: resume.firstNonce, nonceEnd: resume.firstNonce + 23,
        grossStakeBase: bigintJson(gross), balanceBase: bigintJson(postBalance),
        meanHps: results.reduce((sum, row) => sum + Number(object(row.honestScore, "honestScore").honestScore), 0) / results.length });
      stopReason = index === prefixes.length - 1 ? "prefixes_exhausted" : "continuing";
    }
    if (stopReason === "continuing") stopReason = "prefixes_exhausted";
    if (!execute && stopReason !== "validation_complete") throw new Error("validation stopped: " + stopReason);
    if (startNonce < 0) throw new Error("unreachable nonce guard");
  } catch (error) {
    preserveLock = error instanceof LingeringWslChildError;
    stopReason = "error: " + (error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    await appendDurableJsonl(eventsFile, { ts: new Date().toISOString(), event: "supervisor_stopped", campaignId, reason: stopReason });
    if (preserveLock) {
      await appendDurableJsonl(eventsFile, { ts: new Date().toISOString(), event: "lock_preserved", lockFile });
    } else {
      await release();
    }
  }
  console.log(JSON.stringify({ status: "STOPPED", reason: stopReason }, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
