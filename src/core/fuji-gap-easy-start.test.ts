import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  FUJI_GAP_CHAIN_ID, FUJI_GAP_CUSTODY, FUJI_GAP_DOMAIN, FUJI_GAP_INITIAL_SESSION_CAP,
  FUJI_GAP_L1_ID, FUJI_GAP_MONITOR_PORT, FUJI_GAP_ROUTE, FUJI_GAP_RPC,
  buildFujiGapSettings, ensureFujiGapEasyStart,
} from "./fuji-gap-easy-start.js";

test("fresh Fuji profile is isolated and pins all three RC1 bridge assets", () => {
  const settings = buildFujiGapSettings({
    address: "0x1111111111111111111111111111111111111111",
    signingKeyFile: "C:\\secure\\fresh-agent.hex",
  });
  assert.equal(settings.rpc, FUJI_GAP_RPC);
  assert.equal(settings.expectedNetworkDomain, FUJI_GAP_DOMAIN);
  assert.equal(settings.expectedChainId, FUJI_GAP_CHAIN_ID);
  assert.equal(settings.expectedL1Id, FUJI_GAP_L1_ID);
  assert.equal(settings.bridgeWithdrawal?.custodyContract, FUJI_GAP_CUSTODY);
  assert.equal(settings.bridgeWithdrawal?.routeId, FUJI_GAP_ROUTE);
  assert.equal(Object.keys(settings.bridgeWithdrawal?.assets ?? {}).length, 3);
  assert.equal(settings.bridgeWithdrawal?.assets["0x" + "09".repeat(32)]?.policyHash,
    "0x7db093c0b10f8b3098677290cb7ba0a90285d6558ce6b40485767c87597b3906");
  assert.equal(settings.monitorPort, FUJI_GAP_MONITOR_PORT);
  assert.equal(settings.maxThrowsPerSession, FUJI_GAP_INITIAL_SESSION_CAP);
  assert.equal(settings.minMillisBetweenLiveThrows, 60_000);
  assert.equal(settings.maxThrowsPerGame, 11);
  assert.equal(settings.testnetAutoFunding?.enabled, true);
  assert.deepEqual(settings.allowedAssets, [settings.asset]);
});

test("fresh Fuji setup refuses old canary path and implicit key creation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent1-fuji-gap-"));
  try {
    await assert.rejects(
      ensureFujiGapEasyStart(path.join(root, "data-rc1-easystart-week-20261008a")),
      /own data-rc1-gap/,
    );
    await assert.rejects(
      ensureFujiGapEasyStart(path.join(root, "data-rc1-gap-test")),
      /needs an owner wallet/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
