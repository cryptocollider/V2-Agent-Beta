import type { SimRunInput, ThrowRecord } from "../collider/types.js";
import type { CandidatePlanRun } from "../sim/planner.js";
import { makeCommitSaltHex } from "../core/content-address.js";
import {
  buildPriceLookupFromSimInput,
  buildScenarioSettlementView,
  type PriceLookup,
  type ScenarioSettlementView,
  type SettledThrowView,
} from "./prediction-settlement.js";

export const PREDICTION_COMMIT_SCHEMA = "collider.prediction.commit.v1";

export type PredictionWeights = {
  headline: {
    version: "hps-v1-equal-bce-rps-temporal";
    bce: number;
    rps: number;
    temporal: number;
  };
  diagnostics: {
    version: "diagnostic-v1-equal-4-layer";
    outcome: number;
    value: number;
    game: number;
    temporal: number;
  };
};

export type PredictionCommitCoverage = {
  knownExistingThrowsTotal: number;
  predictedTrackedThrowsTotal: number;
  predictedUsersTotal: number;
  snapshotCount: number;
  predictedGameTotals: boolean;
  predictedTemporal: boolean;
  predictedDynamicUpdates: number;
  knownFutureUnknownThrowsMode: "not_modeled";
};

export type PredictionPriceBasis = {
  source: string;
  assets: Array<{
    asset: string;
    epochs: Array<{
      epoch: number;
      priceUsd: number;
    }>;
  }>;
};

export type PredictionThrowForecast = {
  subjectKey: string;
  source: "existing" | "candidate";
  actualThrowId: string | null;
  user: string;
  asset: string;
  amount: string;
  enterFrame: number;
  priceEpoch: number;
  submissionValueUsd: number;
  weightedUsdValue: number;
  massUsd: number;
  scenarioCount: number;
  outcome: {
    modeHoleType: number | null;
    probabilityOfMode: number | null;
    holeTypeProbabilities: Record<string, number>;
    orderedHoleTypes: number[];
  };
  value: {
    expectedReturnedUsd: number | null;
    expectedPnlUsd: number | null;
    minReturnedUsd: number | null;
    maxReturnedUsd: number | null;
    minPnlUsd: number | null;
    maxPnlUsd: number | null;
    probabilityOfProfit: number | null;
  };
  temporal: {
    expectedEndFrame: number | null;
    minEndFrame: number | null;
    maxEndFrame: number | null;
    endFrameDistribution: Array<{
      frame: number;
      probability: number;
    }>;
    horizonWeightHint: number | null;
  };
  sharpness: {
    outcome: number | null;
    value: number | null;
    temporal: number | null;
  };
};

export type PredictionUserForecast = {
  user: string;
  expectedStakeUsd: number | null;
  expectedReturnedUsd: number | null;
  expectedPnlUsd: number | null;
  minReturnedUsd: number | null;
  maxReturnedUsd: number | null;
  minPnlUsd: number | null;
  maxPnlUsd: number | null;
};

export type PredictionGameForecast = {
  scope: "current-known-board-only";
  expectedFinalFrame: number | null;
  minFinalFrame: number | null;
  maxFinalFrame: number | null;
  finalFrameDistribution: Array<{
    frame: number;
    probability: number;
  }>;
  expectedStakeUsdSum: number | null;
  expectedReturnedUsdSum: number | null;
  expectedPnlUsdSum: number | null;
};

export type PredictionSnapshot = {
  snapshotId: string;
  snapshotIndex: number;
  kind: "initial_commit";
  createdAt: string;
  referenceFrame: number;
  knownThrowCount: number;
  trackedThrowCount: number;
  coverage: {
    trackedThrowsPct: number;
    gameForecastPct: number;
    temporalPct: number;
    dynamicUpdatePct: number;
  };
  throws: PredictionThrowForecast[];
  users: PredictionUserForecast[];
  game: PredictionGameForecast;
};

export type PredictionCommitPayload = {
  schema: typeof PREDICTION_COMMIT_SCHEMA;
  version: 1;
  createdAt: string;
  sessionId: string;
  decisionId: string;
  gameId: string;
  botUser: string;
  candidateHash: string | null;
  placeThrowCommitField: "data_commit";
  commitSaltHex: string;
  weights: PredictionWeights;
  coverage: PredictionCommitCoverage;
  priceBasis: PredictionPriceBasis;
  snapshots: PredictionSnapshot[];
};

export type PredictionSummaryLite = {
  scenarioCount: number;
  winnerScenarioCount: number;
  pnlUsd: number | null;
  bestPnlUsd: number | null;
  worstPnlUsd: number | null;
  holeType: number | null;
  holeTypeCounts: Record<string, number>;
  valueUsd: number | null;
  valueUsdE8: string | null;
  massUsd: number | null;
  winnerValuePct: number | null;
};

export type PredictionCommitBundle = {
  payload: PredictionCommitPayload;
  summary: PredictionSummaryLite | null;
};

type WeightedScenarioSettlement = {
  weight: number;
  settlement: ScenarioSettlementView;
  candidateThrowId: string;
};

function cleanHex(value: unknown): string {
  return String(value ?? "").toLowerCase().replace(/^0x/, "");
}

function bytesToHex(value: unknown): string {
  if (!Array.isArray(value)) return cleanHex(value);
  return value.map((byte) => Number(byte).toString(16).padStart(2, "0")).join("");
}

function weightedAverage(values: Array<{ value: number | null; weight: number }>): number | null {
  let total = 0;
  let totalWeight = 0;
  for (const entry of values) {
    if (entry.value == null || !Number.isFinite(entry.value)) continue;
    total += entry.value * entry.weight;
    totalWeight += entry.weight;
  }
  return totalWeight > 0 ? total / totalWeight : null;
}

function minValue(values: Array<number | null>): number | null {
  const filtered = values.filter((value): value is number => value != null && Number.isFinite(value));
  return filtered.length ? Math.min(...filtered) : null;
}

function maxValue(values: Array<number | null>): number | null {
  const filtered = values.filter((value): value is number => value != null && Number.isFinite(value));
  return filtered.length ? Math.max(...filtered) : null;
}

function normalizedSharpness(probabilities: number[]): number | null {
  const filtered = probabilities.filter((value) => Number.isFinite(value) && value > 0);
  if (!filtered.length) return null;
  if (filtered.length === 1) return 1;

  const total = filtered.reduce((sum, value) => sum + value, 0);
  if (!(total > 0)) return null;

  const normalized = filtered.map((value) => value / total);
  const entropy = -normalized.reduce((sum, value) => sum + (value * Math.log(value)), 0);
  const maxEntropy = Math.log(normalized.length);
  if (!(maxEntropy > 0)) return 1;
  return Math.max(0, Math.min(1, 1 - (entropy / maxEntropy)));
}

function serializePriceBasis(priceLookup: PriceLookup): PredictionPriceBasis {
  return {
    source: priceLookup.source,
    assets: [...priceLookup.byAssetEpoch.entries()].map(([asset, byEpoch]) => ({
      asset,
      epochs: [...byEpoch.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([epoch, priceUsd]) => ({ epoch, priceUsd })),
    })),
  };
}

function throwRecordSummary(throwRecord: ThrowRecord, weightedUsdValue: number) {
  return {
    user: bytesToHex(throwRecord.user),
    asset: bytesToHex(throwRecord.asset),
    amount: String(throwRecord.amount ?? "0"),
    enterFrame: Number(throwRecord.enter_frame ?? 0),
    priceEpoch: Number(throwRecord.price_epoch ?? 0),
    submissionValueUsd: Number(String(throwRecord.value_usd_e8 ?? "0")) / 1e8,
    weightedUsdValue,
    massUsd: Number(throwRecord.mass_usd ?? 0),
    valueUsdE8: throwRecord.value_usd_e8 != null ? String(throwRecord.value_usd_e8) : null,
  };
}

function buildThrowForecast(params: {
  subjectKey: string;
  source: "existing" | "candidate";
  actualThrowId: string | null;
  base: ReturnType<typeof throwRecordSummary>;
  throws: Array<{ throwView: SettledThrowView | null; weight: number }>;
  referenceFrame: number;
}): PredictionThrowForecast {
  const { subjectKey, source, actualThrowId, base, throws, referenceFrame } = params;
  const totalWeight = throws.reduce((sum, entry) => sum + entry.weight, 0) || 1;
  const holeTypeProbabilities: Record<string, number> = {};
  const endFrameWeights = new Map<number, number>();
  const holeTypePnlMeans = new Map<number, { total: number; weight: number }>();
  let scenarioCount = 0;
  let profitWeight = 0;

  for (const entry of throws) {
    const throwView = entry.throwView;
    if (!throwView) continue;
    scenarioCount += 1;
    if (throwView.holeType != null) {
      const key = String(throwView.holeType);
      holeTypeProbabilities[key] = (holeTypeProbabilities[key] ?? 0) + entry.weight / totalWeight;
      const pnlEntry = holeTypePnlMeans.get(throwView.holeType) ?? { total: 0, weight: 0 };
      pnlEntry.total += throwView.pnlUsd * entry.weight;
      pnlEntry.weight += entry.weight;
      holeTypePnlMeans.set(throwView.holeType, pnlEntry);
    }
    if (throwView.endFrame != null) {
      endFrameWeights.set(throwView.endFrame, (endFrameWeights.get(throwView.endFrame) ?? 0) + entry.weight / totalWeight);
    }
    if (throwView.pnlUsd > 0) {
      profitWeight += entry.weight;
    }
  }

  const orderedHoleTypes = [...holeTypePnlMeans.entries()]
    .sort((a, b) => {
      const diff = (b[1].total / b[1].weight) - (a[1].total / a[1].weight);
      if (diff !== 0) return diff;
      return a[0] - b[0];
    })
    .map(([holeType]) => holeType);

  const mode = Object.entries(holeTypeProbabilities)
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return Number(a[0]) - Number(b[0]);
    })[0] ?? null;

  const expectedEndFrame = weightedAverage(throws.map((entry) => ({
    value: entry.throwView?.endFrame ?? null,
    weight: entry.weight,
  })));
  const probabilityOfProfit = totalWeight > 0 ? profitWeight / totalWeight : null;

  return {
    subjectKey,
    source,
    actualThrowId,
    user: base.user,
    asset: base.asset,
    amount: base.amount,
    enterFrame: base.enterFrame,
    priceEpoch: base.priceEpoch,
    submissionValueUsd: base.submissionValueUsd,
    weightedUsdValue: base.weightedUsdValue,
    massUsd: base.massUsd,
    scenarioCount,
    outcome: {
      modeHoleType: mode ? Number(mode[0]) : null,
      probabilityOfMode: mode ? mode[1] : null,
      holeTypeProbabilities,
      orderedHoleTypes,
    },
    value: {
      expectedReturnedUsd: weightedAverage(throws.map((entry) => ({ value: entry.throwView?.returnedUsd ?? null, weight: entry.weight }))),
      expectedPnlUsd: weightedAverage(throws.map((entry) => ({ value: entry.throwView?.pnlUsd ?? null, weight: entry.weight }))),
      minReturnedUsd: minValue(throws.map((entry) => entry.throwView?.returnedUsd ?? null)),
      maxReturnedUsd: maxValue(throws.map((entry) => entry.throwView?.returnedUsd ?? null)),
      minPnlUsd: minValue(throws.map((entry) => entry.throwView?.pnlUsd ?? null)),
      maxPnlUsd: maxValue(throws.map((entry) => entry.throwView?.pnlUsd ?? null)),
      probabilityOfProfit,
    },
    temporal: {
      expectedEndFrame,
      minEndFrame: minValue(throws.map((entry) => entry.throwView?.endFrame ?? null)),
      maxEndFrame: maxValue(throws.map((entry) => entry.throwView?.endFrame ?? null)),
      endFrameDistribution: [...endFrameWeights.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([frame, probability]) => ({ frame, probability })),
      horizonWeightHint: expectedEndFrame != null ? Math.max(0, expectedEndFrame - referenceFrame) : null,
    },
    sharpness: {
      outcome: normalizedSharpness(Object.values(holeTypeProbabilities)),
      value: probabilityOfProfit == null ? null : Math.abs((probabilityOfProfit * 2) - 1),
      temporal: normalizedSharpness([...endFrameWeights.values()]),
    },
  };
}

function scenarioCandidateRecord(plan: CandidatePlanRun): ThrowRecord | null {
  const firstScenario = plan.perScenario[0];
  if (!firstScenario) return null;
  const candidateThrowId = cleanHex(firstScenario.syntheticThrowId);
  return firstScenario.syntheticInput.throws.find((throwRecord) => bytesToHex(throwRecord.id) === candidateThrowId) ?? null;
}

function buildSummaryFromCandidateForecast(params: {
  weightedSettlements: WeightedScenarioSettlement[];
  candidateForecast: PredictionThrowForecast | null;
  candidateRecord: ThrowRecord | null;
}): PredictionSummaryLite | null {
  const { weightedSettlements, candidateForecast, candidateRecord } = params;
  if (!candidateForecast) return null;

  const holeTypeCounts = Object.fromEntries(
    Object.entries(candidateForecast.outcome.holeTypeProbabilities).map(([holeType, probability]) => [
      holeType,
      Math.round(probability * weightedSettlements.length),
    ]),
  );

  return {
    scenarioCount: weightedSettlements.length,
    winnerScenarioCount: weightedSettlements.filter((entry) => entry.settlement.throwsById.get(entry.candidateThrowId)?.holeType === 3).length,
    pnlUsd: candidateForecast.value.expectedPnlUsd,
    bestPnlUsd: candidateForecast.value.maxPnlUsd,
    worstPnlUsd: candidateForecast.value.minPnlUsd,
    holeType: candidateForecast.outcome.modeHoleType,
    holeTypeCounts,
    valueUsd: candidateForecast.submissionValueUsd,
    valueUsdE8: candidateRecord?.value_usd_e8 != null ? String(candidateRecord.value_usd_e8) : null,
    massUsd: candidateForecast.massUsd,
    winnerValuePct: (candidateForecast.outcome.holeTypeProbabilities["3"] ?? 0) * 100,
  };
}

export function buildPredictionCommitBundle(params: {
  createdAt: string;
  sessionId: string;
  decisionId: string;
  gameId: string;
  botUser: string;
  candidateHash: string | null;
  plan: CandidatePlanRun;
  simInput: SimRunInput;
}): PredictionCommitBundle {
  const { createdAt, sessionId, decisionId, gameId, botUser, candidateHash, plan, simInput } = params;
  const priceLookup = buildPriceLookupFromSimInput(simInput);
  const weightedSettlements: WeightedScenarioSettlement[] = plan.perScenario.map((scenarioRun) => ({
    weight: Number(scenarioRun.scenario.weight ?? 1),
    settlement: buildScenarioSettlementView({
      input: scenarioRun.syntheticInput,
      outcomes: scenarioRun.decoded.per_throw,
      priceLookup,
    }),
    candidateThrowId: cleanHex(scenarioRun.syntheticThrowId),
  }));

  const referenceFrame = simInput.throws.reduce((max, throwRecord) => Math.max(max, Number(throwRecord.enter_frame ?? 0)), 0);

  const existingThrowForecasts = simInput.throws.map((throwRecord) => {
    const throwId = bytesToHex(throwRecord.id);
    const throwSamples = weightedSettlements.map((entry) => ({
      weight: entry.weight,
      throwView: entry.settlement.throwsById.get(throwId) ?? null,
    }));
    const base = throwRecordSummary(throwRecord, throwSamples.find((entry) => entry.throwView)?.throwView?.weightedUsdValue ?? 0);
    return buildThrowForecast({
      subjectKey: throwId,
      source: "existing",
      actualThrowId: throwId,
      base,
      throws: throwSamples,
      referenceFrame,
    });
  });

  const candidateRecord = scenarioCandidateRecord(plan);
  const candidateSubjectKey = `candidate:${candidateHash ?? "next"}`;
  const candidateForecast = candidateRecord
    ? buildThrowForecast({
        subjectKey: candidateSubjectKey,
        source: "candidate",
        actualThrowId: null,
        base: throwRecordSummary(
          candidateRecord,
          weightedSettlements[0]?.settlement.throwsById.get(weightedSettlements[0].candidateThrowId)?.weightedUsdValue ?? 0,
        ),
        throws: weightedSettlements.map((entry) => ({
          weight: entry.weight,
          throwView: entry.settlement.throwsById.get(entry.candidateThrowId) ?? null,
        })),
        referenceFrame,
      })
    : null;

  const throwForecasts = candidateForecast ? [...existingThrowForecasts, candidateForecast] : existingThrowForecasts;
  const allUsers = new Set<string>([cleanHex(botUser)]);
  for (const entry of weightedSettlements) {
    for (const user of entry.settlement.usersById.keys()) {
      allUsers.add(user);
    }
  }

  const userForecasts: PredictionUserForecast[] = [...allUsers].map((user) => {
    const samples = weightedSettlements.map((entry) => ({
      weight: entry.weight,
      userView: entry.settlement.usersById.get(user) ?? null,
    }));
    return {
      user,
      expectedStakeUsd: weightedAverage(samples.map((entry) => ({ value: entry.userView?.stakeUsd ?? null, weight: entry.weight }))),
      expectedReturnedUsd: weightedAverage(samples.map((entry) => ({ value: entry.userView?.returnedUsd ?? null, weight: entry.weight }))),
      expectedPnlUsd: weightedAverage(samples.map((entry) => ({ value: entry.userView?.pnlUsd ?? null, weight: entry.weight }))),
      minReturnedUsd: minValue(samples.map((entry) => entry.userView?.returnedUsd ?? null)),
      maxReturnedUsd: maxValue(samples.map((entry) => entry.userView?.returnedUsd ?? null)),
      minPnlUsd: minValue(samples.map((entry) => entry.userView?.pnlUsd ?? null)),
      maxPnlUsd: maxValue(samples.map((entry) => entry.userView?.pnlUsd ?? null)),
    };
  });

  const totalWeight = weightedSettlements.reduce((sum, entry) => sum + entry.weight, 0) || 1;
  const finalFrameDistribution = new Map<number, number>();
  for (const entry of weightedSettlements) {
    finalFrameDistribution.set(
      entry.settlement.finalFrame,
      (finalFrameDistribution.get(entry.settlement.finalFrame) ?? 0) + entry.weight / totalWeight,
    );
  }

  const gameForecast: PredictionGameForecast = {
    scope: "current-known-board-only",
    expectedFinalFrame: weightedAverage(weightedSettlements.map((entry) => ({ value: entry.settlement.finalFrame, weight: entry.weight }))),
    minFinalFrame: minValue(weightedSettlements.map((entry) => entry.settlement.finalFrame)),
    maxFinalFrame: maxValue(weightedSettlements.map((entry) => entry.settlement.finalFrame)),
    finalFrameDistribution: [...finalFrameDistribution.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([frame, probability]) => ({ frame, probability })),
    expectedStakeUsdSum: weightedAverage(weightedSettlements.map((entry) => ({
      value: [...entry.settlement.usersById.values()].reduce((sum, userView) => sum + userView.stakeUsd, 0),
      weight: entry.weight,
    }))),
    expectedReturnedUsdSum: weightedAverage(weightedSettlements.map((entry) => ({
      value: [...entry.settlement.usersById.values()].reduce((sum, userView) => sum + userView.returnedUsd, 0),
      weight: entry.weight,
    }))),
    expectedPnlUsdSum: weightedAverage(weightedSettlements.map((entry) => ({
      value: [...entry.settlement.usersById.values()].reduce((sum, userView) => sum + userView.pnlUsd, 0),
      weight: entry.weight,
    }))),
  };

  const weights: PredictionWeights = {
    headline: {
      version: "hps-v1-equal-bce-rps-temporal",
      bce: 1 / 3,
      rps: 1 / 3,
      temporal: 1 / 3,
    },
    diagnostics: {
      version: "diagnostic-v1-equal-4-layer",
      outcome: 0.25,
      value: 0.25,
      game: 0.25,
      temporal: 0.25,
    },
  };

  const payload: PredictionCommitPayload = {
    schema: PREDICTION_COMMIT_SCHEMA,
    version: 1,
    createdAt,
    sessionId,
    decisionId,
    gameId: cleanHex(gameId),
    botUser: cleanHex(botUser),
    candidateHash,
    placeThrowCommitField: "data_commit",
    commitSaltHex: makeCommitSaltHex(),
    weights,
    coverage: {
      knownExistingThrowsTotal: simInput.throws.length,
      predictedTrackedThrowsTotal: throwForecasts.length,
      predictedUsersTotal: userForecasts.length,
      snapshotCount: 1,
      predictedGameTotals: true,
      predictedTemporal: true,
      predictedDynamicUpdates: 0,
      knownFutureUnknownThrowsMode: "not_modeled",
    },
    priceBasis: serializePriceBasis(priceLookup),
    snapshots: [
      {
        snapshotId: "initial",
        snapshotIndex: 0,
        kind: "initial_commit",
        createdAt,
        referenceFrame,
        knownThrowCount: simInput.throws.length,
        trackedThrowCount: throwForecasts.length,
        coverage: {
          trackedThrowsPct: throwForecasts.length > 0 ? 1 : 0,
          gameForecastPct: 1,
          temporalPct: 1,
          dynamicUpdatePct: 0,
        },
        throws: throwForecasts,
        users: userForecasts,
        game: gameForecast,
      },
    ],
  };

  return {
    payload,
    summary: buildSummaryFromCandidateForecast({
      weightedSettlements,
      candidateForecast,
      candidateRecord,
    }),
  };
}
