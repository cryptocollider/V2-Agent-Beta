import assert from "node:assert/strict";
import test from "node:test";
import { buildHonestPerformanceBaseline } from "./hps-baseline.js";

function row(ts: string, honestScore: number, outcome: number, value: number, game: number, temporal: number) {
  return {
    ts,
    honestScore: {
      schema: "collider.prediction.reveal.v1",
      honestScore,
      layers: {
        outcome: { score: outcome / 100 },
        value: { score: value / 100 },
        game: { score: game / 100 },
        temporal: { score: temporal / 100 },
      },
    },
  };
}

test("buildHonestPerformanceBaseline derives an empirical early window and lift", () => {
  const baseline = buildHonestPerformanceBaseline([
    row("2026-04-01T00:00:00.000Z", 50.0, 40, 45, 55, 52),
    row("2026-04-01T00:00:01.000Z", 50.5, 41, 46, 56, 53),
    row("2026-04-01T00:00:02.000Z", 49.5, 42, 44, 57, 54),
    row("2026-04-01T00:00:03.000Z", 50.2, 41, 45, 56, 53),
    row("2026-04-01T00:00:04.000Z", 50.1, 42, 46, 57, 54),
    row("2026-04-01T00:00:05.000Z", 50.4, 43, 47, 58, 55),
    row("2026-04-01T00:00:06.000Z", 65.0, 60, 62, 72, 68),
    row("2026-04-01T00:00:07.000Z", 66.0, 61, 63, 73, 69),
  ]);

  assert.equal(baseline.method, "agent_local_bootstrap_v2");
  assert.equal(baseline.availableScoredRows, 8);
  assert.equal(baseline.calibration.status, "stabilized");
  assert.equal(baseline.calibration.rowsConsumed, 6);
  assert.equal(baseline.calibration.stabilizedMetrics, 5);
  assert.equal(baseline.headline.stabilized, true);
  assert.equal(baseline.headline.sampleCountUsed, 6);
  assert.ok((baseline.headline.baselineScorePct ?? 0) > 49);
  assert.ok((baseline.headline.currentScorePct ?? 0) > (baseline.headline.baselineScorePct ?? 0));
  assert.ok((baseline.headline.liftPct ?? 0) > 0);
  assert.equal(baseline.layers.outcome.sampleCountUsed, 6);
  assert.ok((baseline.layers.temporal.liftPct ?? 0) > 0);
});

test("baseline keeps calibrating when layer drift exceeds the threshold", () => {
  const rows = Array.from({ length: 8 }, (_, i) => row(
    new Date(Date.UTC(2026, 3, 1, 0, 0, i)).toISOString(),
    50, 40 + i, 45, 55 + i, 52 + i,
  ));
  const baseline = buildHonestPerformanceBaseline(rows);
  assert.equal(baseline.calibration.status, "stabilizing");
  assert.equal(baseline.calibration.stabilizedMetrics, 2);
  assert.equal(baseline.layers.outcome.stabilized, false);
});
