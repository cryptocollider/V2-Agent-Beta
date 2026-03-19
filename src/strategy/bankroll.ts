import type { AgentPolicy } from "../policy/schema.js";
import type { Candidate } from "./candidate-gen.js";

export type PositioningState = {
  smallThrowsPlaced: number;
  bigThrowsPlaced: number;
};

export type BalanceView = Record<string, string>;

export function parseAmountUsd(amountUsd: number | undefined): number {
  return Number.isFinite(amountUsd) ? Number(amountUsd) : 0;
}

export function classifyThrowSize(
  candidateUsd: number,
  policy: AgentPolicy,
): "small" | "big" {
  const threshold = policy.smallBigRatio?.bigThresholdUsd ?? 100;
  return candidateUsd >= threshold ? "big" : "small";
}

export function violatesSmallBigRatio(
  candidateUsd: number,
  policy: AgentPolicy,
  positioning: PositioningState,
): boolean {
  const ratio = policy.smallBigRatio;
  if (!ratio) return false;

  const kind = classifyThrowSize(candidateUsd, policy);

  if (kind === "small") return false;

  const nextBig = positioning.bigThrowsPlaced + 1;
  const requiredSmalls = nextBig * ratio.smallCount;
  return positioning.smallThrowsPlaced < requiredSmalls;
}

export function violatesMaxSingleThrow(
  candidateUsd: number,
  policy: AgentPolicy,
): boolean {
  if (policy.maxSingleThrowUsd == null) return false;
  return candidateUsd > policy.maxSingleThrowUsd;
}

export function bankrollPenalty(
  candidateUsd: number,
  policy: AgentPolicy,
  positioning: PositioningState,
): number {
  let penalty = 0;

  if (violatesMaxSingleThrow(candidateUsd, policy)) {
    penalty -= 1_000_000;
  }

  if (violatesSmallBigRatio(candidateUsd, policy, positioning)) {
    penalty -= 50_000;
  }

  return penalty;
}

export function isCandidateBlockedByBankroll(
  candidateUsd: number,
  policy: AgentPolicy,
  positioning: PositioningState,
): boolean {
  return (
    violatesMaxSingleThrow(candidateUsd, policy) ||
    violatesSmallBigRatio(candidateUsd, policy, positioning)
  );
}