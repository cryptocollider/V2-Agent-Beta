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

test('ToughNut values robust micro-stake quality over a higher but fragile forecast',()=>{const common:any={scenarioCount:2,winnerScenarioCount:2,holeType:3,holeTypeCounts:{3:2},valueUsd:.1,winnerValuePct:100};const apply=(p:any)=>applyBuiltInStrategyBias({strategyName:'toughnut_never_lose',baseScore,prediction:{...common,...p},plan:makePlan([800,800]),simInput:makeSimInput()});const stable=apply({pnlUsd:.02,bestPnlUsd:.03,worstPnlUsd:.01}),fragile=apply({pnlUsd:.04,bestPnlUsd:.3,worstPnlUsd:-.1});assert.ok(stable.scoreDelta>fragile.scoreDelta);assert.ok(stable.notes.includes('quality_relative_to_submission_value'));});
test('Peanut values winner eligibility for ladder opportunity while keeping the forecast unchanged',()=>{const common:any={scenarioCount:2,winnerScenarioCount:2,pnlUsd:0,bestPnlUsd:0,worstPnlUsd:0,valueUsd:.1};const draw:any={...common,holeType:1,holeTypeCounts:{1:2}},win:any={...common,holeType:3,holeTypeCounts:{3:2}};const before=JSON.stringify(win),apply=(prediction:any)=>applyBuiltInStrategyBias({strategyName:'peanut_safe_flow',baseScore,prediction,plan:makePlan([800,800]),simInput:makeSimInput()});assert.ok(apply(win).scoreDelta>apply(draw).scoreDelta);assert.equal(JSON.stringify(win),before);});
test('NutJob penalizes a repeated probe rather than rewarding the same weirdness forever',()=>{const prediction:any={scenarioCount:2,winnerScenarioCount:1,pnlUsd:0,bestPnlUsd:.1,worstPnlUsd:-.1,holeType:4,holeTypeCounts:{3:1,4:1},valueUsd:.1};const plan=makePlan([800,1400],{spinPct:50,angleDeg:75,speedPct:95});const args={strategyName:'nutjob_discovery',baseScore,prediction,plan,simInput:makeSimInput()};const novel=applyBuiltInStrategyBias({...args,recentShots:[]}),repeat=applyBuiltInStrategyBias({...args,recentShots:[plan.control]});assert.ok(novel.scoreDelta>repeat.scoreDelta);assert.ok(repeat.notes.includes('avoid_repeating_answered_control'));});
test('Prof favors a stable forecast over a volatile same-return hypothesis without changing HPS or prediction data',()=>{const common:any={scenarioCount:2,winnerScenarioCount:2,holeType:3,pnlUsd:.02,valueUsd:.1,winnerValuePct:100};const apply=(prediction:any)=>applyBuiltInStrategyBias({strategyName:'prof_meta_rotator',baseScore,prediction,plan:makePlan([800,800]),simInput:makeSimInput()});const stable={...common,holeTypeCounts:{3:2},bestPnlUsd:.03,worstPnlUsd:.01},volatile={...common,holeTypeCounts:{3:1,2:1},bestPnlUsd:.3,worstPnlUsd:-.2};const before=JSON.stringify(stable);assert.ok(apply(stable).scoreDelta>apply(volatile).scoreDelta);assert.ok(apply(stable).notes.includes('scenario_agreement_is_not_empirical_probability'));assert.equal(JSON.stringify(stable),before);assert.equal(baseScore.final,900);});
