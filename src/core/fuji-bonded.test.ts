import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { buildFujiBondedSettings, createFujiBondedProfile, ensureFujiBondedProfile,
  FUJI_BONDED_RPC, FUJI_BONDED_DOMAIN } from "./fuji-bonded.js";
import { DEFAULT_SETTINGS } from "./settings.js";

test("bonded profile isolates history, pins the newest route and preserves owner caps without enabling confirmations", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent1-bonded-profile-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const owner = { ...DEFAULT_SETTINGS, expectedEvmAddress: "0x" + "11".repeat(20), signingKeyFile: "C:\\owner\\unused-test-key.hex",
    maxThrowUsd: 1.1, maxThrowsPerSession: 9340, maxThrowsPerGame: 22, minMillisBetweenLiveThrows: 30000 };
  const settings = buildFujiBondedSettings(owner);
  assert.equal(settings.rpc, FUJI_BONDED_RPC); assert.equal(settings.expectedNetworkDomain, FUJI_BONDED_DOMAIN);
  assert.equal(settings.maxThrowUsd, 1.1); assert.equal(settings.maxThrowsPerSession, 9340);
  assert.equal(settings.maxThrowsPerGame, 22); assert.equal(settings.minMillisBetweenLiveThrows, 30000);
  assert.equal(settings.testnetAutoFunding?.faucetUrl, "http://127.0.0.1:11441");
  assert.equal(settings.testnetAutoFunding?.readinessUrl, "http://127.0.0.1:11396/status");
  const manifest = path.join(root, "manifest.json");
  await writeFile(manifest, JSON.stringify({ network_id: 5, blockchain_id: "2eptdaEYvBtpw33aCSb8QDVPKVkd3VLMg1GVQARX3sKEKeihUb",
    wasm_sha256: "92241dc64762f1db4bc82c364a46e4ead6d484348430fbe823f05809c62898ce",
    genesis_sha256: "246fb6f2a4d387513af00a76cc81f0af5788c7cf6b22b669f694517d6f0e93da",
    plugin_sha256: "dbf4730fc0f49ea0b2ccda7261798dac15e7e56e9e1d2238eae335fb9d3412e4",
    bridge_route: { custody_contract: "0x214b60558281d87f4e272baf3348ddf2bd8c8ebf" } }));
  const dir = path.join(root, "data-rc1-bonded-test");
  await createFujiBondedProfile(dir, owner, manifest); await ensureFujiBondedProfile(dir);
  const config = JSON.parse(await readFile(path.join(dir, "bonded-confirmations.json"), "utf8"));
  assert.equal(config.enabled, false); assert.equal(config.maxNewRounds, 4); assert.equal(config.maxCapitalBase, "80000000000000000");
  await writeFile(path.join(dir, "settings.json"), JSON.stringify({ ...settings, user: settings.user.replace(/^0x/, "") }));
  await ensureFujiBondedProfile(dir); // Runtime bootstrap persists canonical IDs without a display prefix.
  await assert.rejects(createFujiBondedProfile(dir, owner, manifest), /empty/);
  await writeFile(path.join(dir, "settings.json"), JSON.stringify({ ...settings, rpc: "http://127.0.0.1:11450/old" }));
  await assert.rejects(ensureFujiBondedProfile(dir), /pins mismatch/);
});
