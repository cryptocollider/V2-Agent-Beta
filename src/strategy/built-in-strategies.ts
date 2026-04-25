import type { SimRunInput } from "../collider/types.js";
import type { PredictionSummary } from "../agent/prediction-log.js";
import type { CandidatePlanRun } from "../sim/planner.js";
import type { RobustCandidateScore } from "./score.js";

export type BuiltInStrategyName =
  | "copy_slammers"
  | "toughnut_never_lose"
  | "nutjob_discovery"
  | "peanut_safe_flow"
  | "prof_meta_rotator";

export type BuiltInStrategyApplication = {
  strategy: BuiltInStrategyName | null;
  scoreDelta: number;
  adjustedScore: RobustCandidateScore;
  notes: string[];
  projectedFinalFrame: number | null;
};

type StrategyCoreResult = {
  scoreDelta: number;
  notes: string[];
  projectedFinalFrame: number | null;
};

type StrategyParams = {
  baseScore: RobustCandidateScore;
  prediction: PredictionSummary | null;
  plan: CandidatePlanRun | null | undefined;
  simInput: SimRunInput;
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function weightedAverage(entries: Array<{ value: number | null; weight: number }>): number | null {
  let weightedSum = 0;
  let weightSum = 0;
  for (const entry of entries) {
    if (entry.value == null || !Number.isFinite(entry.value) || !(entry.weight > 0)) continue;
    weightedSum += entry.value * entry.weight;
    weightSum += entry.weight;
  }
  return weightSum > 0 ? weightedSum / weightSum : null;
}

function latestReferenceFrame(simInput: SimRunInput): number {
  return (simInput.throws ?? []).reduce((max, throwRecord) => Math.max(max, Number(throwRecord.enter_frame ?? 0)), 0);
}

export function projectedFinalFrameFromPlan(plan: CandidatePlanRun | null | undefined): number | null {
  if (!plan?.perScenario?.length) return null;
  return weightedAverage(
    plan.perScenario.map((scenarioRun) => ({
      value: Number.isFinite(Number(scenarioRun.decoded?.end_frame)) ? Number(scenarioRun.decoded.end_frame) : null,
      weight: Number(scenarioRun.scenario?.weight ?? 1),
    })),
  );
}

function scenarioFrameSpread(plan: CandidatePlanRun | null | undefined): number {
  const frames = (plan?.perScenario ?? [])
    .map((scenarioRun) => Number(scenarioRun.decoded?.end_frame ?? NaN))
    .filter((value) => Number.isFinite(value));
  if (!frames.length) return 0;
  return Math.max(...frames) - Math.min(...frames);
}

function planWindowStats(plan: CandidatePlanRun | null | undefined, simInput: SimRunInput): {
  projectedFinalFrame: number | null;
  extensionRatio: number;
  frameSpread: number;
} {
  const projectedFinalFrame = projectedFinalFrameFromPlan(plan);
  const referenceFrame = latestReferenceFrame(simInput);
  const frameSpread = scenarioFrameSpread(plan);
  const frameCap = Math.max(
    referenceFrame + 1,
    Number(simInput.game?.frame_cap ?? 0),
    Math.ceil(projectedFinalFrame ?? 0),
  );
  const extensionRatio = projectedFinalFrame == null
    ? 0
    : clamp((projectedFinalFrame - referenceFrame) / Math.max(1, frameCap - referenceFrame), 0, 1);
  return { projectedFinalFrame, extensionRatio, frameSpread };
}

export function normalizeBuiltInStrategyName(value: unknown): BuiltInStrategyName | null {
  const candidate = String(value ?? "").trim().toLowerCase();
  if (
    candidate === "copy_slammers"
    || candidate === "toughnut_never_lose"
    || candidate === "nutjob_discovery"
    || candidate === "peanut_safe_flow"
    || candidate === "prof_meta_rotator"
  ) {
    return candidate;
  }
  return null;
}

function withScoreDelta(score: RobustCandidateScore, scoreDelta: number): RobustCandidateScore {
  if (!(scoreDelta !== 0)) return score;
  return {
    ...score,
    weightedTotal: score.weightedTotal + scoreDelta,
    worstCaseTotal: score.worstCaseTotal + scoreDelta,
    bestCaseTotal: score.bestCaseTotal + scoreDelta,
    final: score.final + scoreDelta,
  };
}

function finalizeApplication(
  strategy: BuiltInStrategyName | null,
  baseScore: RobustCandidateScore,
  core: StrategyCoreResult,
): BuiltInStrategyApplication {
  return {
    strategy,
    scoreDelta: core.scoreDelta,
    adjustedScore: withScoreDelta(baseScore, core.scoreDelta),
    notes: core.notes,
    projectedFinalFrame: core.projectedFinalFrame,
  };
}

function candidateHoleDelta(holeType: number | null): { delta: number; note: string | null } {
  switch (holeType) {
    case 3:
      return { delta: 3200, note: "winner_bias" };
    case 1:
      return { delta: 1200, note: "draw_preserve_bias" };
    case 5:
      return { delta: 300, note: "low_bleed_bias" };
    case 4:
      return { delta: -1800, note: "half_loss_penalty" };
    case 2:
      return { delta: -4600, note: "avoid_total_loss" };
    default:
      return { delta: 0, note: null };
  }
}

function safeHoleDelta(holeType: number | null): { delta: number; note: string | null } {
  switch (holeType) {
    case 1:
      return { delta: 2600, note: "draw_capital_preserve" };
    case 5:
      return { delta: 1900, note: "low_bleed_control" };
    case 3:
      return { delta: 1300, note: "clean_winner_bias" };
    case 4:
      return { delta: -1700, note: "half_loss_penalty" };
    case 2:
      return { delta: -4200, note: "total_loss_penalty" };
    default:
      return { delta: 0, note: null };
  }
}

function uniquePredictedHoleKinds(prediction: PredictionSummary | null): number {
  const keys = Object.entries(prediction?.holeTypeCounts ?? {})
    .filter(([, count]) => Number(count) > 0)
    .map(([key]) => key);
  return new Set(keys).size;
}

function controlWeirdness(plan: CandidatePlanRun | null | undefined): number {
  const control = plan?.control;
  if (!control) return 0;
  const spin = clamp(Math.abs(Number(control.spinPct ?? 0)) / 30, 0, 1);
  const angle = clamp(Math.abs(Number(control.angleDeg ?? 0)) / 90, 0, 1);
  const speed = clamp(Math.abs(Number(control.speedPct ?? 50) - 50) / 50, 0, 1);
  return clamp((spin + angle + speed) / 3, 0, 1);
}

function pnlRange(prediction: PredictionSummary | null): number | null {
  const best = Number(prediction?.bestPnlUsd ?? NaN);
  const worst = Number(prediction?.worstPnlUsd ?? NaN);
  if (!Number.isFinite(best) || !Number.isFinite(worst)) return null;
  return Math.abs(best - worst);
}

function applyToughNutNeverLoseCore(params: Omit<StrategyParams, "baseScore">): StrategyCoreResult {
  const { prediction, plan, simInput } = params;
  const notes: string[] = [];
  let scoreDelta = 0;

  const { projectedFinalFrame, extensionRatio } = planWindowStats(plan, simInput);

  const pnlUsd = prediction?.pnlUsd ?? null;
  if (pnlUsd != null && Number.isFinite(pnlUsd)) {
    if (pnlUsd >= 0) {
      scoreDelta += Math.min(9000, pnlUsd * 450);
      notes.push("projected_non_loss");
    } else {
      scoreDelta -= Math.min(12000, Math.abs(pnlUsd) * 550);
      notes.push("projected_loss_penalty");

      if (extensionRatio > 0) {
        scoreDelta += extensionRatio * 5200;
        notes.push("prefer_longer_recovery_window");
      }

      const recoveryHeadroom = Math.max(0, (prediction?.bestPnlUsd ?? pnlUsd) - pnlUsd);
      if (recoveryHeadroom > 0) {
        scoreDelta += Math.min(2600, recoveryHeadroom * 250);
        notes.push("scenario_recovery_headroom");
      }
    }
  }

  const holeDelta = candidateHoleDelta(prediction?.holeType ?? null);
  scoreDelta += holeDelta.delta;
  if (holeDelta.note) notes.push(holeDelta.note);

  const winnerValuePct = prediction?.winnerValuePct ?? null;
  if (winnerValuePct != null && Number.isFinite(winnerValuePct)) {
    const centered = clamp((winnerValuePct - 50) / 50, -1, 1);
    scoreDelta += centered * 900;
    if (winnerValuePct >= 60) {
      notes.push("winner_share_upside");
    }
  }

  return {
    scoreDelta,
    notes,
    projectedFinalFrame,
  };
}

function applyNutJobDiscoveryCore(params: Omit<StrategyParams, "baseScore">): StrategyCoreResult {
  const { prediction, plan, simInput } = params;
  const notes: string[] = [];
  let scoreDelta = 0;

  const { projectedFinalFrame, extensionRatio, frameSpread } = planWindowStats(plan, simInput);
  const spreadRatio = clamp(frameSpread / 1200, 0, 1);
  if (spreadRatio > 0) {
    scoreDelta += spreadRatio * 4600;
    notes.push("wide_branch_exploration");
  }

  const holeKinds = uniquePredictedHoleKinds(prediction);
  if (holeKinds > 1) {
    scoreDelta += Math.min(3600, (holeKinds - 1) * 1200);
    notes.push("multi_hole_probe");
  }

  const weirdness = controlWeirdness(plan);
  if (weirdness > 0.2) {
    scoreDelta += weirdness * 2600;
    notes.push("novel_control_shape");
  }

  if (extensionRatio > 0.35) {
    scoreDelta += extensionRatio * 1700;
    notes.push("long_arc_experiment");
  }

  const pnlUsd = prediction?.pnlUsd ?? null;
  const bestPnlUsd = prediction?.bestPnlUsd ?? null;
  if (pnlUsd != null && bestPnlUsd != null && Number.isFinite(pnlUsd) && Number.isFinite(bestPnlUsd)) {
    const upside = Math.max(0, bestPnlUsd - pnlUsd);
    if (upside > 0.5) {
      scoreDelta += Math.min(2400, upside * 240);
      notes.push("upside_probe");
    }
    if (pnlUsd < -6) {
      scoreDelta -= Math.min(2500, Math.abs(pnlUsd) * 120);
      notes.push("catastrophic_probe_penalty");
    }
  }

  switch (prediction?.holeType ?? null) {
    case 4:
      scoreDelta += 900;
      notes.push("half_loss_research_bias");
      break;
    case 3:
      scoreDelta += 700;
      notes.push("winner_spike_probe");
      break;
    case 5:
      scoreDelta += 500;
      notes.push("edge_tier_probe");
      break;
    default:
      break;
  }

  return {
    scoreDelta,
    notes,
    projectedFinalFrame,
  };
}

function applyPeanutSafeFlowCore(params: Omit<StrategyParams, "baseScore">): StrategyCoreResult {
  const { prediction, plan, simInput } = params;
  const notes: string[] = [];
  let scoreDelta = 0;

  const { projectedFinalFrame, extensionRatio } = planWindowStats(plan, simInput);
  const pnlUsd = prediction?.pnlUsd ?? null;
  if (pnlUsd != null && Number.isFinite(pnlUsd)) {
    if (pnlUsd >= 0) {
      scoreDelta += 1500 + Math.min(7000, pnlUsd * 550);
      notes.push("projected_safe_profit");
    } else {
      scoreDelta -= Math.min(9500, Math.abs(pnlUsd) * 650);
      notes.push("projected_loss_penalty");
    }
  }

  const worstPnlUsd = prediction?.worstPnlUsd ?? null;
  if (worstPnlUsd != null && Number.isFinite(worstPnlUsd)) {
    if (worstPnlUsd >= -0.5) {
      scoreDelta += 1800;
      notes.push("worst_case_preserved");
    } else if (worstPnlUsd <= -5) {
      scoreDelta -= 1800;
      notes.push("worst_case_drop");
    }
  }

  const range = pnlRange(prediction);
  if (range != null) {
    if (range <= 2) {
      scoreDelta += 2200;
      notes.push("low_variance_bias");
    } else {
      const penalty = clamp((range - 2) / 10, 0, 1) * 2600;
      if (penalty > 0) {
        scoreDelta -= penalty;
        notes.push("high_variance_penalty");
      }
    }
  }

  const holeDelta = safeHoleDelta(prediction?.holeType ?? null);
  scoreDelta += holeDelta.delta;
  if (holeDelta.note) notes.push(holeDelta.note);

  if (extensionRatio > 0) {
    scoreDelta += (1 - extensionRatio) * 1200;
    notes.push("prefer_quick_clarity");
  }

  return {
    scoreDelta,
    notes,
    projectedFinalFrame,
  };
}

function applyProfMetaRotatorCore(params: Omit<StrategyParams, "baseScore">): StrategyCoreResult {
  const tough = applyToughNutNeverLoseCore(params);
  const peanut = applyPeanutSafeFlowCore(params);
  const nutjob = applyNutJobDiscoveryCore(params);

  const weighted =
    tough.scoreDelta * 0.37 +
    peanut.scoreDelta * 0.35 +
    nutjob.scoreDelta * 0.28;

  const support = [
    { name: "toughnut", delta: tough.scoreDelta },
    { name: "peanut", delta: peanut.scoreDelta },
    { name: "nutjob", delta: nutjob.scoreDelta },
  ].filter((entry) => entry.delta > 0);

  const notes: string[] = [];
  let scoreDelta = weighted;

  if (support.length >= 2) {
    scoreDelta += 900 * support.length;
    notes.push(`cross_style_alignment:${support.map((entry) => entry.name).join('+')}`);
  } else if (support.length === 1) {
    notes.push(`single_style_signal:${support[0].name}`);
  }

  const deltas = [tough.scoreDelta, peanut.scoreDelta, nutjob.scoreDelta];
  const disagreement = Math.max(...deltas) - Math.min(...deltas);
  if (disagreement > 6000) {
    scoreDelta -= 1200;
    notes.push("high_persona_disagreement");
  }

  if (nutjob.scoreDelta > 0 && peanut.scoreDelta > 0) notes.push("hybrid_explore_then_stabilize");
  if (tough.scoreDelta > 0 && peanut.scoreDelta > 0) notes.push("resilient_capital_preserve");

  return {
    scoreDelta,
    notes,
    projectedFinalFrame: tough.projectedFinalFrame ?? peanut.projectedFinalFrame ?? nutjob.projectedFinalFrame,
  };
}

export function applyBuiltInStrategyBias(params: {
  strategyName: unknown;
  baseScore: RobustCandidateScore;
  prediction: PredictionSummary | null;
  plan: CandidatePlanRun | null | undefined;
  simInput: SimRunInput;
}): BuiltInStrategyApplication {
  const strategy = normalizeBuiltInStrategyName(params.strategyName);
  const coreParams = {
    prediction: params.prediction,
    plan: params.plan,
    simInput: params.simInput,
  };

  if (strategy === "toughnut_never_lose") {
    return finalizeApplication(strategy, params.baseScore, applyToughNutNeverLoseCore(coreParams));
  }
  if (strategy === "nutjob_discovery") {
    return finalizeApplication(strategy, params.baseScore, applyNutJobDiscoveryCore(coreParams));
  }
  if (strategy === "peanut_safe_flow") {
    return finalizeApplication(strategy, params.baseScore, applyPeanutSafeFlowCore(coreParams));
  }
  if (strategy === "prof_meta_rotator") {
    return finalizeApplication(strategy, params.baseScore, applyProfMetaRotatorCore(coreParams));
  }

  return {
    strategy,
    scoreDelta: 0,
    adjustedScore: params.baseScore,
    notes: [],
    projectedFinalFrame: projectedFinalFrameFromPlan(params.plan),
  };
}
