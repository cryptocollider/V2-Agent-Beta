import assert from "node:assert/strict";
import test from "node:test";
import { applyBuiltInStrategyBias, normalizeBuiltInStrategyName } from "./built-in-strategies.js";

const baseScore = {
  perScenario: [],
  weightedTotal: 1000,
  worstCaseTotal: 900,
  bestCaseTotal: 1100,
  fragilityPenalty: 100,
  final: 900,
};

function makeSimInput(): any {
  return {
    game: {
      frame_cap: 2000,
    },
    throws: [
      { enter_frame: 600 },
    ],
  };
}

function makePlan(finalFrames: number[], overrides: Record<string, unknown> = {}): any {
  return {
    control: {
      x: 10,
      y: 10,
      angleDeg: 0,
      speedPct: 50,
      spinPct: 0,
      asset: "01".repeat(32),
      amount: "100",
      ...overrides,
    },
    perScenario: finalFrames.map((finalFrame, index) => ({
      scenario: {
        label: `scenario-${index}`,
        enterFrame: 0,
        acceptedAtHeight: 0,
        weight: 1,
      },
      syntheticThrowId: "aa".repeat(32),
      syntheticInput: {},
      rawFinalizeBytes: new Uint8Array(),
      decoded: {
        per_throw: [],
        per_asset_totals: [],
        snapshot_hashes: [],
        final_hash: "bb".repeat(32),
        end_frame: finalFrame,
      },
      meta: {},
    })),
  };
}

test("normalizeBuiltInStrategyName recognizes all built-in strategies", () => {
  assert.equal(normalizeBuiltInStrategyName(" toughnut_never_lose "), "toughnut_never_lose");
  assert.equal(normalizeBuiltInStrategyName("copy_slammers"), "copy_slammers");
  assert.equal(normalizeBuiltInStrategyName("nutjob_discovery"), "nutjob_discovery");
  assert.equal(normalizeBuiltInStrategyName("peanut_safe_flow"), "peanut_safe_flow");
  assert.equal(normalizeBuiltInStrategyName("prof_meta_rotator"), "prof_meta_rotator");
  assert.equal(normalizeBuiltInStrategyName("something_else"), null);
});

test("toughnut strategy prefers longer recovery windows when projected pnl is negative", () => {
  const prediction = {
    scenarioCount: 2,
    winnerScenarioCount: 0,
    pnlUsd: -3,
    bestPnlUsd: -0.5,
    worstPnlUsd: -5,
    holeType: 2,
    holeTypeCounts: { "2": 2 },
    valueUsd: 11,
    valueUsdE8: "1100000000",
    massUsd: 11,
    winnerValuePct: 0,
  };

  const shortWindow = applyBuiltInStrategyBias({
    strategyName: "toughnut_never_lose",
    baseScore,
    prediction,
    plan: makePlan([760, 780]),
    simInput: makeSimInput(),
  });

  const longWindow = applyBuiltInStrategyBias({
    strategyName: "toughnut_never_lose",
    baseScore,
    prediction,
    plan: makePlan([1400, 1500]),
    simInput: makeSimInput(),
  });

  assert.equal(shortWindow.strategy, "toughnut_never_lose");
  assert.ok(longWindow.scoreDelta > shortWindow.scoreDelta);
  assert.ok(longWindow.notes.includes("prefer_longer_recovery_window"));
});

test("nutjob strategy rewards wider stranger probes", () => {
  const quiet = applyBuiltInStrategyBias({
    strategyName: "nutjob_discovery",
    baseScore,
    prediction: {
      scenarioCount: 2,
      winnerScenarioCount: 0,
      pnlUsd: 0.2,
      bestPnlUsd: 0.5,
      worstPnlUsd: -0.2,
      holeType: 1,
      holeTypeCounts: { "1": 2 },
      valueUsd: 11,
      valueUsdE8: "1100000000",
      massUsd: 11,
      winnerValuePct: 0,
    },
    plan: makePlan([700, 730]),
    simInput: makeSimInput(),
  });

  const wild = applyBuiltInStrategyBias({
    strategyName: "nutjob_discovery",
    baseScore,
    prediction: {
      scenarioCount: 4,
      winnerScenarioCount: 1,
      pnlUsd: 1.5,
      bestPnlUsd: 6,
      worstPnlUsd: -2,
      holeType: 4,
      holeTypeCounts: { "1": 1, "3": 1, "4": 1, "5": 1 },
      valueUsd: 11,
      valueUsdE8: "1100000000",
      massUsd: 11,
      winnerValuePct: 25,
    },
    plan: makePlan([760, 1220, 1510, 1690], { angleDeg: 75, speedPct: 92, spinPct: 28 }),
    simInput: makeSimInput(),
  });

  assert.ok(wild.scoreDelta > quiet.scoreDelta);
  assert.ok(wild.notes.includes("wide_branch_exploration"));
  assert.ok(wild.notes.includes("novel_control_shape"));
});

test("peanut strategy prefers safer lower-variance candidates", () => {
  const safe = applyBuiltInStrategyBias({
    strategyName: "peanut_safe_flow",
    baseScore,
    prediction: {
      scenarioCount: 3,
      winnerScenarioCount: 0,
      pnlUsd: 0.8,
      bestPnlUsd: 1.2,
      worstPnlUsd: -0.1,
      holeType: 1,
      holeTypeCounts: { "1": 3 },
      valueUsd: 11,
      valueUsdE8: "1100000000",
      massUsd: 11,
      winnerValuePct: 0,
    },
    plan: makePlan([690, 710, 725]),
    simInput: makeSimInput(),
  });

  const fragile = applyBuiltInStrategyBias({
    strategyName: "peanut_safe_flow",
    baseScore,
    prediction: {
      scenarioCount: 3,
      winnerScenarioCount: 1,
      pnlUsd: -2,
      bestPnlUsd: 8,
      worstPnlUsd: -9,
      holeType: 2,
      holeTypeCounts: { "2": 2, "3": 1 },
      valueUsd: 11,
      valueUsdE8: "1100000000",
      massUsd: 11,
      winnerValuePct: 10,
    },
    plan: makePlan([900, 1450, 1700]),
    simInput: makeSimInput(),
  });

  assert.ok(safe.scoreDelta > fragile.scoreDelta);
  assert.ok(safe.notes.includes("low_variance_bias"));
  assert.ok(safe.notes.includes("draw_capital_preserve"));
});

test("prof strategy composes cross-style support rather than acting like one persona", () => {
  const prof = applyBuiltInStrategyBias({
    strategyName: "prof_meta_rotator",
    baseScore,
    prediction: {
      scenarioCount: 4,
      winnerScenarioCount: 1,
      pnlUsd: 1.1,
      bestPnlUsd: 4,
      worstPnlUsd: -0.3,
      holeType: 3,
      holeTypeCounts: { "1": 1, "3": 2, "5": 1 },
      valueUsd: 11,
      valueUsdE8: "1100000000",
      massUsd: 11,
      winnerValuePct: 62,
    },
    plan: makePlan([760, 980, 1260, 1480], { angleDeg: 35, speedPct: 64, spinPct: 12 }),
    simInput: makeSimInput(),
  });

  assert.equal(prof.strategy, "prof_meta_rotator");
  assert.ok(prof.scoreDelta > 0);
  assert.ok(prof.notes.some((note) => note.startsWith("cross_style_alignment:")) || prof.notes.some((note) => note.startsWith("single_style_signal:")));
});
