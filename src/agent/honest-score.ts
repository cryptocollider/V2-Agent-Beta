import type { SimRunInput, ThrowRecord } from "../collider/types.js";
import type { ArtifactLogRef, HonestScoreLogView, PredictionCoverageLogView } from "../core/storage.js";
import type { PredictionCommitPayload, PredictionThrowForecast } from "./prediction-artifact.js";
import {
  buildPriceLookupFromGameReport,
  buildScenarioSettlementView,
  type SettledThrowView,
} from "./prediction-settlement.js";

export const PREDICTION_REVEAL_SCHEMA = "collider.prediction.reveal.v1";

export type PredictionHistoryEntry = {
  commit: PredictionCommitPayload;
  commitRef: ArtifactLogRef;
  decisionId?: string | null;
  resolvedActualThrowId?: string | null;
  ts?: string | null;
};

type ThrowEvaluation = {
  subjectKey: string;
  source: "existing" | "candidate";
  predictedThrowId: string | null;
  actualThrowId: string | null;
  predictedHoleType: number | null;
  actualHoleType: number | null;
  predictedReturnedUsd: number | null;
  actualReturnedUsd: number | null;
  predictedPnlUsd: number | null;
  actualPnlUsd: number | null;
  predictedEndFrame: number | null;
  actualEndFrame: number | null;
  payoutError: number | null;
  rps: number | null;
  horizonWeight: number | null;
  horizonHit: number | null;
  historyPoints: number;
};

type TemporalHistoryPoint = {
  commit: ArtifactLogRef;
  decisionId: string | null;
  createdAt: string;
  referenceFrame: number;
  source: "existing" | "candidate";
  predictedHoleType: number | null;
  predictedActualHoleProbability: number | null;
  probabilityOfMode: number | null;
  predictedReturnedUsd: number | null;
  predictedPnlUsd: number | null;
  predictedEndFrame: number | null;
  outcomeError: number | null;
  valueError: number | null;
  endFrameError: number | null;
  aggregateError: number | null;
  horizonWeight: number | null;
  horizonHit: number | null;
  certaintyWeight: number | null;
  certaintyBreach: number | null;
};

type ThrowTemporalHistory = {
  subjectKey: string;
  actualThrowId: string;
  user: string;
  enterFrame: number;
  source: "existing" | "candidate";
  points: TemporalHistoryPoint[];
};

type GameTemporalHistoryPoint = {
  commit: ArtifactLogRef;
  decisionId: string | null;
  createdAt: string;
  referenceFrame: number;
  predictedFinalFrame: number | null;
  predictedBotPnlUsd: number | null;
  predictedReturnedUsdSum: number | null;
};

export type PredictionRevealPayload = {
  schema: typeof PREDICTION_REVEAL_SCHEMA;
  version: 1;
  createdAt: string;
  sessionId: string;
  decisionId: string;
  gameId: string;
  botUser: string;
  commit: ArtifactLogRef;
  coverage: PredictionCoverageLogView;
  actualContext: {
    matchedThrowId: string | null;
    actualFinalFrame: number | null;
    settledHeight: number | null;
  };
  headline: {
    formulaVersion: "hps-v2_1-equal-bce-rps-temporal-certainty";
    honestScore: number | null;
    bce: number | null;
    rps: number | null;
    temporalError: number | null;
  };
  layers: {
    outcome: {
      score: number | null;
      error: number | null;
      evaluatedThrows: number;
      predictedThrows: number;
    };
    value: {
      score: number | null;
      error: number | null;
      evaluatedThrows: number;
      predictedThrows: number;
    };
    game: {
      score: number | null;
      error: number | null;
      actualFinalFrame: number | null;
      predictedFinalFrame: number | null;
      actualBotPnlUsd: number | null;
      predictedBotPnlUsd: number | null;
      actualReturnedUsdSum: number | null;
      predictedReturnedUsdSum: number | null;
    };
    temporal: {
      score: number | null;
      endFrameMae: number | null;
      dynamicShiftError: number | null;
      horizonAccuracy: number | null;
      certaintyBreach: number | null;
      evaluatedThrows: number;
      predictedThrows: number;
      historyPoints: number;
      dynamicUpdates: number;
    };
  };
  sharpness: {
    outcome: number | null;
    value: number | null;
    temporal: number | null;
    focalOutcome: number | null;
    focalValue: number | null;
    focalTemporal: number | null;
  };
  evaluations: {
    throws: ThrowEvaluation[];
    temporalHistory: {
      game: GameTemporalHistoryPoint[];
      throws: ThrowTemporalHistory[];
    };
    notes: string[];
  };
};

export type PredictionRevealBundle = {
  payload: PredictionRevealPayload;
  honestScore: HonestScoreLogView;
};

function cleanHex(value: unknown): string {
  return String(value ?? "").toLowerCase().replace(/^0x/, "");
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function avg(values: Array<number | null>): number | null {
  const filtered = values.filter((value): value is number => value != null && Number.isFinite(value));
  if (!filtered.length) return null;
  return filtered.reduce((sum, value) => sum + value, 0) / filtered.length;
}

function normalizeValueError(predicted: number | null, actual: number | null, scaleHint: number): number | null {
  if (predicted == null || actual == null) return null;
  const scale = Math.max(1, Math.abs(scaleHint), Math.abs(predicted), Math.abs(actual));
  return clamp01(Math.abs(predicted - actual) / scale);
}

export function computeTemporalCertaintyWeight(referenceFrame: number, actualEndFrame: number | null): number {
  if (actualEndFrame == null || !Number.isFinite(actualEndFrame) || actualEndFrame <= 0) return 0;
  const remainingFrames = Math.max(0, actualEndFrame - referenceFrame);
  return clamp01(1 - (remainingFrames / Math.max(1, actualEndFrame)));
}

export function computeTemporalCertaintyBreach(params: {
  referenceFrame: number;
  actualEndFrame: number | null;
  outcomeError: number | null;
  valueError: number | null;
  endFrameError: number | null;
}): number | null {
  const certaintyWeight = computeTemporalCertaintyWeight(params.referenceFrame, params.actualEndFrame);
  const baseError = avg([params.outcomeError, params.valueError, params.endFrameError]);
  if (baseError == null) return null;
  return clamp01(baseError * certaintyWeight);
}

function buildActualThrowMap(params: {
  report: unknown;
  settledInput: SimRunInput;
}): {
  throwsById: Map<string, SettledThrowView>;
  usersById: Map<string, { stakeUsd: number; returnedUsd: number; pnlUsd: number }>;
  finalFrame: number;
  settledHeight: number | null;
} {
  const { report, settledInput } = params;
  const root = report as Record<string, any>;
  const throwsRaw = Array.isArray(root.throws_raw) ? root.throws_raw as ThrowRecord[] : [];
  const outcomesRaw = Array.isArray(root.outcomes_raw) ? root.outcomes_raw : [];
  const priceLookup = buildPriceLookupFromGameReport(report);
  const settlement = buildScenarioSettlementView({
    input: {
      ...settledInput,
      throws: throwsRaw,
    },
    outcomes: outcomesRaw,
    priceLookup,
  });

  const usersById = new Map<string, { stakeUsd: number; returnedUsd: number; pnlUsd: number }>();
  for (const [user, view] of settlement.usersById.entries()) {
    usersById.set(user, {
      stakeUsd: view.stakeUsd,
      returnedUsd: view.returnedUsd,
      pnlUsd: view.pnlUsd,
    });
  }

  return {
    throwsById: settlement.throwsById,
    usersById,
    finalFrame: settlement.finalFrame,
    settledHeight: Number.isFinite(Number(root.settled_height)) ? Number(root.settled_height) : null,
  };
}

function actualThrowForForecast(params: {
  forecast: PredictionThrowForecast;
  actualThrowsById: Map<string, SettledThrowView>;
  matchedThrowId: string | null;
}): SettledThrowView | null {
  const { forecast, actualThrowsById, matchedThrowId } = params;
  if (forecast.source === "candidate") {
    return matchedThrowId ? (actualThrowsById.get(cleanHex(matchedThrowId)) ?? null) : null;
  }
  return forecast.actualThrowId ? (actualThrowsById.get(cleanHex(forecast.actualThrowId)) ?? null) : null;
}

function rpsForForecast(forecast: PredictionThrowForecast, actualHoleType: number | null): number | null {
  if (actualHoleType == null) return null;
  const ordered = [...forecast.outcome.orderedHoleTypes];
  if (!ordered.includes(actualHoleType)) {
    ordered.push(actualHoleType);
  }
  if (ordered.length <= 1) return 0;

  let sum = 0;
  for (let index = 0; index < ordered.length; index++) {
    const predictedCumulative = ordered
      .slice(0, index + 1)
      .reduce((acc, holeType) => acc + (forecast.outcome.holeTypeProbabilities[String(holeType)] ?? 0), 0);
    const observedCumulative = ordered.slice(0, index + 1).includes(actualHoleType) ? 1 : 0;
    sum += Math.pow(predictedCumulative - observedCumulative, 2);
  }

  return clamp01(sum / Math.max(1, ordered.length - 1));
}

function horizonWeight(referenceFrame: number, actualEndFrame: number | null): number {
  if (actualEndFrame == null) return 0;
  return Math.max(1, actualEndFrame - referenceFrame);
}

function resolveHistoricalForecastActualThrowId(params: {
  forecast: PredictionThrowForecast;
  entry: PredictionHistoryEntry;
  currentDecisionId: string;
  matchedThrowId: string | null;
}): string | null {
  const { forecast, entry, currentDecisionId, matchedThrowId } = params;
  if (forecast.actualThrowId) return cleanHex(forecast.actualThrowId);
  if (forecast.source !== "candidate") return null;
  if (cleanHex(entry.commit.decisionId) === cleanHex(currentDecisionId) && matchedThrowId) {
    return cleanHex(matchedThrowId);
  }
  if (entry.resolvedActualThrowId) {
    return cleanHex(entry.resolvedActualThrowId);
  }
  return null;
}

function pointAggregateError(point: TemporalHistoryPoint): number | null {
  return avg([point.outcomeError, point.valueError, point.endFrameError]);
}

function buildTemporalHistory(params: {
  commit: PredictionCommitPayload;
  botUser: string;
  currentDecisionId: string;
  commitRef: ArtifactLogRef;
  history: PredictionHistoryEntry[];
  actualThrowsById: Map<string, SettledThrowView>;
  actualUsersById: Map<string, { stakeUsd: number; returnedUsd: number; pnlUsd: number }>;
  actualFinalFrame: number | null;
  matchedThrowId: string | null;
}): {
  throws: ThrowTemporalHistory[];
  game: GameTemporalHistoryPoint[];
  metrics: {
    endFrameMae: number | null;
    dynamicShiftError: number | null;
    horizonAccuracy: number | null;
    certaintyBreach: number | null;
    historyPoints: number;
    dynamicUpdates: number;
  };
} {
  const {
    commit,
    botUser,
    currentDecisionId,
    commitRef,
    history,
    actualThrowsById,
    actualUsersById,
    actualFinalFrame,
    matchedThrowId,
  } = params;

  const currentSnapshot = commit.snapshots[0];
  const trackedThrows = new Map<string, { subjectKey: string; user: string; enterFrame: number; source: "existing" | "candidate" }>();
  for (const forecast of currentSnapshot.throws) {
    const resolvedActualThrowId = forecast.source === "candidate"
      ? (matchedThrowId ? cleanHex(matchedThrowId) : null)
      : (forecast.actualThrowId ? cleanHex(forecast.actualThrowId) : null);
    if (!resolvedActualThrowId) continue;
    trackedThrows.set(resolvedActualThrowId, {
      subjectKey: forecast.subjectKey,
      user: forecast.user,
      enterFrame: forecast.enterFrame,
      source: forecast.source,
    });
  }

  const historyEntries = [...history];
  const currentAlreadyPresent = historyEntries.some((entry) => cleanHex(entry.commit.decisionId) === cleanHex(commit.decisionId));
  if (!currentAlreadyPresent) {
    historyEntries.push({
      commit,
      commitRef,
      decisionId: commit.decisionId,
      resolvedActualThrowId: matchedThrowId,
      ts: commit.createdAt,
    });
  }

  historyEntries.sort((a, b) => new Date(a.commit.createdAt || a.ts || 0).getTime() - new Date(b.commit.createdAt || b.ts || 0).getTime());

  const botUserHex = cleanHex(botUser);
  const frameScale = Math.max(1, actualFinalFrame ?? 1, Math.round(currentSnapshot.game.expectedFinalFrame ?? 1));
  const throwHistoryMap = new Map<string, ThrowTemporalHistory>();
  const gameHistory: GameTemporalHistoryPoint[] = [];

  for (const entry of historyEntries) {
    const snapshot = entry.commit.snapshots[0];
    if (!snapshot) continue;

    const predictedBotUser = snapshot.users.find((userEntry) => cleanHex(userEntry.user) === botUserHex) ?? null;
    gameHistory.push({
      commit: entry.commitRef,
      decisionId: entry.decisionId ?? entry.commit.decisionId ?? null,
      createdAt: snapshot.createdAt,
      referenceFrame: snapshot.referenceFrame,
      predictedFinalFrame: snapshot.game.expectedFinalFrame,
      predictedBotPnlUsd: predictedBotUser?.expectedPnlUsd ?? null,
      predictedReturnedUsdSum: snapshot.game.expectedReturnedUsdSum,
    });

    for (const forecast of snapshot.throws) {
      const resolvedActualThrowId = resolveHistoricalForecastActualThrowId({
        forecast,
        entry,
        currentDecisionId,
        matchedThrowId,
      });
      if (!resolvedActualThrowId || !trackedThrows.has(resolvedActualThrowId)) continue;
      const actualThrow = actualThrowsById.get(resolvedActualThrowId);
      if (!actualThrow) continue;

      const outcomeError = rpsForForecast(forecast, actualThrow.holeType ?? null);
      const valueError = normalizeValueError(
        forecast.value.expectedReturnedUsd,
        actualThrow.returnedUsd,
        forecast.submissionValueUsd,
      );
      const endFrameError = forecast.temporal.expectedEndFrame == null || actualThrow.endFrame == null
        ? null
        : clamp01(Math.abs(forecast.temporal.expectedEndFrame - actualThrow.endFrame) / frameScale);
      const point: TemporalHistoryPoint = {
        commit: entry.commitRef,
        decisionId: entry.decisionId ?? entry.commit.decisionId ?? null,
        createdAt: snapshot.createdAt,
        referenceFrame: snapshot.referenceFrame,
        source: forecast.source,
        predictedHoleType: forecast.outcome.modeHoleType,
        predictedActualHoleProbability: actualThrow.holeType == null ? null : (forecast.outcome.holeTypeProbabilities[String(actualThrow.holeType)] ?? 0),
        probabilityOfMode: forecast.outcome.probabilityOfMode,
        predictedReturnedUsd: forecast.value.expectedReturnedUsd,
        predictedPnlUsd: forecast.value.expectedPnlUsd,
        predictedEndFrame: forecast.temporal.expectedEndFrame,
        outcomeError,
        valueError,
        endFrameError,
        aggregateError: null,
        horizonWeight: horizonWeight(snapshot.referenceFrame, actualThrow.endFrame ?? null),
        horizonHit: actualThrow.holeType != null && forecast.outcome.modeHoleType != null
          ? (forecast.outcome.modeHoleType === actualThrow.holeType ? 1 : 0)
          : null,
        certaintyWeight: computeTemporalCertaintyWeight(snapshot.referenceFrame, actualThrow.endFrame ?? null),
        certaintyBreach: null,
      };
      point.aggregateError = pointAggregateError(point);
      point.certaintyBreach = computeTemporalCertaintyBreach({
        referenceFrame: snapshot.referenceFrame,
        actualEndFrame: actualThrow.endFrame ?? null,
        outcomeError,
        valueError,
        endFrameError,
      });

      const tracked = trackedThrows.get(resolvedActualThrowId);
      if (!tracked) continue;
      const historyRow = throwHistoryMap.get(resolvedActualThrowId) ?? {
        subjectKey: tracked.subjectKey,
        actualThrowId: resolvedActualThrowId,
        user: tracked.user,
        enterFrame: tracked.enterFrame,
        source: tracked.source,
        points: [],
      };
      historyRow.points.push(point);
      throwHistoryMap.set(resolvedActualThrowId, historyRow);
    }
  }

  const throwHistories = [...throwHistoryMap.values()].map((historyRow) => ({
    ...historyRow,
    points: [...historyRow.points].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()),
  }));

  const allPoints = throwHistories.flatMap((historyRow) => historyRow.points);
  const endFrameMae = avg(allPoints.map((point) => point.endFrameError));
  const totalHorizonWeight = allPoints.reduce((sum, point) => sum + (point.horizonWeight ?? 0), 0);
  const horizonAccuracy = totalHorizonWeight > 0
    ? allPoints.reduce((sum, point) => sum + ((point.horizonHit ?? 0) * (point.horizonWeight ?? 0)), 0) / totalHorizonWeight
    : null;

  const dynamicPenalties: number[] = [];
  for (const historyRow of throwHistories) {
    for (let index = 1; index < historyRow.points.length; index++) {
      const previous = historyRow.points[index - 1];
      const current = historyRow.points[index];
      if (previous.aggregateError == null || current.aggregateError == null) continue;
      dynamicPenalties.push(Math.max(0, current.aggregateError - previous.aggregateError));
    }
  }
  const dynamicShiftError = avg(dynamicPenalties);
  const certaintyBreach = avg(allPoints.map((point) => point.certaintyBreach));

  return {
    throws: throwHistories,
    game: gameHistory,
    metrics: {
      endFrameMae,
      dynamicShiftError: dynamicShiftError ?? 0,
      horizonAccuracy,
      certaintyBreach,
      historyPoints: allPoints.length,
      dynamicUpdates: dynamicPenalties.length,
    },
  };
}

export function buildPredictionRevealBundle(params: {
  createdAt: string;
  sessionId: string;
  decisionId: string;
  botUser: string;
  commit: PredictionCommitPayload;
  commitRef: ArtifactLogRef;
  report: unknown;
  settledInput: SimRunInput;
  matchedThrowId?: string | null;
  history?: PredictionHistoryEntry[];
}): PredictionRevealBundle {
  const {
    createdAt,
    sessionId,
    decisionId,
    botUser,
    commit,
    commitRef,
    report,
    settledInput,
    matchedThrowId = null,
    history = [],
  } = params;
  const snapshot = commit.snapshots[0];
  const actual = buildActualThrowMap({ report, settledInput });
  const botUserHex = cleanHex(botUser);

  const temporalHistory = buildTemporalHistory({
    commit,
    botUser,
    currentDecisionId: decisionId,
    commitRef,
    history,
    actualThrowsById: actual.throwsById,
    actualUsersById: actual.usersById,
    actualFinalFrame: actual.finalFrame || null,
    matchedThrowId,
  });

  const throwEvaluations: ThrowEvaluation[] = snapshot.throws.map((forecast) => {
    const actualThrow = actualThrowForForecast({
      forecast,
      actualThrowsById: actual.throwsById,
      matchedThrowId,
    });
    const historyRow = actualThrow?.throwId ? temporalHistory.throws.find((entry) => entry.actualThrowId === actualThrow.throwId) ?? null : null;

    const payoutError = normalizeValueError(
      forecast.value.expectedReturnedUsd,
      actualThrow?.returnedUsd ?? null,
      forecast.submissionValueUsd,
    );
    const rps = rpsForForecast(forecast, actualThrow?.holeType ?? null);
    const weight = horizonWeight(snapshot.referenceFrame, actualThrow?.endFrame ?? null);
    const hit = actualThrow?.holeType != null && forecast.outcome.modeHoleType != null
      ? (forecast.outcome.modeHoleType === actualThrow.holeType ? 1 : 0)
      : null;

    return {
      subjectKey: forecast.subjectKey,
      source: forecast.source,
      predictedThrowId: forecast.actualThrowId,
      actualThrowId: actualThrow?.throwId ?? null,
      predictedHoleType: forecast.outcome.modeHoleType,
      actualHoleType: actualThrow?.holeType ?? null,
      predictedReturnedUsd: forecast.value.expectedReturnedUsd,
      actualReturnedUsd: actualThrow?.returnedUsd ?? null,
      predictedPnlUsd: forecast.value.expectedPnlUsd,
      actualPnlUsd: actualThrow?.pnlUsd ?? null,
      predictedEndFrame: forecast.temporal.expectedEndFrame,
      actualEndFrame: actualThrow?.endFrame ?? null,
      payoutError,
      rps,
      horizonWeight: weight,
      horizonHit: hit,
      historyPoints: historyRow?.points?.length ?? 0,
    };
  });

  const evaluatedOutcomeThrows = throwEvaluations.filter((entry) => entry.actualHoleType != null);
  const evaluatedValueThrows = throwEvaluations.filter((entry) => entry.actualReturnedUsd != null);
  const evaluatedTemporalThrows = throwEvaluations.filter((entry) => entry.actualEndFrame != null);

  const bce = avg(evaluatedValueThrows.map((entry) => entry.payoutError));
  const rps = avg(evaluatedOutcomeThrows.map((entry) => entry.rps));

  const endFrameMae = temporalHistory.metrics.endFrameMae;
  const dynamicShiftError = temporalHistory.metrics.dynamicShiftError ?? 0;
  const horizonAccuracy = temporalHistory.metrics.horizonAccuracy;
  const certaintyBreach = temporalHistory.metrics.certaintyBreach;
  const temporalError = avg([
    endFrameMae,
    dynamicShiftError,
    horizonAccuracy == null ? null : (1 - horizonAccuracy),
    certaintyBreach,
  ]);

  const honestScore = (bce != null && rps != null && temporalError != null)
    ? Math.max(0, Math.min(100, 100 * (1 - ((bce + rps + temporalError) / 3))))
    : null;

  const predictedBotUser = snapshot.users.find((entry) => cleanHex(entry.user) === botUserHex) ?? null;
  const actualBotUser = actual.usersById.get(botUserHex) ?? null;
  const actualReturnedUsdSum = [...actual.usersById.values()].reduce((sum, entry) => sum + entry.returnedUsd, 0);
  const frameScale = Math.max(1, actual.finalFrame || 1, Math.round(snapshot.game.expectedFinalFrame ?? 1));
  const gameError = avg([
    snapshot.game.expectedFinalFrame != null && actual.finalFrame != null
      ? clamp01(Math.abs(snapshot.game.expectedFinalFrame - actual.finalFrame) / frameScale)
      : null,
    normalizeValueError(snapshot.game.expectedReturnedUsdSum, actualReturnedUsdSum, snapshot.game.expectedStakeUsdSum ?? 1),
    normalizeValueError(predictedBotUser?.expectedPnlUsd ?? null, actualBotUser?.pnlUsd ?? null, actualBotUser?.stakeUsd ?? 1),
  ]);

  const outcomeScore = rps != null ? 1 - rps : null;
  const valueScore = bce != null ? 1 - bce : null;
  const temporalScore = temporalError != null ? 1 - temporalError : null;
  const gameScore = gameError != null ? 1 - gameError : null;

  const coverage: PredictionCoverageLogView = {
    knownExistingThrowsTotal: commit.coverage.knownExistingThrowsTotal,
    predictedTrackedThrowsTotal: commit.coverage.predictedTrackedThrowsTotal,
    predictedUsersTotal: commit.coverage.predictedUsersTotal,
    predictedThrows: snapshot.throws.length,
    evaluatedThrows: throwEvaluations.filter((entry) => entry.actualThrowId != null).length,
    outcomeCoveragePct: snapshot.throws.length > 0 ? evaluatedOutcomeThrows.length / snapshot.throws.length : null,
    valueCoveragePct: snapshot.throws.length > 0 ? evaluatedValueThrows.length / snapshot.throws.length : null,
    gameCoveragePct: snapshot.game.expectedFinalFrame != null && actual.finalFrame != null ? 1 : 0,
    temporalCoveragePct: snapshot.throws.length > 0 ? (temporalHistory.throws.filter((entry) => entry.points.length > 0).length / snapshot.throws.length) : null,
    snapshotCount: temporalHistory.game.length,
    predictedGameTotals: commit.coverage.predictedGameTotals,
    predictedTemporal: commit.coverage.predictedTemporal,
    predictedDynamicUpdates: temporalHistory.metrics.dynamicUpdates,
    knownFutureUnknownThrowsMode: commit.coverage.knownFutureUnknownThrowsMode,
  };

  const focalForecast = snapshot.throws.find((entry) => entry.source === "candidate") ?? null;
  const sharpness = {
    outcome: avg(snapshot.throws.map((entry) => entry.sharpness.outcome)),
    value: avg(snapshot.throws.map((entry) => entry.sharpness.value)),
    temporal: avg(snapshot.throws.map((entry) => entry.sharpness.temporal)),
    focalOutcome: focalForecast?.sharpness.outcome ?? null,
    focalValue: focalForecast?.sharpness.value ?? null,
    focalTemporal: focalForecast?.sharpness.temporal ?? null,
  };

  const payload: PredictionRevealPayload = {
    schema: PREDICTION_REVEAL_SCHEMA,
    version: 1,
    createdAt,
    sessionId,
    decisionId,
    gameId: commit.gameId,
    botUser: botUserHex,
    commit: commitRef,
    coverage,
    actualContext: {
      matchedThrowId: matchedThrowId ? cleanHex(matchedThrowId) : null,
      actualFinalFrame: actual.finalFrame || null,
      settledHeight: actual.settledHeight,
    },
    headline: {
      formulaVersion: "hps-v2_1-equal-bce-rps-temporal-certainty",
      honestScore,
      bce,
      rps,
      temporalError,
    },
    layers: {
      outcome: {
        score: outcomeScore,
        error: rps,
        evaluatedThrows: evaluatedOutcomeThrows.length,
        predictedThrows: snapshot.throws.length,
      },
      value: {
        score: valueScore,
        error: bce,
        evaluatedThrows: evaluatedValueThrows.length,
        predictedThrows: snapshot.throws.length,
      },
      game: {
        score: gameScore,
        error: gameError,
        actualFinalFrame: actual.finalFrame || null,
        predictedFinalFrame: snapshot.game.expectedFinalFrame,
        actualBotPnlUsd: actualBotUser?.pnlUsd ?? null,
        predictedBotPnlUsd: predictedBotUser?.expectedPnlUsd ?? null,
        actualReturnedUsdSum,
        predictedReturnedUsdSum: snapshot.game.expectedReturnedUsdSum,
      },
      temporal: {
        score: temporalScore,
        endFrameMae,
        dynamicShiftError,
        horizonAccuracy,
        certaintyBreach,
        evaluatedThrows: evaluatedTemporalThrows.length,
        predictedThrows: snapshot.throws.length,
        historyPoints: temporalHistory.metrics.historyPoints,
        dynamicUpdates: temporalHistory.metrics.dynamicUpdates,
      },
    },
    sharpness,
    evaluations: {
      throws: throwEvaluations,
      temporalHistory: {
        game: temporalHistory.game,
        throws: temporalHistory.throws,
      },
      notes: [
        "Diagnostic layer_game is stored separately from the locked public headline HPS formula.",
        "DynamicShiftError is evaluated from successive prediction commits in the same game when that history exists.",
        "CertaintyBreach punishes late, near-obvious misses harder than early exploratory misses inside the temporal layer.",
        "Unknown future external throws remain explicitly out of scope for this first commit format; game forecasts are current-known-board-only.",
      ],
    },
  };

  return {
    payload,
    honestScore: {
      schema: PREDICTION_REVEAL_SCHEMA,
      honestScore,
      bce,
      rps,
      temporalError,
      coverage,
      sharpness,
      layers: {
        outcome: {
          score: outcomeScore,
          error: rps,
          evaluatedThrows: evaluatedOutcomeThrows.length,
          predictedThrows: snapshot.throws.length,
        },
        value: {
          score: valueScore,
          error: bce,
          evaluatedThrows: evaluatedValueThrows.length,
          predictedThrows: snapshot.throws.length,
        },
        game: {
          score: gameScore,
          error: gameError,
          actualFinalFrame: actual.finalFrame || null,
          predictedFinalFrame: snapshot.game.expectedFinalFrame,
          actualBotPnlUsd: actualBotUser?.pnlUsd ?? null,
          predictedBotPnlUsd: predictedBotUser?.expectedPnlUsd ?? null,
          actualReturnedUsdSum,
          predictedReturnedUsdSum: snapshot.game.expectedReturnedUsdSum,
        },
        temporal: {
          score: temporalScore,
          endFrameMae,
          dynamicShiftError,
          horizonAccuracy,
          certaintyBreach,
          evaluatedThrows: evaluatedTemporalThrows.length,
          predictedThrows: snapshot.throws.length,
          historyPoints: temporalHistory.metrics.historyPoints,
          dynamicUpdates: temporalHistory.metrics.dynamicUpdates,
        },
      },
    },
  };
}