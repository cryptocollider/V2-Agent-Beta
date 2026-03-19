import type { Candidate } from "./candidate-gen.js";
import type { ScoreConfig, RobustCandidateScore } from "./score.js";
import { scoreScenarioOutcome, combineScenarioScores } from "./score.js";
import type { CandidatePlanRun } from "../sim/planner.js";
import { diversificationPenaltyForShot } from "./score.js";

export type RankedCandidate = {
  candidate: Candidate;
  score: RobustCandidateScore;
  meta?: Record<string, unknown>;
};

export type SearchBudget = {
  maxCandidates?: number;
  maxMillis?: number;
  stopOnWinner?: boolean;
  winnerScoreThreshold?: number;
};

export type ChooseResult = {
  winner: RankedCandidate | null;
  ranked: RankedCandidate[];
  examinedCount: number;
  elapsedMs: number;
  stoppedBy: "empty" | "budget_candidates" | "budget_time" | "winner";
};

export function rankPlannedCandidates(
  planned: CandidatePlanRun[],
  scoreCfg: ScoreConfig = {},
): RankedCandidate[] {
  const ranked: RankedCandidate[] = [];

  for (const plan of planned) {
    const perScenario = plan.perScenario.map((ps) =>
      scoreScenarioOutcome(ps.scenario, ps.decoded, ps.syntheticThrowId, scoreCfg),
    );

    const combined = combineScenarioScores(perScenario, scoreCfg);

    const diversificationPenalty = diversificationPenaltyForShot(
      {
        x: plan.control.x,
        y: plan.control.y,
        angleDeg: plan.control.angleDeg,
        speedPct: plan.control.speedPct,
        spinPct: plan.control.spinPct,
      },
      scoreCfg,
    );
    
    combined.fragilityPenalty += diversificationPenalty;
    combined.final -= diversificationPenalty;

    ranked.push({
      candidate: {
        ...plan.control,
        source: "grid",
        tags: [],
      },
      score: combined,
      meta: {
        scenarioCount: plan.perScenario.length,
      },
    });
  }

  ranked.sort((a, b) => b.score.final - a.score.final);
  return ranked;
}

export function chooseBestRanked(
  rankedCandidates: RankedCandidate[],
  budget: SearchBudget = {},
): ChooseResult {
  const started = Date.now();
  const examined: RankedCandidate[] = [];

  const maxCandidates = Math.max(1, budget.maxCandidates ?? rankedCandidates.length);
  const maxMillis = Math.max(1, budget.maxMillis ?? Number.MAX_SAFE_INTEGER);
  const stopOnWinner = budget.stopOnWinner ?? false;
  const winnerScoreThreshold = budget.winnerScoreThreshold ?? Number.POSITIVE_INFINITY;

  let winner: RankedCandidate | null = null;
  let stoppedBy: ChooseResult["stoppedBy"] = "empty";

  for (let i = 0; i < rankedCandidates.length; i++) {
    const elapsed = Date.now() - started;
    if (elapsed >= maxMillis) {
      stoppedBy = "budget_time";
      break;
    }
    if (examined.length >= maxCandidates) {
      stoppedBy = "budget_candidates";
      break;
    }

    const rc = rankedCandidates[i];
    examined.push(rc);

    if (!winner || rc.score.final > winner.score.final) {
      winner = rc;
    }

    if (
      stopOnWinner &&
      Number.isFinite(winnerScoreThreshold) &&
      rc.score.final >= winnerScoreThreshold
    ) {
      stoppedBy = "winner";
      break;
    }
  }

  if (examined.length > 0 && stoppedBy === "empty") {
    stoppedBy = examined.length >= rankedCandidates.length ? "budget_candidates" : "empty";
  }

  return {
    winner,
    ranked: examined,
    examinedCount: examined.length,
    elapsedMs: Date.now() - started,
    stoppedBy,
  };
}