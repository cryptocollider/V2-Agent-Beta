import assert from "node:assert/strict";
import test from "node:test";
import { computeTemporalCertaintyBreach, computeTemporalCertaintyWeight } from "./honest-score.js";

test("computeTemporalCertaintyWeight rises as the forecast gets closer to resolution", () => {
  assert.equal(computeTemporalCertaintyWeight(0, 100), 0);
  assert.equal(computeTemporalCertaintyWeight(50, 100), 0.5);
  assert.equal(computeTemporalCertaintyWeight(95, 100), 0.95);
  assert.equal(computeTemporalCertaintyWeight(100, 100), 1);
});

test("computeTemporalCertaintyBreach punishes late obvious misses more than early misses", () => {
  const early = computeTemporalCertaintyBreach({
    referenceFrame: 10,
    actualEndFrame: 100,
    outcomeError: 1,
    valueError: 1,
    endFrameError: 1,
  });
  const late = computeTemporalCertaintyBreach({
    referenceFrame: 95,
    actualEndFrame: 100,
    outcomeError: 1,
    valueError: 1,
    endFrameError: 1,
  });

  assert.ok((early ?? 0) < (late ?? 0));
  assert.equal(late, 0.95);
});
