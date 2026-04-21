import assert from "node:assert/strict";
import test from "node:test";
import { normalizeGoalWeights, resolveAgentProfile } from "./agent-profile.js";

test("resolveAgentProfile applies doctrine defaults", () => {
  const baseline = resolveAgentProfile({});
  assert.equal(baseline.doctrinePack, "baseline");
  assert.equal(baseline.effective.riskMode, "balanced");
  assert.equal(baseline.effective.customStrategy, null);
  assert.equal(baseline.effective.copySlammerWhenSameHoleType, false);

  const toughNut = resolveAgentProfile({ doctrinePack: "tough_nut" as any });
  assert.equal(toughNut.doctrineLabel, "ToughNut");
  assert.equal(toughNut.effective.customStrategy, "copy_slammers");
  assert.equal(toughNut.effective.copySlammerWhenSameHoleType, true);
});

test("resolveAgentProfile honors explicit overrides and normalizes goal weights", () => {
  const profile = resolveAgentProfile({
    doctrinePack: "tough_nut" as any,
    riskMode: "defensive",
    customStrategy: "late_diehard_pressure",
    copySlammerWhenSameHoleType: false,
    goalWeights: {
      profitMaxing: 4,
      ladderMaxing: 2,
      selfAwarenessMaxing: 3,
      discoveryMapping: 1,
    },
  });

  assert.equal(profile.effective.riskMode, "defensive");
  assert.equal(profile.effective.customStrategy, "late_diehard_pressure");
  assert.equal(profile.effective.copySlammerWhenSameHoleType, false);
  assert.equal(profile.goalWeightsPct.profitMaxing, 40);
  assert.equal(profile.goalWeightsPct.discoveryMapping, 10);
  assert.equal(profile.defaultsApplied.riskMode, false);
  assert.equal(profile.defaultsApplied.customStrategy, false);
  assert.equal(profile.defaultsApplied.copySlammerWhenSameHoleType, false);
});

test("normalizeGoalWeights falls back when the provided total is not positive", () => {
  const normalized = normalizeGoalWeights({
    profitMaxing: 0,
    ladderMaxing: 0,
    selfAwarenessMaxing: 0,
    discoveryMapping: 0,
  });

  assert.equal(normalized.profitMaxing, 0.25);
  assert.equal(normalized.discoveryMapping, 0.25);
});
