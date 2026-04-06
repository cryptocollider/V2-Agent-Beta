import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_SETTINGS, saveSettings } from "../core/settings.js";
import { initRuntimeSettings } from "../core/runtime-state.js";
import { initManagerState, saveManagerCandidateSet, saveManagerOverlay, setLatestCandidateContext, setLatestEligibilitySnapshot } from "../core/manager-state.js";
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
