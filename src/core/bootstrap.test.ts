import assert from "node:assert/strict";
import test from "node:test";
import { buildBootstrapSummary } from "./bootstrap.js";
import { DEFAULT_SETTINGS } from "./settings.js";

test("buildBootstrapSummary exposes RC1 wallet startup guidance for first-contact managers", () => {
  const summary = buildBootstrapSummary({
    ...DEFAULT_SETTINGS,
    user: "",
  });

  assert.equal(summary.startupMode, "production_rc1");
  assert.equal(summary.startCommand, "npm start");
  assert.match(summary.starterQuestion, /How would you like me to play/i);
  assert.equal(summary.starterStyles.length, 5);
  assert.deepEqual(
    summary.starterStyles.map((entry) => entry.promptLabel),
    ["baseline", "careful", "stubborn", "exploratory", "hybrid"],
  );
  assert.equal(summary.starterStyles[1]?.doctrinePack, "peanut");
  assert.equal(summary.starterStyles[2]?.doctrinePack, "tough_nut");
  assert.equal(summary.fundingStatus, "wallet_unconfigured");
  assert.equal(summary.walletConfigured, false);
  assert.equal(summary.testnetAutoFunding.enabled, false);
  assert.equal(summary.testnetAutoFunding.stage, "DISABLED");
});

test("buildBootstrapSummary labels explicit Fuji startup separately from production", () => {
  const summary = buildBootstrapSummary({
    ...DEFAULT_SETTINGS,
    testnetAutoFunding: {
      ...DEFAULT_SETTINGS.testnetAutoFunding!,
      enabled: true,
    },
  });

  assert.equal(summary.startupMode, "fuji_rc1_testnet");
  assert.equal(summary.startCommand, "npm run start:fuji");
});
