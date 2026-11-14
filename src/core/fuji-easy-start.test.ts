import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildBootstrapSummary } from "./bootstrap.js";
import {
  FUJI_EASY_START_CADENCE_MS,
  FUJI_EASY_START_MAX_GAME_EXPOSURE_USD,
  FUJI_EASY_START_MAX_THROW_BASE,
  FUJI_EASY_START_MAX_THROW_USD,
  FUJI_EASY_START_MAX_THROWS_PER_GAME,
  FUJI_EASY_START_SESSION_THROWS,
  FUJI_EASY_START_WEEKLY_THROWS,
  buildFujiEasyStartSettings,
  ensureFujiEasyStart,
} from "./fuji-easy-start.js";

const ADDRESS = "0x1111111111111111111111111111111111111111";

test("Fuji easy start is funded, week-scale, bounded, and manager-interactive", () => {
  const settings = buildFujiEasyStartSettings({
    address: ADDRESS,
    signingKeyFile: "C:\\secure\\agent1-fuji.hex",
  });

  assert.equal(settings.expectedNetworkId, 5);
  assert.equal(settings.bridgeWithdrawal?.expectedEvmChainId, 43113);
  assert.equal(settings.testnetAutoFunding?.enabled, true);
  assert.equal(settings.minMillisBetweenLiveThrows, FUJI_EASY_START_CADENCE_MS);
  assert.ok(FUJI_EASY_START_SESSION_THROWS > FUJI_EASY_START_WEEKLY_THROWS);
  assert.equal(settings.maxThrowsPerSession, FUJI_EASY_START_SESSION_THROWS);
  assert.equal(settings.maxThrowsPerGame, FUJI_EASY_START_MAX_THROWS_PER_GAME);
  assert.equal(settings.maxThrowUsd, FUJI_EASY_START_MAX_THROW_USD);
  assert.equal(settings.maxSingleThrowUsd, FUJI_EASY_START_MAX_THROW_USD);
  assert.equal(settings.maxGameExposureUsd, FUJI_EASY_START_MAX_GAME_EXPOSURE_USD);
  assert.equal(settings.maxSingleThrowBase, FUJI_EASY_START_MAX_THROW_BASE);
  assert.ok(BigInt(settings.reserveBalanceBase ?? "0") > 0n);
  assert.deepEqual(settings.allowedAssets, [settings.asset]);
  assert.deepEqual(settings.keepAssets, [settings.asset]);
  assert.equal(settings.humanLearning?.enabled, true);
  assert.equal(settings.humanLearning?.learnOwnManualThrows, true);

  const summary = buildBootstrapSummary(settings);
  assert.equal(summary.startupMode, "fuji_rc1_testnet");
  assert.equal(summary.startCommand, "npm run start:fuji");
});

test("Fuji easy start refuses to create a wallet without explicit operator consent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent1-fuji-easy-start-"));
  try {
    await assert.rejects(
      ensureFujiEasyStart(path.join(root, "data"), { workspaceDir: root }),
      /needs a user-owned signing wallet/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
