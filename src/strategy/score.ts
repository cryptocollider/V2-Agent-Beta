import type { Hex32, QueueScenario } from "../collider/types.js";
import type { DecodedGameResult, DecodedThrowOutcome } from "../sim/decode.js";

export type ScoreBreakdown = {
  legality: number;
  bankroll: number;
  policy: number;
  payoutBias: number;
  holeBias: number;
  copyBias: number;
  diversification: number;
  learnedBias: number;
  robustness: number;
  total: number;
};

export type ScenarioScore = {
  scenario: QueueScenario;
  outcome: DecodedThrowOutcome | null;
  breakdown: ScoreBreakdown;
};

export type RobustCandidateScore = {
  perScenario: ScenarioScore[];
  weightedTotal: number;
  worstCaseTotal: number;
  bestCaseTotal: number;
  fragilityPenalty: number;
  final: number;
};

export type RecentShot = {
  x: number;
  y: number;
  angleDeg: number;
  speedPct: number;
  spinPct: number;
};

export type ScoreConfig = {
  preferredHoleTypes?: number[];
  blockedHoleTypes?: number[];
  robustnessWeight?: number;
  fragilityWeight?: number;
  recentShots?: RecentShot[];
};

function scoreHoleType(
  holeType: number | null | undefined,
  cfg: ScoreConfig,
): number {
  if (holeType == null) return -50_000;

  if (cfg.blockedHoleTypes?.includes(holeType)) {
    return -100_000;
  }

  if (cfg.preferredHoleTypes?.includes(holeType)) {
    return 25_000;
  }

  return 0;
}

function scoreOutcomeBasic(
  outcome: DecodedThrowOutcome | null,
  result: DecodedGameResult,
  cfg: ScoreConfig,
): ScoreBreakdown {
  const legality = outcome ? 0 : -1_000_000;
  const bankroll = 0;
  const policy = 0;
  const payoutBias = 0;
  const holeBias = scoreHoleType(outcome?.hole_type, cfg);
  const copyBias = 0;
  const diversification = 0;
  const learnedBias = 0;
  const robustness = 0;

  // Slight preference for quicker resolved throws, if outcome exists.
  const frameBias = outcome ? Math.max(0, 5_000 - outcome.endFrame) : 0;

  const total =
    legality +
    bankroll +
    policy +
    payoutBias +
    holeBias +
    copyBias +
    diversification +
    learnedBias +
    robustness +
    frameBias;

  return {
    legality,
    bankroll,
    policy,
    payoutBias,
    holeBias: holeBias + frameBias,
    copyBias,
    diversification,
    learnedBias,
    robustness,
    total,
  };
}

export function scoreScenarioOutcome(
  scenario: QueueScenario,
  result: DecodedGameResult,
  syntheticThrowId: Hex32,
  cfg: ScoreConfig = {},
): ScenarioScore {
  const outcome = result.per_throw.find((o) => o.throw_id === syntheticThrowId) ?? null;
  const breakdown = scoreOutcomeBasic(outcome, result, cfg);

  return {
    scenario,
    outcome,
    breakdown,
  };
}

export function combineScenarioScores(
  perScenario: ScenarioScore[],
  cfg: ScoreConfig = {},
): RobustCandidateScore {
  if (perScenario.length === 0) {
    return {
      perScenario,
      weightedTotal: -1_000_000,
      worstCaseTotal: -1_000_000,
      bestCaseTotal: -1_000_000,
      fragilityPenalty: 0,
      final: -1_000_000,
    };
  }

  let weightSum = 0;
  let weightedTotal = 0;
  let bestCaseTotal = -Infinity;
  let worstCaseTotal = Infinity;

  for (const s of perScenario) {
    const w = s.scenario.weight ?? 1;
    weightSum += w;
    weightedTotal += s.breakdown.total * w;
    bestCaseTotal = Math.max(bestCaseTotal, s.breakdown.total);
    worstCaseTotal = Math.min(worstCaseTotal, s.breakdown.total);
  }

  weightedTotal = weightSum > 0 ? weightedTotal / weightSum : weightedTotal;

  const fragilityPenalty =
    (bestCaseTotal - worstCaseTotal) * (cfg.fragilityWeight ?? 0.25);

  const final =
    weightedTotal * (cfg.robustnessWeight ?? 1.0) - fragilityPenalty;

  return {
    perScenario,
    weightedTotal,
    worstCaseTotal,
    bestCaseTotal,
    fragilityPenalty,
    final,
  };
}

function shotDistance(a: RecentShot, b: RecentShot): number {
  return (
    Math.abs(a.x - b.x) +
    Math.abs(a.y - b.y) +
    Math.abs(a.angleDeg - b.angleDeg) * 4 +
    Math.abs(a.speedPct - b.speedPct) * 3 +
    Math.abs(a.spinPct - b.spinPct) * 2
  );
}

export function diversificationPenaltyForShot(
  shot: RecentShot,
  cfg: ScoreConfig,
): number {
  const recent = cfg.recentShots ?? [];
  if (!recent.length) return 0;

  let penalty = 0;
  for (const prev of recent) {
    const d = shotDistance(shot, prev);
    if (d < 40) penalty += 1200;
    else if (d < 120) penalty += 300;
  }
  return penalty;
}