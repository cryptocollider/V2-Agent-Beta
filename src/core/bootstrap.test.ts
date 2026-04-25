import assert from "node:assert/strict";
import test from "node:test";
import { buildBootstrapSummary } from "./bootstrap.js";
import { DEFAULT_SETTINGS } from "./settings.js";

test("buildBootstrapSummary exposes zero-flag startup guidance for first-contact managers", () => {
  const summary = buildBootstrapSummary({
    ...DEFAULT_SETTINGS,
    user: "",
  });

  assert.equal(summary.startupMode, "zero_flag_beta");
  assert.equal(summary.startCommand, "npm start");
  assert.match(summary.starterQuestion, /How would you like me to play/i);
  assert.equal(summary.starterStyles.length, 5);
  assert.deepEqual(
    summary.starterStyles.map((entry) => entry.promptLabel),
    ["baseline", "careful", "stubborn", "exploratory", "hybrid"],
  );
  assert.equal(summary.starterStyles[1]?.doctrinePack, "peanut");
  assert.equal(summary.starterStyles[2]?.doctrinePack, "tough_nut");
  assert.equal(summary.tokenState, "pending");
});
