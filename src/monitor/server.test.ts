import assert from "node:assert/strict";
import { createServer } from "node:http";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from "../core/settings.js";
import { getRuntimeSettings, initRuntimeSettings } from "../core/runtime-state.js";
import { initManagerState, saveManagerCandidateSet, saveManagerOverlay, setLatestCandidateContext, setLatestEligibilitySnapshot } from "../core/manager-state.js";
import { appendResultLog, initStorage, writeArtifactJson } from "../core/storage.js";
import { startMonitorServer } from "./server.js";
import { normalizeManagerCandidateSet, normalizeManagerTacticalOverlay } from "../strategy/tactical-overlay.js";

test("map-priority API persists and syncs only the requested map; rejects unsafe requests and retains concurrent changes", async t => {
  const root=await mkdtemp(path.join(tmpdir(),'map-priority-api-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const initial={...DEFAULT_SETTINGS,maxThrowUsd:1.1,maxSingleThrowUsd:1.1,maxThrowsPerSession:500};
  await saveSettings(initial,root);let runtime=initial;
  const server=await startMonitorServer({port:0,dataDir:root,staticDir:process.cwd(),bridge:{
    getRuntimeSettings:()=>runtime,updateRuntimeSettings:patch=>(runtime={...runtime,...patch})}});
  t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
  const base='http://127.0.0.1:'+(server.address() as {port:number}).port,id='12'.repeat(32),second='34'.repeat(32);
  const save=(body:unknown,origin=base)=>fetch(base+'/api/settings/map-priority',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(body)});
  for(const body of [{mapId:id,priority:0},{mapId:id,priority:11},{mapId:id,priority:1.5},{mapId:id,priority:'10'},
    {mapId:'bad',priority:10},{mapId:id,priority:10,maxThrowUsd:99}]) assert.equal((await save(body)).status,400);
  assert.equal((await save({mapId:id,priority:10},'https://elsewhere.example')).status,400);
  const responses=await Promise.all([save({mapId:'0x'+id,priority:10}),save({mapId:second,priority:8})]);
  for(const r of responses){assert.equal(r.status,200);assert.equal((await r.json() as any).runtimeSyncPending,false);}
  const saved=await loadSettings(root);
  assert.deepEqual(saved.mapPriorities,{[id]:10,[second]:8});assert.deepEqual(runtime.mapPriorities,saved.mapPriorities);
  assert.equal(saved.maxThrowUsd,1.1);assert.equal(saved.maxThrowsPerSession,500);
});

test("confirmation switch is same-origin boolean-only and does not expose signing endpoints", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "agent1-confirmation-api-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const changes: unknown[] = [];
  const server = await startMonitorServer({ port: 0, dataDir: root, staticDir: process.cwd(), bridge: {
    getConfirmationStatus: () => ({ available: true, enabled: false, reason: "level_required", jobs: [] }),
    saveConfirmationConfig: patch => { changes.push(patch); return patch; },
  } });
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });
  const base = "http://127.0.0.1:" + (server.address() as { port: number }).port;
  assert.equal((await fetchJson(base + "/api/confirmations/status")).available, true);
  for (const [origin, body] of [
    ["https://other.example", { enabled: true }], [base, { enabled: "true" }],
    [base, { enabled: true, maxCapitalBase: "999" }], [base, { enabled: true, salt: "not-accepted" }],
  ]) {
    const response = await fetch(base + "/api/confirmations/config", { method: "POST",
      headers: { origin: String(origin), "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal(response.status, 400);
  }
  assert.equal(changes.length, 0);
  const saved = await fetchJson(base + "/api/confirmations/config", { method: "POST", headers: { origin: base, "content-type": "application/json" },
    body: JSON.stringify({ enabled: true }) });
  assert.equal(saved.config.enabled, true); assert.deepEqual(changes, [{ enabled: true }]);
});

test("runtime settings distinguish an actually uninitialized local runtime", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "collider-runtime-uninitialized-"));
  t.after(async () => rm(tempDir, { recursive: true, force: true }));
  const diagnostics: unknown[][] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => diagnostics.push(args));
  const server = await startMonitorServer({ port: 0, dataDir: tempDir, staticDir: process.cwd() });
  t.after(async () => { await new Promise((resolve) => server.close(() => resolve(undefined))); });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const response = await fetch(`http://127.0.0.1:${address.port}/api/runtime-settings`);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    ok: false, code: "RUNTIME_SETTINGS_UNINITIALIZED", source: "local",
    error: "runtime settings not initialized",
  });
  assert.equal((diagnostics[0][1] as any).code, "RUNTIME_SETTINGS_UNINITIALIZED");
});

test("a points status bridge failure returns 503 without killing the monitor", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "collider-points-bridge-failure-"));
  t.after(async () => rm(tempDir, { recursive: true, force: true }));
  let calls = 0;
  const server = await startMonitorServer({
    port: 0, dataDir: tempDir, staticDir: process.cwd(),
    bridge: { getPointsConversionStatus: () => {
      if (++calls === 1) throw new Error("simulated bridge timeout");
      return { available: true, config: { enabled: false } };
    } },
  });
  t.after(async () => { await new Promise((resolve) => server.close(() => resolve(undefined))); });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  assert.equal((await fetch(`${base}/api/points/status`)).status, 503);
  assert.equal((await fetchJson(`${base}/api/points/status`)).available, true);
});

test("points conversion API requires same-origin JSON and forwards only one explicit request", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "collider-points-api-"));
  t.after(async () => rm(tempDir, { recursive: true, force: true }));
  let saves = 0;
  let redemptions = 0;
  const server = await startMonitorServer({
    port: 0, dataDir: tempDir, staticDir: process.cwd(),
    bridge: {
      getPointsConversionStatus: () => ({ available: true, config: { enabled: false }, history: [], pending: null }),
      savePointsConversionConfig: (patch) => { saves++; return patch; },
      redeemPointsForClc: (request) => { redemptions++; return { status: "confirmed", pointsIn: request.pointsIn, nonce: 3 }; },
    },
  });
  t.after(async () => { await new Promise((resolve) => server.close(() => resolve(undefined))); });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  assert.equal((await fetchJson(`${base}/api/points/status`)).config.enabled, false);
  const body = JSON.stringify({ pointsIn: "7500", expectedPointsPerClc: "1500", requestId: "test-request-1" });
  const crossOrigin = await fetch(`${base}/api/points/redeem`, { method: "POST", headers: { "content-type": "application/json", origin: "https://other.example" }, body });
  assert.equal(crossOrigin.status, 400);
  assert.equal(redemptions, 0);
  const wrongType = await fetch(`${base}/api/points/config`, { method: "POST", headers: { origin: base, "content-type": "text/plain" }, body: "{}" });
  assert.equal(wrongType.status, 400);
  assert.equal(saves, 0);
  const saved = await fetchJson(`${base}/api/points/config`, { method: "POST", headers: { origin: base, "content-type": "application/json" }, body: JSON.stringify({ enabled: false }) });
  assert.equal(saved.config.enabled, false);
  assert.equal(saves, 1);
  const redeemed = await fetchJson(`${base}/api/points/redeem`, { method: "POST", headers: { origin: base, "content-type": "application/json" }, body });
  assert.equal(redeemed.nonce, 3);
  assert.equal(redemptions, 1);
});

test("points ledger and exact quote are served through the monitor origin without signing", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "collider-points-ledger-"));
  t.after(async () => rm(tempDir, { recursive: true, force: true }));
  const user = "ab".repeat(32);
  const clc = "0x3e0e0f0eedd306b23b0f386df33a36fac07cbd9e45a7ad02d1c40adedbee2e16";
  const calls: string[] = [];
  const rpcServer = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const rpc = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    calls.push(rpc.method);
    let result: unknown;
    if (rpc.method === "colliderV2.getLadderUser") result = { points_total: "7500", throw_count: "420" };
    else if (rpc.method === "colliderV2.getBalances") result = { [clc]: "1000000000000000000" };
    else if (rpc.method === "colliderV2.getClcRedemptionQuote") {
      result = { enabled: true, points_in: rpc.params[1], points_per_clc: "1500", clc_out: "5000000000000000000" };
    } else throw new Error(`unexpected RPC ${rpc.method}`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
  });
  await new Promise<void>((resolve) => rpcServer.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise((resolve) => rpcServer.close(() => resolve(undefined))); });
  const rpcAddress = rpcServer.address();
  assert.ok(rpcAddress && typeof rpcAddress === "object");
  await saveSettings({ ...DEFAULT_SETTINGS, user, rpc: `http://127.0.0.1:${rpcAddress.port}` }, tempDir);
  const server = await startMonitorServer({ port: 0, dataDir: tempDir, staticDir: process.cwd() });
  t.after(async () => { await new Promise((resolve) => server.close(() => resolve(undefined))); });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const ledger = await fetchJson(`${base}/api/points/ledger`);
  assert.equal(ledger.user, `0x${user}`);
  assert.equal(ledger.points, "7500");
  assert.equal(ledger.clcBase, "1000000000000000000");
  assert.equal(ledger.fullQuote.clc_out, "5000000000000000000");
  const quote = await fetchJson(`${base}/api/points/quote?pointsIn=1500`);
  assert.equal(quote.points_in, "1500");
  assert.equal((await fetch(`${base}/api/points/quote?pointsIn=-1`)).status, 400);
  const bank = await fetchJson(`${base}/api/bank/balances`);
  assert.equal(bank.user, `0x${user}`);
  assert.equal(bank.balances[clc], "1000000000000000000");
  assert.ok(bank.asOf);
  assert.deepEqual(calls.slice(0, 2).sort(), ["colliderV2.getBalances", "colliderV2.getLadderUser"]);
  assert.deepEqual(calls.slice(2), ["colliderV2.getClcRedemptionQuote", "colliderV2.getClcRedemptionQuote", "colliderV2.getBalances"]);
});

async function fetchJson(url: string, init?: RequestInit): Promise<any> {
  const response = await fetch(url, init);
  assert.equal(response.ok, true, `expected ok response from ${url}`);
  return response.json();
}

test("history summary exposes lifetime counts and incrementally observes appends", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "collider-history-summary-"));
  t.after(async () => { await rm(tempDir, { recursive: true, force: true }); });
  const gameA = "11".repeat(32);
  const gameB = "22".repeat(32);
  await writeFile(path.join(tempDir, "throws.jsonl"), [
    { ts: "2026-01-01T00:00:00.000Z", gameId: gameA, submitted: true,
      signedIntent: { status: "throw_accepted", nonce: 4 } },
    { ts: "2026-01-01T00:00:01.000Z", gameId: gameB, submitted: false },
  ].map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
  await writeFile(path.join(tempDir, "results.jsonl"), `${JSON.stringify({
    ts: "2026-01-01T00:00:02.000Z", gameId: gameA, honestScore: { honestScore: 88 },
  })}\n`, "utf8");
  const server = await startMonitorServer({ port: 0, dataDir: tempDir, staticDir: process.cwd() });
  t.after(async () => { await new Promise((resolve) => server.close(() => resolve(undefined))); });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const first = await fetchJson(`${baseUrl}/api/history/summary`);
  assert.deepEqual({ rows: first.throws.rows, accepted: first.throws.accepted, games: first.throws.games,
    latestNonce: first.throws.latestNonce, scored: first.results.scored, resultGames: first.results.games,
    pending: first.pendingAcceptedThrows },
  { rows: 2, accepted: 1, games: 2, latestNonce: 4, scored: 1, resultGames: 1, pending: 0 });
  await appendFile(path.join(tempDir, "throws.jsonl"), `${JSON.stringify({
    ts: "2026-01-01T00:00:03.000Z", gameId: gameB, submitted: true,
    signedIntent: { status: "throw_accepted", nonce: 5 },
  })}\n`, "utf8");
  const second = await fetchJson(`${baseUrl}/api/history/summary`);
  assert.equal(second.throws.rows, 3);
  assert.equal(second.throws.accepted, 2);
  assert.equal(second.throws.games, 2);
  assert.equal(second.throws.latestNonce, 5);
  assert.equal(second.pendingAcceptedThrows, 1);
});

test("per-game accepted totals survive the bounded 100-throw tail", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "collider-game-history-"));
  t.after(async () => { await rm(tempDir, { recursive: true, force: true }); });
  const gameA = "11".repeat(32);
  const gameB = "22".repeat(32);
  const asset = "09".repeat(32);
  const rows = Array.from({ length: 11 }, (_, nonce) => ({
    ts: new Date(1_800_000_000_000 + nonce * 1000).toISOString(), gameId: gameA,
    decisionId: `a-${nonce}`, submitted: true,
    signedIntent: { status: "throw_accepted", nonce },
    payload: { asset, amount: "10" },
  })).concat(Array.from({ length: 110 }, (_, index) => ({
    ts: new Date(1_800_000_100_000 + index * 1000).toISOString(), gameId: gameB,
    decisionId: `b-${index}`, submitted: true,
    signedIntent: { status: "throw_accepted", nonce: index + 11 },
    payload: { asset, amount: "10" },
  })));
  await writeFile(path.join(tempDir, "throws.jsonl"), rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  const server = await startMonitorServer({ port: 0, dataDir: tempDir, staticDir: process.cwd() });
  t.after(async () => { await new Promise((resolve) => server.close(() => resolve(undefined))); });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const tail = await fetchJson(`${baseUrl}/api/logs/throws?limit=100`);
  assert.equal(tail.some((row: { gameId: string }) => row.gameId === gameA), false);
  const summary = await fetchJson(`${baseUrl}/api/history/summary`);
  const olderGame = summary.recentGames.find((game: { gameId: string }) => game.gameId === gameA);
  assert.equal(olderGame.accepted, 11);
  assert.equal(olderGame.inputsByAsset[asset], "110");
  assert.equal(olderGame.resolved, 0);
  assert.equal(summary.bank.outByAsset[asset], "1210");
  assert.equal(summary.bank.pendingByAsset[asset], "1210");
  const completeGame = await fetchJson(`${baseUrl}/api/history/game?gameId=${gameA}`);
  assert.equal(completeGame.throws.length, 11);
  assert.equal(completeGame.gameId, gameA);
  await appendFile(path.join(tempDir, "results.jsonl"), `${JSON.stringify({
    ts: new Date(1_800_000_220_000).toISOString(), gameId: gameA,
    decisionId: "a-0", actual: { wholeGame: {} },
  })}\n`);
  const settledSummary = await fetchJson(`${baseUrl}/api/history/summary`);
  assert.equal(settledSummary.recentGames.find((game: { gameId: string }) => game.gameId === gameA).resolved, 1);
  assert.equal(settledSummary.bank.pendingByAsset[asset], "1200");
  assert.equal(settledSummary.bank.unverifiedReturnDecisions, 1);
  await appendFile(path.join(tempDir, "results.jsonl"), `${JSON.stringify({
    ts: new Date(1_800_000_221_000).toISOString(), gameId: gameA,
    decisionId: "a-0", actual: { throwMatch: { returned_by_asset_exact: true, returned_by_asset_source: "canonical_throw_payouts",
      returned_by_asset: { [asset]: "15" } } },
  })}\n`);
  const exactSummary = await fetchJson(`${baseUrl}/api/history/summary`);
  assert.equal(exactSummary.bank.inByAsset[asset], "15");
  assert.equal(exactSummary.bank.unverifiedReturnDecisions, 0);
});

test("log routes return 304 when the bounded source file is unchanged", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "collider-log-etag-"));
  t.after(async () => { await rm(tempDir, { recursive: true, force: true }); });
  await writeFile(path.join(tempDir, "throws.jsonl"), JSON.stringify({ ts: "2026-01-01T00:00:00.000Z" }) + "\n", "utf8");
  const server = await startMonitorServer({ port: 0, dataDir: tempDir, staticDir: process.cwd() });
  t.after(async () => { await new Promise((resolve) => server.close(() => resolve(undefined))); });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = "http://127.0.0.1:" + address.port + "/api/logs/throws?limit=100";
  const first = await fetch(url);
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), [{ ts: "2026-01-01T00:00:00.000Z" }]);
  const etag = first.headers.get("etag");
  assert.ok(etag);
  const unchanged = await fetch(url, { headers: { "if-none-match": etag } });
  assert.equal(unchanged.status, 304);
  assert.equal(await unchanged.text(), "");
});

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

test("runtime settings bridge timeout stays unavailable even when local settings exist", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "collider-runtime-read-timeout-"));
  t.after(async () => rm(tempDir, { recursive: true, force: true }));
  const local = { ...DEFAULT_SETTINGS, maxSingleThrowUsd: 10, maxThrowsPerSession: 934 };
  initRuntimeSettings(local);
  const diagnostics: unknown[][] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => diagnostics.push(args));
  let writes = 0;
  const server = await startMonitorServer({
    port: 0, dataDir: tempDir, staticDir: process.cwd(),
    bridge: {
      getRuntimeSettings: () => new Promise<never>(() => undefined),
      updateRuntimeSettings: () => { writes++; return local; },
      applyControlAction: () => { writes++; return { state: "live" }; },
    },
  });
  t.after(async () => { await new Promise((resolve) => server.close(() => resolve(undefined))); });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const started = Date.now();
  const response = await fetch(`http://127.0.0.1:${address.port}/api/runtime-settings`);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    ok: false, code: "RUNTIME_SETTINGS_BRIDGE_TIMEOUT", source: "bridge",
    error: "runtime settings bridge read timed out",
  });
  assert.ok(Date.now() - started < 5000, "unavailable reads must remain bounded");
  assert.equal((diagnostics[0][1] as any).code, "RUNTIME_SETTINGS_BRIDGE_TIMEOUT");
  assert.equal(writes, 0);
  assert.deepEqual(getRuntimeSettings(), local);
});

test("runtime settings preserve bridge errors and recover without a settings mutation", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "collider-runtime-read-recovery-"));
  t.after(async () => rm(tempDir, { recursive: true, force: true }));
  const local = { ...DEFAULT_SETTINGS, maxSingleThrowUsd: 1 };
  const remote = { ...DEFAULT_SETTINGS, maxSingleThrowUsd: 10, maxThrowsPerSession: 934 };
  initRuntimeSettings(local);
  const diagnostics: unknown[][] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => diagnostics.push(args));
  let calls = 0;
  const server = await startMonitorServer({
    port: 0, dataDir: tempDir, staticDir: process.cwd(),
    bridge: { getRuntimeSettings: () => {
      if (++calls === 1) throw new Error("simulated upstream diagnostic detail");
      return remote;
    } },
  });
  t.after(async () => { await new Promise((resolve) => server.close(() => resolve(undefined))); });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const failed = await fetch(`${base}/api/runtime-settings`);
  assert.equal(failed.status, 503);
  assert.deepEqual(await failed.json(), {
    ok: false, code: "RUNTIME_SETTINGS_READ_FAILED", source: "bridge",
    error: "runtime settings read unavailable",
  });
  assert.deepEqual(await fetchJson(`${base}/api/runtime-settings`), remote);
  assert.equal(calls, 2);
  assert.deepEqual(getRuntimeSettings(), local);
  assert.equal(JSON.stringify(diagnostics).includes("upstream diagnostic detail"), false);
});

test("runtime settings report explicit bridge uninitialized responses separately from timeout", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "collider-runtime-bridge-uninitialized-"));
  t.after(async () => rm(tempDir, { recursive: true, force: true }));
  initRuntimeSettings({ ...DEFAULT_SETTINGS });
  t.mock.method(console, "warn", () => undefined);
  let calls = 0;
  const server = await startMonitorServer({
    port: 0, dataDir: tempDir, staticDir: process.cwd(),
    bridge: { getRuntimeSettings: () => {
      if (++calls === 1) throw new Error("Error: runtime settings not initialized");
      return null;
    } },
  });
  t.after(async () => { await new Promise((resolve) => server.close(() => resolve(undefined))); });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  for (let attempt = 0; attempt < 2; attempt++) {
    const response: Response = await fetch(`http://127.0.0.1:${address.port}/api/runtime-settings`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      ok: false, code: "RUNTIME_SETTINGS_UNINITIALIZED", source: "bridge",
      error: "runtime settings not initialized",
    });
  }
});

test('controlled manager UI audit supports the declared240 rounds and rejects expired, mismatched and out-of-bound reports',async t=>{const root=await mkdtemp(path.join(tmpdir(),'manager-round-limit-'));t.after(()=>rm(root,{recursive:true,force:true}));const file=path.join(root,'manager-experiment.json');const marker={active:true,stopAt:new Date(Date.now()+60000).toISOString(),model:'gpt-6.1-terra',maxInferenceRounds:240};await writeFile(file,JSON.stringify(marker));const server=await startMonitorServer({port:0,dataDir:root,staticDir:process.cwd()});t.after(()=>new Promise<void>(r=>server.close(()=>r())));const base='http://127.0.0.1:'+(server.address() as {port:number}).port;const post=(round:number,model=marker.model,origin=base)=>fetch(base+'/api/manager/experiment/decision',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({model,round,reply:'Bounded tactical decision; no transaction.',policyId:'test-'+round})});for(const n of [95,96,100,239])assert.equal((await post(n)).status,200);for(const n of [-1,240,800,1.5])assert.equal((await post(n)).status,400);assert.equal((await post(100,'different')).status,400);assert.equal((await post(100,marker.model,'https://elsewhere.invalid')).status,400);await writeFile(file,JSON.stringify({...marker,stopAt:new Date(0).toISOString()}));assert.equal((await post(100)).status,400);await writeFile(file,JSON.stringify({...marker,maxInferenceRounds:undefined}));assert.equal((await post(95)).status,200);assert.equal((await post(96)).status,400);await writeFile(file,JSON.stringify({...marker,maxInferenceRounds:241}));assert.equal((await post(100)).status,400);});
