import crypto from "node:crypto";
import type { PredictionSummary } from "../agent/prediction-log.js";
import { cleanHex } from "../agent/eligibility.js";
import type { Hex32 } from "../collider/types.js";
import type { Candidate, CandidateSource } from "./candidate-gen.js";
import type { RobustCandidateScore } from "./score.js";

export type ScoreView = Pick<
  RobustCandidateScore,
  "weightedTotal" | "worstCaseTotal" | "bestCaseTotal" | "fragilityPenalty" | "final"
>;

export type OverlayAdjustment = {
  kind: string;
  key?: string;
  delta?: number;
  value?: number | string | null;
};

export type ManagerTacticalOverlay = {
  id: string;
  updatedAt: string;
  preferredHoleTypes?: number[];
  blockedHoleTypes?: number[];
  preferredHoleTypeBonus?: number;
  blockedHoleTypePenalty?: number;
  holeTypeScoreDeltas?: Record<string, number>;
  assetScoreDeltas?: Record<string, number>;
  candidateSourceScoreDeltas?: Partial<Record<CandidateSource, number>>;
  pnlBiasUsd?: number;
  winnerValuePctBias?: number;
  candidateScoreDeltas?: Record<string, number>;
  expiresAt?: string | null;
  notes?: string[];
};

export type ManagerFutureThrowSpec = {
  id: string;
  label?: string;
  user?: Hex32;
  x: number;
  y: number;
  angleDeg: number;
  speedPct: number;
  spinPct: number;
  asset: string;
  amount: string;
  enterFrameOffset?: number;
  acceptedAtHeightOffset?: number;
  enabled: boolean;
  tags?: string[];
  notes?: string[];
};

export type ManagerFutureScenario = {
  id: string;
  label?: string;
  weight?: number;
  futureThrows: ManagerFutureThrowSpec[];
  notes?: string[];
};

export type ManagerCandidateSpec = {
  id: string;
  label?: string;
  x: number;
  y: number;
  angleDeg: number;
  speedPct: number;
  spinPct: number;
  asset: string;
  amount: string;
  enabled: boolean;
  tags?: string[];
  notes?: string[];
  futureScenarios?: ManagerFutureScenario[];
};

export type ManagerCandidateSet = {
  id: string;
  updatedAt: string;
  expiresAt?: string | null;
  notes?: string[];
  candidates: ManagerCandidateSpec[];
};

export type OverlayApplication = {
  active: boolean;
  scoreDelta: number;
  adjustments: OverlayAdjustment[];
  adjustedScore: ScoreView;
  adjustedPrediction: PredictionSummary | null;
};

export type RankedCandidateContext = {
  rank: number;
  candidateHash: string;
  candidate: Candidate;
  baseScore: ScoreView;
  adjustedScore: ScoreView;
  basePrediction: PredictionSummary | null;
  adjustedPrediction: PredictionSummary | null;
  overlay: {
    active: boolean;
    scoreDelta: number;
    adjustments: OverlayAdjustment[];
  };
};

export type LatestCandidateContext = {
  ts: string;
  gameId: string | null;
  stoppedBy: string | null;
  winnerCandidateHash: string | null;
  overlay: ManagerTacticalOverlay | null;
  managerCandidateSet: ManagerCandidateSet | null;
  candidates: RankedCandidateContext[];
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function cleanNotes(input: unknown): string[] {
  return Array.isArray(input) ? input.map((note) => String(note)).filter(Boolean) : [];
}

function finiteNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function cleanMaybeHex(value: unknown): string | undefined {
  const cleaned = cleanHex(value);
  return cleaned || undefined;
}

export function scoreViewFromRobustScore(score: RobustCandidateScore): ScoreView {
  return {
    weightedTotal: score.weightedTotal,
    worstCaseTotal: score.worstCaseTotal,
    bestCaseTotal: score.bestCaseTotal,
    fragilityPenalty: score.fragilityPenalty,
    final: score.final,
  };
}

function clonePrediction(prediction: PredictionSummary | null): PredictionSummary | null {
  return prediction ? JSON.parse(JSON.stringify(prediction)) as PredictionSummary : null;
}

export function normalizeManagerTacticalOverlay(input: Partial<ManagerTacticalOverlay>): ManagerTacticalOverlay {
  return {
    id: String(input.id || "manager-overlay"),
    updatedAt: input.updatedAt || new Date().toISOString(),
    preferredHoleTypes: (input.preferredHoleTypes ?? []).map(Number).filter(Number.isFinite),
    blockedHoleTypes: (input.blockedHoleTypes ?? []).map(Number).filter(Number.isFinite),
    preferredHoleTypeBonus: Number.isFinite(Number(input.preferredHoleTypeBonus)) ? Number(input.preferredHoleTypeBonus) : 25_000,
    blockedHoleTypePenalty: Number.isFinite(Number(input.blockedHoleTypePenalty)) ? Number(input.blockedHoleTypePenalty) : -100_000,
    holeTypeScoreDeltas: { ...(input.holeTypeScoreDeltas ?? {}) },
    assetScoreDeltas: { ...(input.assetScoreDeltas ?? {}) },
    candidateSourceScoreDeltas: { ...(input.candidateSourceScoreDeltas ?? {}) },
    pnlBiasUsd: Number.isFinite(Number(input.pnlBiasUsd)) ? Number(input.pnlBiasUsd) : 0,
    winnerValuePctBias: Number.isFinite(Number(input.winnerValuePctBias)) ? Number(input.winnerValuePctBias) : 0,
    candidateScoreDeltas: { ...(input.candidateScoreDeltas ?? {}) },
    expiresAt: input.expiresAt ?? null,
    notes: cleanNotes(input.notes),
  };
}

function normalizeManagerFutureThrowSpec(input: Partial<ManagerFutureThrowSpec>, index: number): ManagerFutureThrowSpec {
  return {
    id: String(input.id || `manager-future-throw-${index + 1}`),
    label: input.label ? String(input.label) : undefined,
    user: cleanMaybeHex(input.user),
    x: finiteNumber(input.x),
    y: finiteNumber(input.y),
    angleDeg: finiteNumber(input.angleDeg),
    speedPct: finiteNumber(input.speedPct),
    spinPct: finiteNumber(input.spinPct),
    asset: cleanHex(input.asset),
    amount: String(input.amount ?? "0"),
    enterFrameOffset: Number.isFinite(Number(input.enterFrameOffset)) ? Number(input.enterFrameOffset) : undefined,
    acceptedAtHeightOffset: Number.isFinite(Number(input.acceptedAtHeightOffset)) ? Number(input.acceptedAtHeightOffset) : undefined,
    enabled: input.enabled !== false,
    tags: Array.isArray(input.tags) ? input.tags.map((tag) => String(tag)).filter(Boolean) : [],
    notes: cleanNotes(input.notes),
  };
}

function normalizeManagerFutureScenario(input: Partial<ManagerFutureScenario>, index: number): ManagerFutureScenario {
  return {
    id: String(input.id || `manager-future-scenario-${index + 1}`),
    label: input.label ? String(input.label) : undefined,
    weight: Number.isFinite(Number(input.weight)) ? Number(input.weight) : 1,
    futureThrows: Array.isArray(input.futureThrows)
      ? input.futureThrows.map((futureThrow, futureIndex) => normalizeManagerFutureThrowSpec(futureThrow, futureIndex))
      : [],
    notes: cleanNotes(input.notes),
  };
}

function normalizeManagerCandidateSpec(input: Partial<ManagerCandidateSpec>, index: number): ManagerCandidateSpec {
  return {
    id: String(input.id || `manager-candidate-${index + 1}`),
    label: input.label ? String(input.label) : undefined,
    x: finiteNumber(input.x),
    y: finiteNumber(input.y),
    angleDeg: finiteNumber(input.angleDeg),
    speedPct: finiteNumber(input.speedPct),
    spinPct: finiteNumber(input.spinPct),
    asset: cleanHex(input.asset),
    amount: String(input.amount ?? "0"),
    enabled: input.enabled !== false,
    tags: Array.isArray(input.tags) ? input.tags.map((tag) => String(tag)).filter(Boolean) : [],
    notes: cleanNotes(input.notes),
    futureScenarios: Array.isArray(input.futureScenarios)
      ? input.futureScenarios.map((scenario, scenarioIndex) => normalizeManagerFutureScenario(scenario, scenarioIndex))
      : [],
  };
}

export function normalizeManagerCandidateSet(input: Partial<ManagerCandidateSet>): ManagerCandidateSet {
  const candidates = Array.isArray(input.candidates)
    ? input.candidates.map((candidate, index) => normalizeManagerCandidateSpec(candidate, index))
    : [];

  return {
    id: String(input.id || "manager-candidate-set"),
    updatedAt: input.updatedAt || new Date().toISOString(),
    expiresAt: input.expiresAt ?? null,
    notes: cleanNotes(input.notes),
    candidates,
  };
}

export function isOverlayActive(overlay: ManagerTacticalOverlay | null, now = new Date()): boolean {
  if (!overlay) return false;
  if (!overlay.expiresAt) return true;
  const expiresAtMs = Date.parse(overlay.expiresAt);
  if (!Number.isFinite(expiresAtMs)) return true;
  return expiresAtMs > now.getTime();
}

export function isManagerCandidateSetActive(candidateSet: ManagerCandidateSet | null, now = new Date()): boolean {
  if (!candidateSet) return false;
  if (!candidateSet.expiresAt) return true;
  const expiresAtMs = Date.parse(candidateSet.expiresAt);
  if (!Number.isFinite(expiresAtMs)) return true;
  return expiresAtMs > now.getTime();
}

export function managerCandidateToCandidate(candidate: ManagerCandidateSpec): Candidate {
  return {
    x: candidate.x,
    y: candidate.y,
    angleDeg: candidate.angleDeg,
    speedPct: candidate.speedPct,
    spinPct: candidate.spinPct,
    asset: candidate.asset,
    amount: String(candidate.amount),
    source: "manager",
    tags: [
      "manager-proposed",
      `manager-candidate:${candidate.id}`,
      ...(candidate.tags ?? []),
    ],
  };
}

export function buildManagerCandidates(candidateSet: ManagerCandidateSet | null): Candidate[] {
  if (!isManagerCandidateSetActive(candidateSet)) return [];

  return normalizeManagerCandidateSet(candidateSet ?? {}).candidates
    .filter((candidate) => candidate.enabled)
    .filter((candidate) => [candidate.x, candidate.y, candidate.angleDeg, candidate.speedPct, candidate.spinPct].every(Number.isFinite))
    .filter((candidate) => Boolean(candidate.asset) && Boolean(candidate.amount))
    .map((candidate) => managerCandidateToCandidate(candidate));
}

export function buildManagerCandidateSpecMap(candidateSet: ManagerCandidateSet | null): Map<string, ManagerCandidateSpec> {
  const map = new Map<string, ManagerCandidateSpec>();
  if (!isManagerCandidateSetActive(candidateSet)) return map;

  const normalized = normalizeManagerCandidateSet(candidateSet ?? {});
  for (const candidate of normalized.candidates) {
    if (!candidate.enabled) continue;
    const concreteCandidate = managerCandidateToCandidate(candidate);
    map.set(hashCandidate(concreteCandidate), candidate);
  }

  return map;
}

export function hashCandidate(candidate: Pick<Candidate, "x" | "y" | "angleDeg" | "speedPct" | "spinPct" | "asset" | "amount" | "source">): string {
  const payload = JSON.stringify({
    x: candidate.x,
    y: candidate.y,
    angleDeg: candidate.angleDeg,
    speedPct: candidate.speedPct,
    spinPct: candidate.spinPct,
    asset: cleanHex(candidate.asset),
    amount: String(candidate.amount),
    source: candidate.source,
  });
  return crypto.createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

function applyScoreDelta(baseScore: ScoreView, scoreDelta: number): ScoreView {
  return {
    weightedTotal: baseScore.weightedTotal + scoreDelta,
    worstCaseTotal: baseScore.worstCaseTotal + scoreDelta,
    bestCaseTotal: baseScore.bestCaseTotal + scoreDelta,
    fragilityPenalty: baseScore.fragilityPenalty,
    final: baseScore.final + scoreDelta,
  };
}

export function applyOverlayToCandidate(params: {
  overlay: ManagerTacticalOverlay | null;
  candidate: Candidate;
  candidateHash: string;
  baseScore: ScoreView;
  basePrediction: PredictionSummary | null;
}): OverlayApplication {
  const { overlay, candidate, candidateHash, baseScore, basePrediction } = params;

  if (!isOverlayActive(overlay)) {
    return {
      active: false,
      scoreDelta: 0,
      adjustments: [],
      adjustedScore: { ...baseScore },
      adjustedPrediction: clonePrediction(basePrediction),
    };
  }

  const normalized = normalizeManagerTacticalOverlay(overlay ?? {});
  const adjustments: OverlayAdjustment[] = [];
  let scoreDelta = 0;
  const holeType = basePrediction?.holeType ?? null;
  const assetKey = cleanHex(candidate.asset);

  if (holeType != null && normalized.preferredHoleTypes?.includes(holeType)) {
    scoreDelta += normalized.preferredHoleTypeBonus ?? 0;
    adjustments.push({ kind: "preferredHoleTypes", key: String(holeType), delta: normalized.preferredHoleTypeBonus ?? 0 });
  }
  if (holeType != null && normalized.blockedHoleTypes?.includes(holeType)) {
    scoreDelta += normalized.blockedHoleTypePenalty ?? 0;
    adjustments.push({ kind: "blockedHoleTypes", key: String(holeType), delta: normalized.blockedHoleTypePenalty ?? 0 });
  }
  if (holeType != null) {
    const holeDelta = Number(normalized.holeTypeScoreDeltas?.[String(holeType)] ?? 0);
    if (holeDelta) {
      scoreDelta += holeDelta;
      adjustments.push({ kind: "holeTypeScoreDeltas", key: String(holeType), delta: holeDelta });
    }
  }

  const assetDelta = Number(normalized.assetScoreDeltas?.[assetKey] ?? 0);
  if (assetDelta) {
    scoreDelta += assetDelta;
    adjustments.push({ kind: "assetScoreDeltas", key: assetKey, delta: assetDelta });
  }

  const sourceDelta = Number(normalized.candidateSourceScoreDeltas?.[candidate.source] ?? 0);
  if (sourceDelta) {
    scoreDelta += sourceDelta;
    adjustments.push({ kind: "candidateSourceScoreDeltas", key: candidate.source, delta: sourceDelta });
  }

  const candidateDelta = Number(normalized.candidateScoreDeltas?.[candidateHash] ?? 0);
  if (candidateDelta) {
    scoreDelta += candidateDelta;
    adjustments.push({ kind: "candidateScoreDeltas", key: candidateHash, delta: candidateDelta });
  }

  const adjustedPrediction = clonePrediction(basePrediction);
  if (adjustedPrediction && normalized.pnlBiasUsd) {
    if (adjustedPrediction.pnlUsd != null) adjustedPrediction.pnlUsd += normalized.pnlBiasUsd;
    if (adjustedPrediction.bestPnlUsd != null) adjustedPrediction.bestPnlUsd += normalized.pnlBiasUsd;
    if (adjustedPrediction.worstPnlUsd != null) adjustedPrediction.worstPnlUsd += normalized.pnlBiasUsd;
    adjustments.push({ kind: "pnlBiasUsd", delta: normalized.pnlBiasUsd });
  }
  if (adjustedPrediction && normalized.winnerValuePctBias) {
    if (adjustedPrediction.winnerValuePct != null) {
      adjustedPrediction.winnerValuePct = clamp(
        adjustedPrediction.winnerValuePct + normalized.winnerValuePctBias,
        0,
        100,
      );
    }
    adjustments.push({ kind: "winnerValuePctBias", delta: normalized.winnerValuePctBias });
  }

  return {
    active: true,
    scoreDelta,
    adjustments,
    adjustedScore: applyScoreDelta(baseScore, scoreDelta),
    adjustedPrediction,
  };
}

