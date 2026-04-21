import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_SETTINGS, saveSettings } from "../core/settings.js";
import { initRuntimeSettings } from "../core/runtime-state.js";
import { initManagerState, saveManagerCandidateSet, saveManagerOverlay, setLatestCandidateContext, setLatestEligibilitySnapshot } from "../core/manager-state.js";
import { appendResultLog, initStorage, writeArtifactJson } from "../core/storage.js";
import { startMonitorServer } from "./server.js";
import { normalizeManagerCandidateSet, normalizeManagerTacticalOverlay } from "../strategy/tactical-overlay.js";

async function fetchJson(url: string, init?: RequestInit): Promise<any> {
  const response = await fetch(url, init);
  assert.equal(response.ok, true, `expected ok response from ${url}`);
  return response.json();
}

test("manager API exposes state, overlay, and candidate-set controls", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "collider-manager-api-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  await initManagerState(tempDir);
  initRuntimeSettings({
    ...DEFAULT_SETTINGS,
    user: "aa".repeat(32),
    asset: "01".repeat(32),
    amount: "100",
  });
  await saveSettings({
    ...DEFAULT_SETTINGS,
    user: "aa".repeat(32),
    asset: "01".repeat(32),
    amount: "100",
  }, tempDir);

  await saveManagerOverlay(normalizeManagerTacticalOverlay({ id: "overlay-a", notes: ["operator test"] }));
  await saveManagerCandidateSet(normalizeManagerCandidateSet({
    id: "candidate-set-a",
    candidates: [
      {
        id: "candidate-a",
        x: 1,
        y: 2,
        angleDeg: 3,
        speedPct: 4,
        spinPct: 5,
        asset: "01".repeat(32),
        amount: "100",
        enabled: true,
      },
    ],
  }));

  setLatestEligibilitySnapshot({
    ts: new Date().toISOString(),
    globalReasons: ["reserve_balance"],
    selectedGameId: null,
    perGame: [],
    assetPlanning: [],
    candidateFilterSummary: { reasonCounts: {}, totalRawCandidates: 0, totalEligibleCandidates: 0, limitedCandidates: 0, plannedCandidates: 0 },
    notes: [],
  });
  setLatestCandidateContext({
    ts: new Date().toISOString(),
    gameId: null,
    stoppedBy: "reserve_balance",
    winnerCandidateHash: null,
    overlay: normalizeManagerTacticalOverlay({ id: "overlay-a" }),
    managerCandidateSet: normalizeManagerCandidateSet({ id: "candidate-set-a", candidates: [] }),
    candidates: [],
  });

  const server = await startMonitorServer({ port: 0, dataDir: tempDir, staticDir: process.cwd() });
  t.after(async () => {
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  });

  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const state = await fetchJson(`${baseUrl}/api/manager/state`);
  assert.equal(state.eligibilityCode, "NO-CAND/BAL");
  assert.equal(state.profile.doctrinePack, "baseline");
  assert.equal(state.overlay.id, "overlay-a");
  assert.equal(state.managerCandidateSet.id, "candidate-set-a");
  assert.equal(state.audit.matrix.some((entry: any) => entry.key === "riskMode"), true);

  const overlayPost = await fetchJson(`${baseUrl}/api/manager/overlay`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "overlay-b", notes: ["updated"] }),
  });
  assert.equal(overlayPost.overlay.id, "overlay-b");

  const candidateSetPost = await fetchJson(`${baseUrl}/api/manager/candidate-set`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: "candidate-set-b",
      candidates: [
        {
          id: "candidate-b",
          x: 6,
          y: 7,
          angleDeg: 8,
          speedPct: 9,
          spinPct: 10,
          asset: "01".repeat(32),
          amount: "200",
          enabled: true,
          futureScenarios: [
            {
              id: "future-b",
              futureThrows: [
                {
                  id: "future-throw-b",
                  user: "bb".repeat(32),
                  x: 11,
                  y: 12,
                  angleDeg: 13,
                  speedPct: 14,
                  spinPct: 15,
                  asset: "01".repeat(32),
                  amount: "180",
                  enabled: true,
                },
              ],
            },
          ],
        },
      ],
    }),
  });
  assert.equal(candidateSetPost.managerCandidateSet.id, "candidate-set-b");
  assert.equal(candidateSetPost.managerCandidateSet.candidates[0].futureScenarios.length, 1);
});

test("manager API exposes honest-score summaries and reveal artifacts", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "collider-manager-hps-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  await initManagerState(tempDir);
  initRuntimeSettings({
    ...DEFAULT_SETTINGS,
    user: "aa".repeat(32),
    asset: "01".repeat(32),
    amount: "100",
  });
  await saveSettings({
    ...DEFAULT_SETTINGS,
    user: "aa".repeat(32),
    asset: "01".repeat(32),
    amount: "100",
  }, tempDir);

  const storage = await initStorage(tempDir);
  const gameId = "11".repeat(32);
  const botUser = "aa".repeat(32);
  const decisionId = "bb".repeat(10);
  const commitRef = await writeArtifactJson({
    dir: storage.predictionCommitsDir,
    schema: "collider.prediction.commit.v1",
    payload: {
      schema: "collider.prediction.commit.v1",
      version: 1,
      decisionId,
      gameId,
      snapshots: [],
    },
  });
  const revealRef = await writeArtifactJson({
    dir: storage.predictionRevealsDir,
    schema: "collider.prediction.reveal.v1",
    payload: {
      schema: "collider.prediction.reveal.v1",
      version: 1,
      gameId,
      headline: { honestScore: 44.5 },
      coverage: {
        predictedTrackedThrowsTotal: 2,
        predictedGameTotals: true,
        predictedTemporal: true,
      },
      evaluations: {
        throws: [
          {
            subjectKey: "throw-a",
            source: "existing",
            actualThrowId: "cc".repeat(32),
            predictedHoleType: 3,
            predictedReturnedUsd: 1,
            predictedPnlUsd: 0.2,
            predictedEndFrame: 144,
            historyPoints: 2,
          },
          {
            subjectKey: "candidate:next",
            source: "candidate",
            actualThrowId: "dd".repeat(32),
            predictedHoleType: 4,
            predictedReturnedUsd: 0.5,
            predictedPnlUsd: -0.5,
            predictedEndFrame: 188,
            historyPoints: 1,
          },
        ],
        temporalHistory: {
          game: [],
          throws: [
            {
              subjectKey: "throw-a",
              actualThrowId: "cc".repeat(32),
              user: botUser,
              enterFrame: 12,
              source: "existing",
              points: [
                {
                  predictedHoleType: 3,
                  predictedReturnedUsd: 1,
                  predictedPnlUsd: 0.2,
                  predictedEndFrame: 144,
                },
              ],
            },
            {
              subjectKey: "candidate:next",
              actualThrowId: "dd".repeat(32),
              user: botUser,
              enterFrame: 33,
              source: "candidate",
              points: [
                {
                  predictedHoleType: 4,
                  predictedReturnedUsd: 0.5,
                  predictedPnlUsd: -0.5,
                  predictedEndFrame: 188,
                },
              ],
            },
          ],
        },
      },
    },
  });

  await appendResultLog(storage, {
    ts: new Date().toISOString(),
    sessionId: "session-hps",
    decisionId,
    gameId,
    botUser,
    actual: {
      throwMatch: {
        matched: true,
        hole_type: 3,
        value_usd_e8: "100000000",
      },
    },
    expected: {
      predictionCommitSha256Hex: commitRef.sha256Hex,
    },
    predictionCommit: commitRef,
    predictionReveal: revealRef,
    honestScore: {
      schema: "collider.prediction.reveal.v1",
      honestScore: 44.5,
      bce: 0.2,
      rps: 0.3,
      temporalError: 0.4,
      coverage: {
        predictedTrackedThrowsTotal: 2,
        predictedGameTotals: true,
        predictedTemporal: true,
      },
      layers: {
        outcome: { score: 70, error: 30, evaluatedThrows: 2, predictedThrows: 2 },
        value: { score: 60, error: 40, evaluatedThrows: 2, predictedThrows: 2 },
        game: { score: 50, error: 50, actualFinalFrame: 200, predictedFinalFrame: 188 },
        temporal: { score: 55, endFrameMae: 20, dynamicShiftError: 10, horizonAccuracy: 65, certaintyBreach: 12, evaluatedThrows: 2, predictedThrows: 2, historyPoints: 3, dynamicUpdates: 1 },
      },
    },
  });

  const server = await startMonitorServer({ port: 0, dataDir: tempDir, staticDir: process.cwd() });
  t.after(async () => {
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  });

  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const state = await fetchJson(`${baseUrl}/api/manager/state`);
  assert.equal(state.honestPerformance.counts.scoredRows, 1);
  assert.equal(state.honestPerformance.latestScored.gameId, gameId);
  assert.equal(state.honestPerformance.baseline.method, "agent_local_bootstrap_v2");
  assert.equal(state.honestPerformance.baseline.calibration.status, "insufficient_rows");
  assert.equal(state.honestPerformance.baseline.calibration.rowsConsumed, 1);
  assert.equal(state.honestPerformance.baseline.headline.currentScorePct, 44.5);
  assert.equal(state.honestPerformance.baseline.headline.liftPct, 0);

  const honestScore = await fetchJson(`${baseUrl}/api/manager/honest-score?includeArtifacts=1`);
  assert.equal(honestScore.counts.revealRows, 1);
  assert.equal(honestScore.profile.doctrinePack, "baseline");
  assert.equal(honestScore.baseline.headline.baselineScorePct, 44.5);
  assert.equal(honestScore.latestScored.revealPayload.schema, "collider.prediction.reveal.v1");
  assert.equal(honestScore.latestScored.commitPayload.schema, "collider.prediction.commit.v1");

  const reveals = await fetchJson(`${baseUrl}/api/manager/reveals?gameId=${gameId}&includeArtifacts=1`);
  assert.equal(reveals.count, 1);
  assert.equal(reveals.rows[0].gameId, gameId);
  assert.equal(reveals.rows[0].revealPayload.evaluations.throws.length, 2);
});
