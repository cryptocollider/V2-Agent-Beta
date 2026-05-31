import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

test("manager API falls back to file-backed state when bridge reads stall", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "collider-manager-timeout-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  await initManagerState(tempDir);
  setLatestEligibilitySnapshot(null);
  setLatestCandidateContext(null);
  await saveSettings({
    ...DEFAULT_SETTINGS,
    user: "aa".repeat(32),
    asset: "01".repeat(32),
    amount: "100",
  }, tempDir);
  await saveManagerOverlay(normalizeManagerTacticalOverlay({ id: "overlay-timeout", notes: ["file-backed"] }));
  await saveManagerCandidateSet(normalizeManagerCandidateSet({
    id: "candidate-timeout",
    candidates: [],
  }));
  await writeFile(path.join(tempDir, "runs.jsonl"), `${JSON.stringify({
    ts: new Date().toISOString(),
    gameId: "22".repeat(32),
    stoppedBy: "complete",
    eligibilityCode: "NO-CAND/BAL",
    eligibility: {
      globalReasons: ["reserve_balance"],
      perGame: [],
      assetPlanning: [],
      candidateFilterSummary: {
        reasonCounts: { reserve_balance: 1 },
        totalRawCandidates: 1,
        totalEligibleCandidates: 0,
        limitedCandidates: 0,
        plannedCandidates: 0,
      },
      notes: [],
    },
    topDetailed: [
      {
        rank: 1,
        candidateHash: "winner-timeout",
        source: "grid",
        asset: "01".repeat(32),
        amount: "100",
        x: 10,
        y: 20,
        angleDeg: 30,
        speedPct: 40,
        spinPct: 50,
        adjustedScore: {
          weightedTotal: 1,
          worstCaseTotal: 1,
          bestCaseTotal: 1,
          fragilityPenalty: 0,
          final: 1,
        },
      },
    ],
  })}\n`, "utf8");

  const never = () => new Promise<never>(() => undefined);
  const server = await startMonitorServer({
    port: 0,
    dataDir: tempDir,
    staticDir: process.cwd(),
    bridge: {
      getRuntimeSettings: never,
      getControlState: never,
      getLatestEligibilitySnapshot: never,
      getLatestCandidateContext: never,
      getManagerOverlay: never,
      getManagerCandidateSet: never,
    },
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  });

  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const started = Date.now();
  const settings = await fetchJson(`${baseUrl}/api/settings`);
  const state = await fetchJson(`${baseUrl}/api/manager/state`);
  const elapsedMs = Date.now() - started;

  assert.ok(elapsedMs < 4000, `fallback responses should not hang, took ${elapsedMs}ms`);
  assert.equal(settings.user, "aa".repeat(32));
  assert.equal(state.overlay.id, "overlay-timeout");
  assert.equal(state.managerCandidateSet.id, "candidate-timeout");
  assert.equal(state.eligibilityCode, "NO-CAND/BAL");
  assert.equal(state.latestCandidates.candidates[0].candidateHash, "winner-timeout");
});

test("local json artifact route resolves windows-style data paths from the app root", async (t) => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "collider-local-json-"));
  const dataDir = path.join(tempRoot, "data");
  const revealDir = path.join(dataDir, "prediction-reveals");
  const revealPath = path.join(revealDir, "artifact.json");

  t.after(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  await initManagerState(dataDir);
  await mkdir(revealDir, { recursive: true });
  await writeFile(revealPath, JSON.stringify({ ok: true, source: "windows-style-path" }), "utf8");

  const server = await startMonitorServer({ port: 0, dataDir, staticDir: tempRoot });
  t.after(async () => {
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  });

  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const payload = await fetchJson(`${baseUrl}/api/local-json?path=${encodeURIComponent("data\\prediction-reveals\\artifact.json")}`);
  assert.equal(payload.ok, true);
  assert.equal(payload.source, "windows-style-path");
});

test("settings routes persist onboarding and tolerate stalled runtime bridge writes", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "collider-settings-write-timeout-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  await initManagerState(tempDir);
  await saveSettings({
    ...DEFAULT_SETTINGS,
    user: "aa".repeat(32),
    asset: "01".repeat(32),
    amount: "100",
  }, tempDir);

  const never = () => new Promise<never>(() => undefined);
  const server = await startMonitorServer({
    port: 0,
    dataDir: tempDir,
    staticDir: process.cwd(),
    bridge: {
      updateRuntimeSettings: never,
      getRuntimeSettings: never,
    },
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  });

  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const onboarding = await fetchJson(`${baseUrl}/api/settings/onboarding`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      onboarding: {
        welcomeDismissedAt: "2026-05-07T00:00:00.000Z",
      },
    }),
  });
  assert.equal(onboarding.ok, true);
  assert.equal(onboarding.settings.onboarding.welcomeDismissedAt, "2026-05-07T00:00:00.000Z");

  const started = Date.now();
  const saved = await fetchJson(`${baseUrl}/api/settings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      minThrowUsd: 3,
    }),
  });
  const elapsedMs = Date.now() - started;

  assert.ok(elapsedMs < 10000, `settings save should return quickly even if the runtime bridge stalls, took ${elapsedMs}ms`);
  assert.equal(saved.ok, true);
  assert.equal(saved.settings.minThrowUsd, 3);
  assert.equal(saved.runtimeSyncPending, true);

  const persisted = await fetchJson(`${baseUrl}/api/settings`);
  assert.equal(persisted.minThrowUsd, 3);
});

test("manager API exposes explicit replay svg export through the bridge", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "collider-manager-svg-"));
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

  const server = await startMonitorServer({
    port: 0,
    dataDir: tempDir,
    staticDir: process.cwd(),
    bridge: {
      buildReplaySvgExport: async (request) => ({
        mode: "forecast_storyboard_v1",
        exactPhysics: false,
        gameId: (request as any).gameId,
        generatedAt: new Date().toISOString(),
        finalFrame: 321,
        selectedFrames: (request as any).frames,
        notes: ["explicit export only"],
        frames: [{ frame: 12, visibleThrows: 2, resolvedThrows: 1, svg: "<svg/>" }],
      }),
    },
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  });

  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const replay = await fetchJson(`${baseUrl}/api/manager/replay-svg`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      gameId: "11".repeat(32),
      frames: [12, 44, 44],
    }),
  });

  assert.equal(replay.ok, true);
  assert.equal(replay.replay.mode, "forecast_storyboard_v1");
  assert.equal(replay.replay.exactPhysics, false);
  assert.deepEqual(replay.replay.selectedFrames, [12, 44]);
  assert.equal(replay.replay.frames[0].svg, "<svg/>");
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

test("manager LLM autodetect configures an ollama startup path", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "collider-manager-llm-autodetect-"));
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

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
    if (url === "http://127.0.0.1:11434/api/tags") {
      return new Response(JSON.stringify({
        models: [{ name: "qwen3:8b" }],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "http://127.0.0.1:11434/api/chat") {
      const body = JSON.parse(String(init?.body || "{}"));
      assert.equal(body.model, "qwen3:8b");
      return new Response(JSON.stringify({
        model: "qwen3:8b",
        message: {
          content: JSON.stringify({
            reply: "Ollama is awake inside Agent 1 and ready to guide the operator.",
            summary: "Ollama startup brief delivered.",
            proposals: [],
          }),
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const server = await startMonitorServer({ port: 0, dataDir: tempDir, staticDir: process.cwd() });
  t.after(async () => {
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  });

  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const autodetect = await fetchJson(`${baseUrl}/api/manager/llm/autodetect`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prefer: "any" }),
  });
  assert.equal(autodetect.ok, true);
  assert.equal(autodetect.detected.providerId, "ollama");
  assert.equal(autodetect.state.config.activeProvider, "ollama");
  assert.equal(autodetect.state.config.providers.ollama.enabled, true);
  assert.equal(autodetect.state.config.providers.ollama.model, "qwen3:8b");

  const chat = await fetchJson(`${baseUrl}/api/manager/llm/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      message: "Give me the startup brief.",
    }),
  });
  assert.equal(chat.ok, true);
  assert.equal(chat.summary, "Ollama startup brief delivered.");
  assert.equal(chat.state.lastProvider, "ollama");
});
test("manager LLM panel supports local provider chat and bounded apply", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "collider-manager-llm-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  await initManagerState(tempDir);
  initRuntimeSettings({
    ...DEFAULT_SETTINGS,
    user: "aa".repeat(32),
    asset: "01".repeat(32),
    amount: "100",
    riskMode: "balanced",
    minThrowUsd: 11,
  });
  await saveSettings({
    ...DEFAULT_SETTINGS,
    user: "aa".repeat(32),
    asset: "01".repeat(32),
    amount: "100",
    riskMode: "balanced",
    minThrowUsd: 11,
  }, tempDir);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
    if (url === "http://127.0.0.1:1234/v1/chat/completions") {
      const body = JSON.parse(String(init?.body || "{}"));
      assert.equal(body.model, "local-test-model");
      return new Response(JSON.stringify({
        model: "local-test-model",
        choices: [{
          message: {
            content: JSON.stringify({
              reply: "Tightened the live plan and prepared a safe settings patch.",
              summary: "Local manager proposed a defensive beta patch.",
              proposals: [{
                kind: "settings_patch",
                title: "Tighten beta risk",
                why: "Reduce throw aggression for the public beta opening pass.",
                payload: {
                  riskMode: "defensive",
                  minThrowUsd: 9,
                },
              }],
            }),
          },
        }],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const server = await startMonitorServer({ port: 0, dataDir: tempDir, staticDir: process.cwd() });
  t.after(async () => {
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  });

  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const config = await fetchJson(`${baseUrl}/api/manager/llm/config`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      activeProvider: "local",
      providers: {
        local: {
          enabled: true,
          model: "local-test-model",
          endpointUrl: "http://127.0.0.1:1234/v1/chat/completions",
        },
      },
    }),
  });
  assert.equal(config.ok, true);
  assert.equal(config.state.config.activeProvider, "local");
  assert.equal(config.state.config.providers.local.enabled, true);

  const chat = await fetchJson(`${baseUrl}/api/manager/llm/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      message: "Set up a safer beta posture for launch week.",
    }),
  });
  assert.equal(chat.ok, true);
  assert.equal(chat.summary, "Local manager proposed a defensive beta patch.");
  assert.equal(chat.actions.length, 1);
  assert.equal(chat.state.lastProvider, "local");
  assert.equal(chat.state.pendingActions[0].title, "Tighten beta risk");

  const applied = await fetchJson(`${baseUrl}/api/manager/llm/apply`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ actionId: chat.actions[0].id }),
  });
  assert.equal(applied.ok, true);
  assert.equal(applied.applied.settings.riskMode, "defensive");
  assert.equal(applied.applied.settings.minThrowUsd, 9);
  assert.equal(applied.state.pendingActions[0].appliedAt !== null, true);

  const state = await fetchJson(`${baseUrl}/api/manager/state`);
  assert.equal(state.llmManager.config.activeProvider, "local");
  assert.equal(state.llmManager.lastSummary, "Local manager proposed a defensive beta patch.");
  assert.equal(state.settings.riskMode, "defensive");
  assert.equal(state.settings.minThrowUsd, 9);
});
