import assert from "node:assert/strict";
import test from "node:test";
import { applyOverlayToCandidate, buildManagerCandidateSpecMap, buildManagerCandidates, normalizeManagerCandidateSet, normalizeManagerTacticalOverlay } from "./tactical-overlay.js";

const asset = "01".repeat(32);

test("manager candidate sets build manager-source candidates and preserve future scenarios", () => {
  const candidateSet = normalizeManagerCandidateSet({
    id: "manager-test-set",
    candidates: [
      {
        id: "candidate-a",
        x: 10,
        y: 20,
        angleDeg: 30,
        speedPct: 40,
        spinPct: 5,
        asset,
        amount: "100",
        enabled: true,
        futureScenarios: [
          {
            id: "future-1",
            futureThrows: [
              {
                id: "follow-up-1",
                user: "aa".repeat(32),
                x: 11,
                y: 21,
                angleDeg: 31,
                speedPct: 41,
                spinPct: 6,
                asset,
                amount: "90",
                enabled: true,
              },
            ],
          },
        ],
      },
    ],
  });

  const candidates = buildManagerCandidates(candidateSet);
  const map = buildManagerCandidateSpecMap(candidateSet);

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.source, "manager");
  assert.ok(candidates[0]?.tags.includes("manager-proposed"));
  assert.equal(map.size, 1);
  assert.equal([...map.values()][0]?.futureScenarios?.length, 1);
});

test("overlay application adjusts manager candidates without overwriting the base prediction", () => {
  const overlay = normalizeManagerTacticalOverlay({
    id: "overlay-a",
    candidateSourceScoreDeltas: { manager: 10 },
    pnlBiasUsd: 1,
    winnerValuePctBias: 5,
  });
  const candidate = {
    x: 10,
    y: 20,
    angleDeg: 30,
    speedPct: 40,
    spinPct: 5,
    asset,
    amount: "100",
    source: "manager" as const,
    tags: [],
  };
  const basePrediction = {
    scenarioCount: 1,
    winnerScenarioCount: 1,
    pnlUsd: 2,
    bestPnlUsd: 3,
    worstPnlUsd: 1,
    holeType: 3,
    holeTypeCounts: { "3": 1 },
    valueUsd: 5,
    valueUsdE8: "500000000",
    massUsd: 5,
    winnerValuePct: 50,
  };

  const applied = applyOverlayToCandidate({
    overlay,
    candidate,
    candidateHash: "candidate-hash",
    baseScore: { weightedTotal: 100, worstCaseTotal: 80, bestCaseTotal: 120, fragilityPenalty: 1, final: 99 },
    basePrediction,
  });

  assert.equal(applied.scoreDelta, 10);
  assert.equal(applied.adjustedScore.final, 109);
  assert.equal(basePrediction.pnlUsd, 2);
  assert.equal(applied.adjustedPrediction?.pnlUsd, 3);
  assert.equal(applied.adjustedPrediction?.winnerValuePct, 55);
});
