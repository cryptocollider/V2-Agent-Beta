import type { HonestScoreLogView } from "./storage.js";

export type HonestScoreRowLike = {
  ts?: string | null;
  honestScore?: HonestScoreLogView | null;
};

export type BaselineMetricSummary = {
  baselineScorePct: number | null;
  currentScorePct: number | null;
  liftPct: number | null;
  deltaPct: number | null;
  sampleCountUsed: number;
  stableAt: number | null;
  stabilized: boolean;
};

export type BaselineCalibrationStatus = "insufficient_rows" | "stabilizing" | "stabilized";

export type BaselineCalibrationState = {
  status: BaselineCalibrationStatus;
  rowsConsumed: number;
  stableAt: number | null;
  stabilizedMetrics: number;
  totalMetrics: number;
};

export type HonestPerformanceBaseline = {
  method: "agent_local_bootstrap_v2";
  availableScoredRows: number;
  minWindow: number;
  maxWindow: number;
  compareWindow: number;
  driftThresholdPct: number;
  calibration: BaselineCalibrationState;
  headline: BaselineMetricSummary;
  layers: {
    outcome: BaselineMetricSummary;
    value: BaselineMetricSummary;
    game: BaselineMetricSummary;
    temporal: BaselineMetricSummary;
  };
  notes: string[];
};

const MIN_WINDOW = 4;
const MAX_WINDOW = 24;
const COMPARE_WINDOW = 3;
const STABLE_DRIFT_PCT = 2.5;
const DEFAULT_WINDOW = 8;

function mean(values: number[]): number | null {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function finiteValues(values: Array<number | null | undefined>): number[] {
  return values
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value));
}

function computeLiftPct(currentScorePct: number | null, baselineScorePct: number | null): number | null {
  if (currentScorePct == null || baselineScorePct == null) return null;
  if (currentScorePct >= baselineScorePct) {
    return ((currentScorePct - baselineScorePct) / Math.max(1, 100 - baselineScorePct)) * 100;
  }
  return -((baselineScorePct - currentScorePct) / Math.max(1, baselineScorePct)) * 100;
}

function resolveBaselineWindow(values: number[]): {
  sampleCountUsed: number;
  stableAt: number | null;
  stabilized: boolean;
} {
  const cappedLength = Math.min(values.length, MAX_WINDOW);
  if (cappedLength === 0) {
    return { sampleCountUsed: 0, stableAt: null, stabilized: false };
  }
  if (cappedLength < MIN_WINDOW) {
    return { sampleCountUsed: cappedLength, stableAt: null, stabilized: false };
  }

  for (let end = Math.max(MIN_WINDOW, COMPARE_WINDOW * 2); end <= cappedLength; end++) {
    const previousMean = mean(values.slice(end - (COMPARE_WINDOW * 2), end - COMPARE_WINDOW));
    const recentMean = mean(values.slice(end - COMPARE_WINDOW, end));
    if (previousMean == null || recentMean == null) continue;
    if (Math.abs(recentMean - previousMean) <= STABLE_DRIFT_PCT) {
      return { sampleCountUsed: end, stableAt: end, stabilized: true };
    }
  }

  return {
    sampleCountUsed: Math.min(cappedLength, Math.max(MIN_WINDOW, DEFAULT_WINDOW)),
    stableAt: null,
    stabilized: false,
  };
}

function resolveCalibrationState(metrics: BaselineMetricSummary[]): BaselineCalibrationState {
  const rowsConsumed = metrics.reduce((maxValue, metric) => Math.max(maxValue, metric.sampleCountUsed || 0), 0);
  const stabilizedMetrics = metrics.filter((metric) => metric.stabilized).length;
  const stableAtValues = metrics
    .map((metric) => metric.stableAt)
    .filter((value): value is number => value != null && Number.isFinite(value));
  const stableAt = stableAtValues.length === metrics.length ? Math.max(...stableAtValues) : null;
  const status: BaselineCalibrationStatus = rowsConsumed < MIN_WINDOW
    ? "insufficient_rows"
    : stabilizedMetrics === metrics.length
      ? "stabilized"
      : "stabilizing";

  return {
    status,
    rowsConsumed,
    stableAt,
    stabilizedMetrics,
    totalMetrics: metrics.length,
  };
}

function buildMetricSummary(values: number[]): BaselineMetricSummary {
  const currentScorePct = mean(values);
  const { sampleCountUsed, stableAt, stabilized } = resolveBaselineWindow(values);
  const baselineScorePct = sampleCountUsed > 0 ? mean(values.slice(0, sampleCountUsed)) : null;
  const deltaPct = (currentScorePct != null && baselineScorePct != null)
    ? currentScorePct - baselineScorePct
    : null;

  return {
    baselineScorePct,
    currentScorePct,
    liftPct: computeLiftPct(currentScorePct, baselineScorePct),
    deltaPct,
    sampleCountUsed,
    stableAt,
    stabilized,
  };
}

export function buildHonestPerformanceBaseline(rows: HonestScoreRowLike[]): HonestPerformanceBaseline {
  const ordered = [...rows].sort((a, b) => new Date(a?.ts || 0).getTime() - new Date(b?.ts || 0).getTime());

  const headlineValues = finiteValues(ordered.map((row) => row?.honestScore?.honestScore));
  const outcomeValues = finiteValues(ordered.map((row) => {
    const value = row?.honestScore?.layers?.outcome?.score;
    return value == null ? null : Number(value) * 100;
  }));
  const valueValues = finiteValues(ordered.map((row) => {
    const value = row?.honestScore?.layers?.value?.score;
    return value == null ? null : Number(value) * 100;
  }));
  const gameValues = finiteValues(ordered.map((row) => {
    const value = row?.honestScore?.layers?.game?.score;
    return value == null ? null : Number(value) * 100;
  }));
  const temporalValues = finiteValues(ordered.map((row) => {
    const value = row?.honestScore?.layers?.temporal?.score;
    return value == null ? null : Number(value) * 100;
  }));

  const headline = buildMetricSummary(headlineValues);
  const layers = {
    outcome: buildMetricSummary(outcomeValues),
    value: buildMetricSummary(valueValues),
    game: buildMetricSummary(gameValues),
    temporal: buildMetricSummary(temporalValues),
  };
  const calibration = resolveCalibrationState([
    headline,
    layers.outcome,
    layers.value,
    layers.game,
    layers.temporal,
  ]);

  return {
    method: "agent_local_bootstrap_v2",
    availableScoredRows: ordered.length,
    minWindow: MIN_WINDOW,
    maxWindow: MAX_WINDOW,
    compareWindow: COMPARE_WINDOW,
    driftThresholdPct: STABLE_DRIFT_PCT,
    calibration,
    headline,
    layers,
    notes: [
      "Raw HPS stays untouched. Baseline lift is a separate agent-local calibration overlay derived from this agent's own earliest scored rows.",
      "Calibration stops consuming extra rows once the empirical start state stabilizes; later rows still affect current raw HPS, not the frozen baseline window.",
      "A positive lift means the current aggregate is outperforming the calibrated start state. A negative lift means it is underperforming that start state.",
      "Layer baselines are resolved independently because outcome, value, game, and temporal truth surfaces stabilize at different speeds.",
    ],
  };
}
