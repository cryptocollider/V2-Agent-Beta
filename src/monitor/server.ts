import {researchSnapshot} from '../experiments/research-controller.js';
import {DOCTRINE_SEEDS,DOCTRINE_KNOWLEDGE,DOCTRINE_KNOWLEDGE_VERSION,doctrineKnowledge} from '../core/doctrine-knowledge.js';
import {DOCTRINE_PACK_PRESETS} from '../core/agent-profile.js';
import { existsSync } from "node:fs";
import http from "node:http";
import { publisherStatus, setExplorerPublishing, queueExistingReveals } from "../publisher/publisher.js";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { ColliderClient } from "../collider/client.js";
import { CLC_ASSET } from "../points/conversion.js";
import { readJsonlTail } from "../core/jsonl.js";
import { buildEligibilityCompactCode } from "../agent/eligibility.js";
import { buildSettingsAuditReport } from "../agent/settings-audit.js";
import { resolveAgentProfile } from "../core/agent-profile.js";
import { buildBootstrapSummary } from "../core/bootstrap.js";
import { normalizeAssetsMetaPayload } from "../core/assets-meta.js";
import { normalizeReplaySvgRequest, type ReplaySvgRequest } from "./replay-svg.js";
import { buildHonestPerformanceBaseline } from "../core/hps-baseline.js";
import { HistorySummaryReader } from "./history-summary.js";
import {
  getControlState,
  getRuntimeSettings,
  applyControlAction,
  updateRuntimeSettings,
} from "../core/runtime-state.js";
import { loadSettings, normalizeSettings, saveSettings } from "../core/settings.js";
import { canonicalMapId } from "../core/map-priority.js";
import { JsonRpcClient, isPublicReadMethod } from "../core/rpc.js";
import { PUBLIC_RC1 } from "../public-rc1/contract.js";
import { assertPublicSettings } from "../public-rc1/profile.js";
import {
  getLatestCandidateContext,
  getLatestEligibilitySnapshot,
  getManagerCandidateSet,
  getManagerOverlay,
  saveManagerCandidateSet,
  saveManagerOverlay,
} from "../core/manager-state.js";
import {
  addManagerLlmPendingActions,
  appendManagerLlmMessage,
  getManagerLlmState,
  getPublicManagerLlmState,
  initManagerLlmState,
  resetManagerLlmSession,
  saveManagerLlmConfig,
  setManagerLlmBusy,
  setManagerLlmError,
  setManagerLlmResponseMeta,
  updateManagerLlmAction,
} from "../llm/state.js";
import {
  appendManagerLlmAuditEntry,
  initManagerLlmAudit,
  readManagerLlmAuditEntries,
} from "../llm/audit.js";
import { autoDetectLocalManagerProvider } from "../llm/autodetect.js";
import { runManagerConversation } from "../llm/session.js";
import {
  applyManagerLlmAction,
  buildManagerStatePayload,
  captureManagerLlmActionSnapshot,
  fetchAssetsMeta,
  saveSettingsAndRuntime,
  toManagerLlmSnapshot,
} from "../llm/server-support.js";
import {
  normalizeManagerCandidateSet,
  normalizeManagerTacticalOverlay,
} from "../strategy/tactical-overlay.js";

export type MonitorBridge = {
  getAgentName?:()=>unknown|Promise<unknown>;
  setAgentName?:(request:Record<string,unknown>)=>unknown|Promise<unknown>;
  getManagerPreview?: () => unknown | Promise<unknown>;
  saveBankPolicy?: (request: Record<string, unknown>) => unknown | Promise<unknown>;
  depositBankWallet?: (request: Record<string, unknown>) => unknown | Promise<unknown>;
  unlockBankWallet?: (request: Record<string, unknown>) => unknown | Promise<unknown>;
  getBankWallet?: () => unknown | Promise<unknown>;
  encryptBankWallet?: (request: Record<string, unknown>) => unknown | Promise<unknown>;
  requestBankWithdrawal?: (request: Record<string, unknown>) => unknown | Promise<unknown>;
  getRuntimeSettings?: () => unknown | Promise<unknown>;
  updateRuntimeSettings?: (patch: Record<string, unknown>) => unknown | Promise<unknown>;
  getControlState?: () => unknown | Promise<unknown>;
  applyControlAction?: (request: { action: string; payload: Record<string, unknown> }) => unknown | Promise<unknown>;
  getLatestEligibilitySnapshot?: () => unknown | Promise<unknown>;
  getLatestCandidateContext?: () => unknown | Promise<unknown>;
  getManagerOverlay?: () => unknown | Promise<unknown>;
  saveManagerOverlay?: (overlay: unknown) => unknown | Promise<unknown>;
  getManagerCandidateSet?: () => unknown | Promise<unknown>;
  saveManagerCandidateSet?: (candidateSet: unknown) => unknown | Promise<unknown>;
  buildReplaySvgExport?: (request: ReplaySvgRequest) => unknown | Promise<unknown>;
  getPointsConversionStatus?: () => unknown | Promise<unknown>;
  getConfirmationStatus?: () => unknown | Promise<unknown>;
  saveConfirmationConfig?: (patch: Record<string, unknown>) => unknown | Promise<unknown>;
  savePointsConversionConfig?: (patch: Record<string, unknown>) => unknown | Promise<unknown>;
  redeemPointsForClc?: (request: Record<string, unknown>) => unknown | Promise<unknown>;
};

export type ServerConfig = {
  port?: number;
  dataDir?: string;
  staticDir?: string;
  bridge?: MonitorBridge;
};

async function resolveDefaultMonitorFile(staticDir: string): Promise<string> {
  for (const filename of ["monitor21.html", "monitor20.html", "monitor19f.html", "monitor.html"]) {
    try {
      await readFile(path.join(staticDir, filename));
      return filename;
    } catch {
      // Try the next known monitor build.
    }
  }
  return "monitor.html";
}

async function safeReadText(file: string): Promise<string> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return "";
  }
}

async function readCompleteGameLog(file: string, gameId: string): Promise<any[]> {
  const rows: any[] = [];
  try {
    const lines = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      let row: any;
      try { row = JSON.parse(line); } catch { continue; }
      if (String(row?.gameId ?? "").toLowerCase().replace(/^0x/, "") === gameId) rows.push(row);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return rows;
}

function parseJsonl(text: string): any[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function safeReadJson(file: string | null | undefined): Promise<any | null> {
  if (!file) return null;
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

function cleanHex(value: unknown): string {
  return String(value ?? "").toLowerCase().replace(/^0x/, "");
}

function isWithinRoot(candidate: string, root: string): boolean {
  const resolvedCandidate = path.resolve(candidate);
  const resolvedRoot = path.resolve(root);
  const rel = path.relative(resolvedRoot, resolvedCandidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function resolveReadableLocalJsonPath(
  requestedPath: string | null | undefined,
  dataDir: string,
  staticDir: string,
): string | null {
  const raw = String(requestedPath ?? "").trim();
  if (!raw) return null;
  if (/(?:wallet|signing.key|signed.intent|signed.withdrawal|intent.state|conversion.state|withdrawal.state|settings\.json|manager.llm\.json)/i.test(raw)) return null;
  if (/^[a-z]+:\/\//i.test(raw)) return null;
  const normalizedRaw = raw.replace(/[\\/]+/g, path.sep);
  const allowedRoots = [path.resolve(dataDir), path.resolve(staticDir)];
  const candidates = path.isAbsolute(normalizedRaw)
    ? [path.resolve(normalizedRaw)]
    : [
      path.resolve(dataDir, normalizedRaw),
      path.resolve(staticDir, normalizedRaw),
    ];

  const dataDirName = path.basename(path.resolve(dataDir));
  if (!path.isAbsolute(normalizedRaw)) {
    const lowerRaw = normalizedRaw.toLowerCase();
    const prefix = `${dataDirName.toLowerCase()}${path.sep}`;
    if (lowerRaw.startsWith(prefix)) {
      candidates.push(path.resolve(dataDir, normalizedRaw.slice(prefix.length)));
    }
  }

  const allowedCandidates = [...new Set(candidates)]
    .filter((candidate) => candidate.toLowerCase().endsWith(".json"))
    .filter((candidate) => allowedRoots.some((root) => isWithinRoot(candidate, root)));

  if (!allowedCandidates.length) return null;
  return allowedCandidates.find((candidate) => existsSync(candidate)) ?? allowedCandidates[0];
}

function resultRowCompletenessScore(row: any): number {
  let score = 0;
  if (row?.actual?.throwMatch) score += 4;
  if (row?.actual?.throwMatch?.hole_type != null) score += 8;
  if (row?.actual?.throwMatch?.value_usd_e8 != null) score += 4;
  if (row?.actual?.throwMatch?.matched) score += 2;
  if (Array.isArray(row?.actual?.wholeGame?.per_user_scoreboard)) score += 1;
  if (row?.actual?.expectationVsActual?.actual_hole_type != null) score += 2;
  if (row?.predictionReveal?.localPath) score += 6;
  if (row?.predictionCommit?.localPath) score += 3;
  if (row?.honestScore) score += 5;
  return score;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasMergeValue(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (isPlainRecord(value)) return Object.keys(value).length > 0;
  return true;
}

function mergePreferPrimary(primary: any, fallback: any): any {
  if (Array.isArray(primary) || Array.isArray(fallback)) {
    return hasMergeValue(primary) ? primary : fallback;
  }
  if (isPlainRecord(primary) || isPlainRecord(fallback)) {
    const merged: Record<string, unknown> = {};
    const keys = new Set([
      ...Object.keys(isPlainRecord(primary) ? primary : {}),
      ...Object.keys(isPlainRecord(fallback) ? fallback : {}),
    ]);
    for (const key of keys) {
      merged[key] = mergePreferPrimary(primary?.[key], fallback?.[key]);
    }
    return merged;
  }
  return hasMergeValue(primary) ? primary : fallback;
}

function mergeResultRows(preferred: any, fallback: any): any {
  const merged = mergePreferPrimary(preferred, fallback);
  const preferredTs = new Date(preferred?.ts || 0).getTime();
  const fallbackTs = new Date(fallback?.ts || 0).getTime();
  if (fallbackTs > preferredTs && fallback?.ts) merged.ts = fallback.ts;
  return merged;
}

function buildLatestResultsByDecision(rows: any[]): any[] {
  const map = new Map<string, any>();
  for (const row of rows) {
    const key = String(row?.decisionId || "").trim();
    if (!key) continue;
    const prev = map.get(key);
    if (!prev) {
      map.set(key, row);
      continue;
    }
    const prevScore = resultRowCompletenessScore(prev);
    const nextScore = resultRowCompletenessScore(row);
    const prevTs = new Date(prev?.ts || 0).getTime();
    const nextTs = new Date(row?.ts || 0).getTime();
    const preferNext = nextScore > prevScore || (nextScore === prevScore && nextTs >= prevTs);
    map.set(key, preferNext ? mergeResultRows(row, prev) : mergeResultRows(prev, row));
  }
  return [...map.values()].sort((a, b) => new Date(b?.ts || 0).getTime() - new Date(a?.ts || 0).getTime());
}

function parseLimit(url: URL, fallback = 10, max = 100): number {
  const raw = Number(url.searchParams.get("limit"));
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.max(1, Math.min(max, Math.floor(raw)));
}

function queryFlag(url: URL, key: string): boolean {
  const raw = String(url.searchParams.get(key) ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function summarizeHonestPerformanceRow(row: any): Record<string, unknown> {
  return {
    ts: row?.ts ?? null,
    sessionId: row?.sessionId ?? null,
    decisionId: row?.decisionId ?? null,
    gameId: row?.gameId ?? null,
    botUser: row?.botUser ?? null,
    honestScore: row?.honestScore ?? null,
    predictionCommit: row?.predictionCommit ?? null,
    predictionReveal: row?.predictionReveal ?? null,
  };
}

async function expandHonestPerformanceRow(row: any, includeArtifacts: boolean): Promise<Record<string, unknown>> {
  return {
    ...summarizeHonestPerformanceRow(row),
    actual: row?.actual ?? null,
    expected: row?.expected ?? null,
    commitPayload: includeArtifacts ? await safeReadJson(row?.predictionCommit?.localPath) : undefined,
    revealPayload: includeArtifacts ? await safeReadJson(row?.predictionReveal?.localPath) : undefined,
  };
}

function buildHonestPerformanceSnapshot(rows: any[]): {
  revealRows: any[];
  scoredRows: any[];
  counts: {
    revealRows: number;
    scoredRows: number;
    uniqueGames: number;
  };
  baseline: ReturnType<typeof buildHonestPerformanceBaseline>;
} {
  const revealRows = buildLatestResultsByDecision(rows)
    .filter((row) => row?.predictionReveal?.localPath || row?.honestScore);
  const scoredRows = revealRows.filter((row) => row?.honestScore?.honestScore != null);
  const uniqueGames = new Set(
    revealRows
      .map((row) => cleanHex(row?.gameId || ""))
      .filter(Boolean),
  );
  return {
    revealRows,
    scoredRows,
    counts: {
      revealRows: revealRows.length,
      scoredRows: scoredRows.length,
      uniqueGames: uniqueGames.size,
    },
    baseline: buildHonestPerformanceBaseline(scoredRows),
  };
}

function sendJson(res: http.ServerResponse, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function assertSameOriginJsonMutation(req: http.IncomingMessage): void {
  const remote = String(req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
  if (remote !== "127.0.0.1" && remote !== "::1") {
    throw new Error("signed points controls are loopback-only");
  }
  if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
    throw new Error("points conversion requires application/json");
  }
  const origin = String(req.headers.origin ?? "");
  const host = String(req.headers.host ?? "");
  if (!["127.0.0.1","localhost","[::1]"].includes(new URL("http://"+host).hostname)) throw Error("Wallet controls require a loopback Host");
  const localControlHeader = req.headers["x-collider-local-control"] === "1";
  if (!localControlHeader && (!origin || !host || new URL(origin).host !== host)) {
    throw new Error("points conversion requires a same-origin monitor request");
  }
}

async function sendNotModifiedForUnchangedFile(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  file: string,
  limit: number,
): Promise<boolean> {
  try {
    const info = await stat(file);
    const etag = 'W/"' + info.size + '-' + Math.trunc(info.mtimeMs) + '-' + limit + '"';
    res.setHeader("etag", etag);
    res.setHeader("cache-control", "no-cache");
    if (req.headers["if-none-match"] === etag) {
      res.statusCode = 304;
      res.end();
      return true;
    }
  } catch {
    // Let the normal tail reader return its empty/missing-file view.
  }
  return false;
}

async function readJsonBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  const body = Buffer.concat(chunks).toString("utf8").trim();
  return body ? JSON.parse(body) : {};
}

function safeRuntimeSettings(): Record<string, unknown> | null {
  try {
    return getRuntimeSettings();
  } catch {
    return null;
  }
}

function mergeEffectiveSettings(
  settings: Awaited<ReturnType<typeof loadSettings>>,
  runtime: Record<string, unknown> | null | undefined,
): ReturnType<typeof normalizeSettings> {
  return (runtime && typeof runtime === "object")
    ? normalizeSettings({ ...settings, ...runtime })
    : settings;
}

const BRIDGE_READ_TIMEOUT_MS = 1000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function fromBridge<T>(bridgeCall: (() => T | Promise<T>) | undefined, fallback: () => T | Promise<T>): Promise<T> {
  if (bridgeCall) return await bridgeCall();
  return await fallback();
}

async function fromBridgeWithArg<T, A>(
  bridgeCall: ((arg: A) => T | Promise<T>) | undefined,
  arg: A,
  fallback: (arg: A) => T | Promise<T>,
): Promise<T> {
  if (bridgeCall) return await bridgeCall(arg);
  return await fallback(arg);
}

async function fromBridgeRead<T>(
  bridgeCall: (() => T | Promise<T>) | undefined,
  fallback: () => T | Promise<T>,
  label: string,
  timeoutMs = BRIDGE_READ_TIMEOUT_MS,
): Promise<T> {
  if (!bridgeCall) return await fallback();
  try {
    return await withTimeout(Promise.resolve().then(() => bridgeCall()), timeoutMs, label);
  } catch {
    return await fallback();
  }
}

export async function startMonitorServer(cfg: ServerConfig = {}): Promise<http.Server> {
  const port = cfg.port ?? 8787;
  const dataDir = cfg.dataDir ?? "./data";
  const staticDir = cfg.staticDir ?? process.cwd();
  const bridge = cfg.bridge ?? {};

  await initManagerLlmState(dataDir);
  await initManagerLlmAudit(dataDir);
  const defaultMonitorFile = await resolveDefaultMonitorFile(staticDir);
  const historySummary = new HistorySummaryReader(
    path.join(dataDir, "throws.jsonl"),
    path.join(dataDir, "results.jsonl"),
    path.join(dataDir, "runs.jsonl"),
  );
  let managerLlmRequestInFlight = false;
  let mapPrioritySaveQueue: Promise<unknown> = Promise.resolve();
  let publicProxyInFlight=0;

  const server = http.createServer((req, res) => {
    void (async () => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    if (url.pathname.startsWith("/api/")) {
      try {
        const host=String(req.headers.host??""),parsedHost=new URL("http://"+host);
        if(!["localhost","127.0.0.1","[::1]"].includes(parsedHost.hostname))throw Error("Monitor API requires a loopback host");
        if(["POST","PUT","PATCH","DELETE"].includes(req.method??"")){
          const origin=String(req.headers.origin??""),site=String(req.headers["sec-fetch-site"]??"");
          if((origin&&new URL(origin).host!==host)||(site&&!["same-origin","none"].includes(site)))throw Error("Cross-origin monitor control is not allowed");
        }
      }catch{sendJson(res,400,{ok:false,error:"Monitor API requires trusted local access"});return;}
    }

    if(url.pathname==="/api/public-rpc/read"&&req.method==="POST"){
      try{
        assertSameOriginJsonMutation(req);
        const request=await readJsonBody(req),settings=await loadSettings(dataDir);assertPublicSettings(settings);
        if(typeof request.method!=="string"||!isPublicReadMethod(request.method)||!Array.isArray(request.params)
          ||Object.keys(request).some(k=>!["method","params"].includes(k))||JSON.stringify(request).length>8192)throw Error("bounded public read-only RPC required");
        if(publicProxyInFlight>=2){res.setHeader("retry-after","5");sendJson(res,429,{error:"local public read budget busy"});return;}
        publicProxyInFlight++;
        try{const result=await new JsonRpcClient(PUBLIC_RC1.rpc,{}, {timeoutMs:8000,retries:1}).call(request.method,request.params);sendJson(res,200,{result});}
        finally{publicProxyInFlight--;}
      }catch{sendJson(res,400,{error:"public read held; no signing or arbitrary proxy allowed"});}
      return;
    }

    if (url.pathname === "/api/logs/runs") {
      const file = path.join(dataDir, "runs.jsonl");
      const limit = parseLimit(url, 500, 10_000);
      if (await sendNotModifiedForUnchangedFile(req, res, file, limit)) return;
      const page = await readJsonlTail(file, limit);
      res.setHeader("x-collider-log-file-bytes", String(page.fileBytes));
      res.setHeader("x-collider-log-truncated", String(page.truncated));
      sendJson(res, 200, page.rows);
      return;
    }

    if (url.pathname === "/api/logs/throws") {
      const file = path.join(dataDir, "throws.jsonl");
      const limit = parseLimit(url, 500, 10_000);
      if (await sendNotModifiedForUnchangedFile(req, res, file, limit)) return;
      const page = await readJsonlTail(file, limit);
      res.setHeader("x-collider-log-file-bytes", String(page.fileBytes));
      res.setHeader("x-collider-log-truncated", String(page.truncated));
      sendJson(res, 200, page.rows);
      return;
    }

    if (url.pathname === "/api/logs/results") {
      const file = path.join(dataDir, "results.jsonl");
      const limit = parseLimit(url, 500, 10_000);
      if (await sendNotModifiedForUnchangedFile(req, res, file, limit)) return;
      const page = await readJsonlTail(file, limit);
      res.setHeader("x-collider-log-file-bytes", String(page.fileBytes));
      res.setHeader("x-collider-log-truncated", String(page.truncated));
      sendJson(res, 200, page.rows);
      return;
    }

    if(url.pathname==="/api/publisher/config"&&req.method==="POST"){try{assertSameOriginJsonMutation(req);const b=await readJsonBody(req);if(Object.keys(b).join()!=="enabled"||typeof b.enabled!=="boolean")throw Error("Only the enabled flag may change");sendJson(res,200,{ok:true,status:await setExplorerPublishing(dataDir,b.enabled)});}catch(e){sendJson(res,400,{ok:false,error:e instanceof Error?e.message:"Publisher configuration held"});}return;}
    if(url.pathname==="/api/publisher/export-existing"&&req.method==="POST"){try{assertSameOriginJsonMutation(req);const b=await readJsonBody(req);if(Object.keys(b).join()!=="limit")throw Error("Only a bounded limit may be provided");sendJson(res,200,{ok:true,...await queueExistingReveals(dataDir,b.limit)});}catch(e){sendJson(res,400,{ok:false,error:e instanceof Error?e.message:"Export held"});}return;}
    if (url.pathname === "/api/publisher/status" && req.method === "GET") {
      try { sendJson(res,200,await publisherStatus(dataDir)); }
      catch { sendJson(res,503,{enabled:false,error:"publisher state unreadable; no uploads attempted"}); }
      return;
    }

    if (url.pathname === "/api/history/summary" && req.method === "GET") {
      sendJson(res, 200, await historySummary.read());
      return;
    }

    if (url.pathname === "/api/history/game" && req.method === "GET") {
      const gameId = String(url.searchParams.get("gameId") ?? "").toLowerCase().replace(/^0x/, "");
      if (!/^[0-9a-f]{64}$/.test(gameId)) {
        sendJson(res, 400, { error: "invalid gameId" });
        return;
      }
      const [runs, throws, results] = await Promise.all([
        readCompleteGameLog(path.join(dataDir, "runs.jsonl"), gameId),
        readCompleteGameLog(path.join(dataDir, "throws.jsonl"), gameId),
        readCompleteGameLog(path.join(dataDir, "results.jsonl"), gameId),
      ]);
      sendJson(res, 200, { gameId, runs, throws, results });
      return;
    }

    if (url.pathname === "/api/points/status" && req.method === "GET") {
      if (!bridge.getPointsConversionStatus) sendJson(res, 503, { available: false, error: "points conversion runtime unavailable" });
      else sendJson(res, 200, await bridge.getPointsConversionStatus());
      return;
    }

    if (url.pathname === "/api/confirmations/status" && req.method === "GET") {
      if (!bridge.getConfirmationStatus) sendJson(res, 503, { available: false, enabled: false, error: "reviewed confirmation runtime unavailable" });
      else sendJson(res, 200, await bridge.getConfirmationStatus());
      return;
    }
    if (url.pathname === "/api/confirmations/config" && req.method === "POST") {
      try {
        assertSameOriginJsonMutation(req);
        const body = await readJsonBody(req);
        if (!isPlainRecord(body) || Object.keys(body).join() !== "enabled" || typeof body.enabled !== "boolean") {
          throw new Error("only a boolean confirmation enabled flag may be changed");
        }
        if (!bridge.saveConfirmationConfig) throw new Error("reviewed confirmation runtime unavailable");
        sendJson(res, 200, { ok: true, config: await bridge.saveConfirmationConfig({ enabled: body.enabled }) });
      } catch (error) { sendJson(res, 400, { ok: false, error: String(error) }); }
      return;
    }

    if(url.pathname==="/api/doctrines"&&req.method==="GET"){sendJson(res,200,{version:DOCTRINE_KNOWLEDGE_VERSION,cards:Object.keys(DOCTRINE_SEEDS).map(id=>({...doctrineKnowledge(id),defaultGoalWeights:DOCTRINE_PACK_PRESETS[id as keyof typeof DOCTRINE_PACK_PRESETS].goalWeights})),lessons:DOCTRINE_KNOWLEDGE});return;}
    if (url.pathname === "/api/manager/preview" && req.method === "POST") {
      try {assertSameOriginJsonMutation(req); if (!bridge.getManagerPreview) throw Error("Fresh planner is unavailable"); sendJson(res,200,{ok:true,context:await bridge.getManagerPreview()});}
      catch {sendJson(res,503,{ok:false,error:"Fresh planning preview unavailable"});} return;
    }
    if(url.pathname==="/api/wallet/name"&&["GET","POST"].includes(req.method??"")){try{if(req.method==="POST"){assertSameOriginJsonMutation(req);if(!bridge.setAgentName)throw Error("Name service unavailable");sendJson(res,200,await bridge.setAgentName(await readJsonBody(req)));}else{if(!bridge.getAgentName)throw Error("Name service unavailable");sendJson(res,200,await bridge.getAgentName());}}catch(e){sendJson(res,400,{ok:false,error:e instanceof Error?e.message:"Name request failed"});}return;}
    if (url.pathname === "/api/bank/wallet" && req.method === "GET") {
      try { if (!bridge.getBankWallet) throw Error("Bank wallet service is not loaded in this running monitor; reload Agent1"); sendJson(res, 200, await bridge.getBankWallet()); }
      catch { sendJson(res, 503, {ok:false,error:"Bank wallet service unavailable; reload the updated Agent1 runtime"}); } return;
    }
    if (["/api/bank/encrypt", "/api/bank/withdraw", "/api/bank/unlock", "/api/bank/deposit", "/api/bank/policy"].includes(url.pathname) && req.method === "POST") {
      try {
        assertSameOriginJsonMutation(req);
        const body = await readJsonBody(req);
        const action = url.pathname.endsWith("policy") ? bridge.saveBankPolicy : url.pathname.endsWith("deposit") ? bridge.depositBankWallet : url.pathname.endsWith("encrypt") ? bridge.encryptBankWallet : url.pathname.endsWith("unlock") ? bridge.unlockBankWallet : bridge.requestBankWithdrawal;
        if (!action) throw Error("Bank wallet service is not loaded");
        sendJson(res, 200, await action(body));
      } catch (error) { sendJson(res, 400, {ok:false,error:error instanceof Error ? error.message : "Wallet request failed"}); } return;
    }

    if (url.pathname === "/api/bank/balances" && req.method === "GET") {
      try {
        const settings = await loadSettings(dataDir);
        const runtime = await fromBridgeRead(bridge.getRuntimeSettings, () => safeRuntimeSettings(), "bank RPC settings");
        const effective = mergeEffectiveSettings(settings, (runtime && typeof runtime === "object") ? runtime as Record<string, unknown> : null);
        const cleanUser = String(effective.user ?? "").trim().toLowerCase().replace(/^0x/, "");
        if (!/^[0-9a-f]{64}$/.test(cleanUser)) throw new Error("RC1 wallet UserId is not configured");
        const user = `0x${cleanUser}`;
        const balances = await new ColliderClient(effective.rpc).getBalances(user);
        sendJson(res, 200, { user, balances, asOf: new Date().toISOString() });
      } catch (error) {
        sendJson(res, 503, { ok: false, error: String(error) });
      }
      return;
    }

    if ((url.pathname === "/api/points/ledger" || url.pathname === "/api/points/quote") && req.method === "GET") {
      try {
        const settings = await loadSettings(dataDir);
        const runtime = await fromBridgeRead(bridge.getRuntimeSettings, () => safeRuntimeSettings(), "points RPC settings");
        const effective = mergeEffectiveSettings(settings, (runtime && typeof runtime === "object") ? runtime as Record<string, unknown> : null);
        const cleanUser = String(effective.user ?? "").trim().toLowerCase().replace(/^0x/, "");
        if (!/^[0-9a-f]{64}$/.test(cleanUser)) throw new Error("RC1 wallet UserId is not configured");
        const user = `0x${cleanUser}`;
        const client = new ColliderClient(effective.rpc);
        if (url.pathname === "/api/points/quote") {
          const pointsIn = String(url.searchParams.get("pointsIn") ?? "").trim();
          if (!/^\d{1,39}$/.test(pointsIn) || BigInt(pointsIn) < 1n) {
            sendJson(res, 400, { ok: false, error: "pointsIn must be a positive exact integer" });
            return;
          }
          sendJson(res, 200, await client.getClcRedemptionQuote(user, BigInt(pointsIn).toString()));
          return;
        }
        const [ladder, balances] = await Promise.all([client.getLadderUser(user), client.getBalances(user)]);
        const points = String(ladder?.points_total ?? "0");
        const fullQuote = BigInt(points) > 0n ? await client.getClcRedemptionQuote(user, points) : null;
        sendJson(res, 200, { user, points, throwCount: String(ladder?.throw_count ?? "0"),
          clcBase: String(balances[CLC_ASSET] ?? "0"), fullQuote });
      } catch (error) {
        sendJson(res, 503, { ok: false, error: String(error) });
      }
      return;
    }

    if (url.pathname === "/api/points/config" && req.method === "POST") {
      try {
        assertSameOriginJsonMutation(req);
        if (!bridge.savePointsConversionConfig) throw new Error("points conversion runtime unavailable");
        const config = await bridge.savePointsConversionConfig(await readJsonBody(req));
        sendJson(res, 200, { ok: true, config });
      } catch (error) {
        sendJson(res, 400, { ok: false, error: String(error) });
      }
      return;
    }

    if (url.pathname === "/api/points/redeem" && req.method === "POST") {
      try {
        assertSameOriginJsonMutation(req);
        if (!bridge.redeemPointsForClc) throw new Error("points conversion runtime unavailable");
        sendJson(res, 200, await bridge.redeemPointsForClc(await readJsonBody(req)));
      } catch (error) {
        sendJson(res, 400, { ok: false, error: String(error) });
      }
      return;
    }

    if (url.pathname === "/api/local-json" && req.method === "GET") {
      const requestedPath = url.searchParams.get("path");
      const filePath = resolveReadableLocalJsonPath(requestedPath, dataDir, staticDir);
      if (!filePath) {
        sendJson(res, 400, { ok: false, error: "invalid local json path" });
        return;
      }
      const text = await safeReadText(filePath);
      if (!text) {
        sendJson(res, 404, { ok: false, error: "local json file not found" });
        return;
      }
      res.statusCode = 200;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(text);
      return;
    }

    if (url.pathname === "/api/assets-meta" && req.method === "GET") {
      try {
        const settings = await loadSettings(dataDir);
        const runtime = await fromBridgeRead(
          bridge.getRuntimeSettings,
          () => safeRuntimeSettings(),
          "assets meta runtime settings",
        );
        const effective = mergeEffectiveSettings(settings, (runtime && typeof runtime === "object") ? runtime as Record<string, unknown> : null);
        const client = new ColliderClient(effective.rpc);
        sendJson(res, 200, { assets: normalizeAssetsMetaPayload(await client.getAssetsMeta()) });
      } catch (err) {
        sendJson(res, 500, { ok: false, error: String(err) });
      }
      return;
    }

    if (url.pathname === "/api/settings" && req.method === "GET") {
      const settings = await loadSettings(dataDir);
      const runtime = await fromBridgeRead(
        bridge.getRuntimeSettings,
        () => null,
        "settings runtime settings",
      );
      sendJson(
        res,
        200,
        mergeEffectiveSettings(settings, (runtime && typeof runtime === "object") ? runtime as Record<string, unknown> : null),
      );
      return;
    }

    if (url.pathname === "/api/settings" && req.method === "POST") {
      try {
        const json = await readJsonBody(req);
        const saved = await saveSettingsAndRuntime(json, dataDir, bridge);
        sendJson(res, 200, {
          ok: true,
          settings: saved.settings,
          runtime: saved.runtime,
          runtimeSyncPending: saved.runtimeSyncPending,
          runtimeSyncError: saved.runtimeSyncError,
        });
      } catch (err) {
        sendJson(res, 400, { ok: false, error: String(err) });
      }
      return;
    }

    if (url.pathname === "/api/settings/map-priority" && req.method === "POST") {
      try {
        assertSameOriginJsonMutation(req);
        const json = await readJsonBody(req);
        const id = canonicalMapId(json?.mapId), priority = json?.priority;
        if (!id || typeof priority !== "number" || !Number.isInteger(priority) || priority < 1 || priority > 10
          || Object.keys(json).some(key => !["mapId", "priority"].includes(key))) throw Error("mapId and integer priority 1–10 required");
        const save = mapPrioritySaveQueue.then(async () => {
          const current = await loadSettings(dataDir);
          return await saveSettingsAndRuntime({ mapPriorities: { ...current.mapPriorities, [id]: priority } }, dataDir, bridge);
        });
        mapPrioritySaveQueue = save.catch(() => undefined);
        const saved = await save;
        sendJson(res, 200, { ok:true, mapId:id, priority, settings:saved.settings,
          runtimeSyncPending:saved.runtimeSyncPending, runtimeSyncError:saved.runtimeSyncError });
      } catch (err) {
        sendJson(res, 400, { ok:false, error:String(err) });
      }
      return;
    }

    if (url.pathname === "/api/settings/onboarding" && req.method === "POST") {
      try {
        const json = await readJsonBody(req);
        const current = await loadSettings(dataDir);
        const nextOnboarding = normalizeSettings({
          ...current,
          onboarding: {
            ...(current.onboarding ?? {}),
            ...((json?.onboarding && typeof json.onboarding === "object") ? json.onboarding : {}),
          },
        });
        await saveSettings(nextOnboarding, dataDir);
        sendJson(res, 200, {
          ok: true,
          settings: nextOnboarding,
        });
      } catch (err) {
        sendJson(res, 400, { ok: false, error: String(err) });
      }
      return;
    }

    if (url.pathname === "/api/runtime-settings" && req.method === "GET") {
      const source = bridge.getRuntimeSettings ? "bridge" : "local";
      try {
        // A worker's local settings cannot establish the main signer runtime's state.
        const runtime = bridge.getRuntimeSettings
          ? await withTimeout(Promise.resolve().then(() => bridge.getRuntimeSettings!()), BRIDGE_READ_TIMEOUT_MS, "runtime settings")
          : getRuntimeSettings();
        if (!runtime) throw new Error("runtime settings not initialized");
        sendJson(res, 200, runtime);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const uninitialized = /^(?:Error:\s*)?runtime settings not initialized$/.test(message);
        const timedOut = /^runtime settings timed out after \d+ms$/.test(message)
          || /^monitor bridge timeout for getRuntimeSettings after \d+ms$/.test(message);
        const code = uninitialized ? "RUNTIME_SETTINGS_UNINITIALIZED"
          : timedOut ? "RUNTIME_SETTINGS_BRIDGE_TIMEOUT" : "RUNTIME_SETTINGS_READ_FAILED";
        console.warn("[monitor-runtime-settings-read]", {
          ts: new Date().toISOString(), code, source,
          timeoutMs: source === "bridge" ? BRIDGE_READ_TIMEOUT_MS : null,
        });
        sendJson(res, 503, {
          ok: false, code, source,
          error: uninitialized ? "runtime settings not initialized"
            : timedOut ? "runtime settings bridge read timed out" : "runtime settings read unavailable",
        });
      }
      return;
    }

    if (url.pathname === "/api/control/status" && req.method === "GET") {
      sendJson(
        res,
        200,
        await fromBridgeRead(
          bridge.getControlState,
          () => getControlState(),
          "control state",
        ),
      );
      return;
    }

    if (url.pathname === "/api/control/action" && req.method === "POST") {
      try {
        const json = await readJsonBody(req);
        const action = String(json.action || "").trim();
        if (!action) throw new Error("missing action");
        const state = await fromBridgeWithArg(
          bridge.applyControlAction,
          { action, payload: json },
          ({ action: nextAction, payload }) => applyControlAction(nextAction, payload),
        );
        const statePayload = state && typeof state === "object" ? state as Record<string, unknown> : { state };
        sendJson(res, 200, { ok: true, ...statePayload });
      } catch (err) {
        sendJson(res, 400, { ok: false, error: String(err) });
      }
      return;
    }

    if (url.pathname === "/api/manager/target-game" && req.method === "POST") {
      try {
        const json = await readJsonBody(req);
        const gameId = cleanHex(json?.gameId || "");
        const clear = !!json?.clear || !gameId;
        const state = await fromBridgeWithArg(
          bridge.applyControlAction,
          { action: clear ? "clear_target_game" : "target_game", payload: clear ? {} : { gameId } },
          ({ action: nextAction, payload }) => applyControlAction(nextAction, payload),
        );
        sendJson(res, 200, { ok: true, control: state, targetGameId: clear ? null : gameId });
      } catch (err) {
        sendJson(res, 400, { ok: false, error: String(err) });
      }
      return;
    }

    if (url.pathname === "/api/manager/state" && req.method === "GET") {
      sendJson(res, 200, await buildManagerStatePayload(dataDir, bridge));
      return;
    }

    if (url.pathname === "/api/manager/settings-audit" && req.method === "GET") {
      const settings = await loadSettings(dataDir);
      sendJson(res, 200, {
        settings,
        audit: buildSettingsAuditReport(settings),
      });
      return;
    }

    if (url.pathname === "/api/manager/eligibility" && req.method === "GET") {
      const managerStatePayload = await buildManagerStatePayload(dataDir, bridge);
      const latestEligibility = managerStatePayload.latestEligibility ?? null;
      sendJson(res, 200, {
        snapshot: latestEligibility,
        eligibilityCode: String(managerStatePayload.eligibilityCode || ""),
      });
      return;
    }

    if (url.pathname === "/api/manager/candidates" && req.method === "GET") {
      sendJson(res, 200, {
        latest: (await buildManagerStatePayload(dataDir, bridge)).latestCandidates ?? null,
      });
      return;
    }

    if (url.pathname === "/api/manager/honest-score" && req.method === "GET") {
      const limit = parseLimit(url, 12, 100);
      const includeArtifacts = queryFlag(url, "includeArtifacts");
      const resultsPage = await readJsonlTail(path.join(dataDir, "results.jsonl"), 10_000);
      const honestPerformance = buildHonestPerformanceSnapshot(resultsPage.rows);
      const recentRows = honestPerformance.revealRows.slice(0, limit);
      const settings = await loadSettings(dataDir);
      const runtime = await fromBridgeRead(
        bridge.getRuntimeSettings,
        () => safeRuntimeSettings(),
        "honest-score runtime settings",
      );
      sendJson(res, 200, {
        counts: honestPerformance.counts,
        baseline: honestPerformance.baseline,
        profile: resolveAgentProfile((runtime && typeof runtime === "object") ? runtime as Record<string, unknown> : settings),
        latest: honestPerformance.revealRows[0] ? await expandHonestPerformanceRow(honestPerformance.revealRows[0], includeArtifacts) : null,
        latestScored: honestPerformance.scoredRows[0] ? await expandHonestPerformanceRow(honestPerformance.scoredRows[0], includeArtifacts) : null,
        recent: await Promise.all(recentRows.map((row) => expandHonestPerformanceRow(row, includeArtifacts))),
        dataWindow: {
          retainedRowsScanned: resultsPage.rows.length,
          activeFileBytes: resultsPage.fileBytes,
          truncated: resultsPage.truncated,
        },
      });
      return;
    }

    if (url.pathname === "/api/manager/reveals" && req.method === "GET") {
      const limit = parseLimit(url, 10, 100);
      const includeArtifacts = queryFlag(url, "includeArtifacts");
      const gameId = cleanHex(url.searchParams.get("gameId") || "");
      const decisionId = cleanHex(url.searchParams.get("decisionId") || "");
      const resultsPage = await readJsonlTail(path.join(dataDir, "results.jsonl"), 10_000);
      const honestPerformance = buildHonestPerformanceSnapshot(resultsPage.rows);
      const filtered = honestPerformance.revealRows.filter((row) => {
        if (gameId && cleanHex(row?.gameId || "") !== gameId) return false;
        if (decisionId && cleanHex(row?.decisionId || "") !== decisionId) return false;
        return true;
      });
      const selected = filtered.slice(0, limit);
      sendJson(res, 200, {
        count: filtered.length,
        returned: selected.length,
        rows: await Promise.all(selected.map((row) => expandHonestPerformanceRow(row, includeArtifacts))),
        dataWindow: {
          retainedRowsScanned: resultsPage.rows.length,
          activeFileBytes: resultsPage.fileBytes,
          truncated: resultsPage.truncated,
        },
      });
      return;
    }

    if (url.pathname === "/api/manager/overlay" && req.method === "GET") {
      sendJson(res, 200, {
        overlay: await fromBridge(bridge.getManagerOverlay, () => getManagerOverlay()),
      });
      return;
    }

    if (url.pathname === "/api/manager/overlay" && req.method === "POST") {
      try {
        const json = await readJsonBody(req);
        const normalized = normalizeManagerTacticalOverlay(json);
        const overlay = await fromBridgeWithArg(
          bridge.saveManagerOverlay,
          normalized,
          (payload) => saveManagerOverlay(payload as any),
        );
        sendJson(res, 200, { ok: true, overlay });
      } catch (err) {
        sendJson(res, 400, { ok: false, error: String(err) });
      }
      return;
    }

    if (url.pathname === "/api/manager/overlay" && req.method === "DELETE") {
      const overlay = await fromBridgeWithArg(
        bridge.saveManagerOverlay,
        null,
        () => saveManagerOverlay(null),
      );
      sendJson(res, 200, { ok: true, overlay });
      return;
    }

    if (url.pathname === "/api/manager/candidate-set" && req.method === "GET") {
      sendJson(res, 200, {
        managerCandidateSet: await fromBridge(bridge.getManagerCandidateSet, () => getManagerCandidateSet()),
      });
      return;
    }

    if (url.pathname === "/api/manager/candidate-set" && req.method === "POST") {
      try {
        const json = await readJsonBody(req);
        const normalized = normalizeManagerCandidateSet(json);
        const managerCandidateSet = await fromBridgeWithArg(
          bridge.saveManagerCandidateSet,
          normalized,
          (payload) => saveManagerCandidateSet(payload as any),
        );
        sendJson(res, 200, { ok: true, managerCandidateSet });
      } catch (err) {
        sendJson(res, 400, { ok: false, error: String(err) });
      }
      return;
    }

    if (url.pathname === "/api/manager/candidate-set" && req.method === "DELETE") {
      const managerCandidateSet = await fromBridgeWithArg(
        bridge.saveManagerCandidateSet,
        null,
        () => saveManagerCandidateSet(null),
      );
      sendJson(res, 200, { ok: true, managerCandidateSet });
      return;
    }

    if(url.pathname==="/api/manager/research"&&req.method==="GET"){try{sendJson(res,200,await researchSnapshot(dataDir));}catch{sendJson(res,503,{available:false,error:"Research evidence unavailable; not zero activity"});}return;}

    if (url.pathname === "/api/manager/experiment/decision" && req.method === "POST") {
      try {
        assertSameOriginJsonMutation(req);const body=await readJsonBody(req);
        const experiment=await safeReadJson(path.join(dataDir,"manager-experiment.json"));
        const maxRounds=experiment?.maxInferenceRounds??96;
        if(!Number.isInteger(maxRounds)||maxRounds<1||maxRounds>240||!experiment?.active||Date.parse(experiment.stopAt)<=Date.now()||body.model!==experiment.model||typeof body.reply!=="string"||body.reply.length>4000||!Number.isInteger(body.round)||body.round<0||body.round>=maxRounds)throw Error("Invalid controlled manager decision");
        await appendManagerLlmMessage("assistant",body.reply);
        await setManagerLlmResponseMeta("codex", String(body.summary??"Bounded experiment decision"));
        await appendManagerLlmAuditEntry({actionId:String(body.policyId??""),event:"applied",title:"Controlled doctrine decision",note:body.reply,action:null,snapshot:null,result:{round:body.round,activity:body.activity,model:body.model}});
        sendJson(res,200,{ok:true});
      }catch{sendJson(res,400,{ok:false,error:"Controlled manager decision rejected"});}return;
    }
    if (url.pathname === "/api/manager/llm" && req.method === "GET") {
      const experiment = await safeReadJson(path.join(dataDir,"manager-experiment.json"));
      sendJson(res, 200, { state: {...getPublicManagerLlmState(), experiment: experiment?.active && Date.parse(experiment.stopAt)>Date.now() ? experiment : null} });
      return;
    }

    if (url.pathname === "/api/manager/llm/audit" && req.method === "GET") {
      const limit = parseLimit(url, 20, 100);
      sendJson(res, 200, { rows: await readManagerLlmAuditEntries(limit) });
      return;
    }

    if (url.pathname === "/api/manager/llm/config" && req.method === "POST") {
      try {
        const json = await readJsonBody(req);
        sendJson(res, 200, { ok: true, state: await saveManagerLlmConfig(json) });
      } catch (err) {
        sendJson(res, 400, { ok: false, error: String(err), state: getPublicManagerLlmState() });
      }
      return;
    }

    if (url.pathname === "/api/manager/llm/autodetect" && req.method === "POST") {
      try {
        const json = await readJsonBody(req).catch(() => ({}));
        const preferRaw = String(json?.prefer || "any").trim().toLowerCase();
        const prefer = preferRaw === "ollama" || preferRaw === "local" ? preferRaw : "any";
        const detection = await autoDetectLocalManagerProvider(prefer);
        if (!detection.selected) {
          sendJson(res, 404, {
            ok: false,
            error: "No supported local manager runtime was detected. Start Ollama or a local OpenAI-compatible server first.",
            candidates: detection.candidates,
            state: getPublicManagerLlmState(),
          });
          return;
        }
        const state = await saveManagerLlmConfig({
          activeProvider: detection.selected.providerId,
          providers: {
            [detection.selected.providerId]: {
              enabled: true,
              model: detection.selected.model,
              endpointUrl: detection.selected.endpointUrl,
            },
          },
        });
        await setManagerLlmError(null);
        sendJson(res, 200, {
          ok: true,
          detected: detection.selected,
          candidates: detection.candidates,
          state,
        });
      } catch (err) {
        sendJson(res, 400, { ok: false, error: String(err), state: getPublicManagerLlmState() });
      }
      return;
    }

    if (url.pathname === "/api/manager/llm/local-setup" && req.method === "POST") {
      sendJson(res, 410, { ok:false, error:"Automatic runtime installation is no longer supported. Connect a provider or detect an existing Ollama instance." });
      return;
    }

    if (url.pathname === "/api/manager/llm/reset" && req.method === "POST") {
      sendJson(res, 200, { ok: true, state: await resetManagerLlmSession() });
      return;
    }

    if (url.pathname === "/api/manager/llm/chat" && req.method === "POST") {
      if (managerLlmRequestInFlight) {
        sendJson(res, 409, { ok: false, error: "A manager request is already in progress.", state: getPublicManagerLlmState() });
        return;
      }
      managerLlmRequestInFlight = true;
      try {
        const json = await readJsonBody(req);
        const message = String(json?.message || "").trim();
        const experiment = await safeReadJson(path.join(dataDir,"manager-experiment.json"));
        if(experiment?.active && Date.parse(experiment.stopAt)>Date.now() && message.startsWith("SYSTEM EVENT NOTICE")) throw Error("Scheduled experiment manager handles runtime events; duplicate automatic inference is disabled");
        if (!message) throw new Error("missing message");
        await appendManagerLlmMessage("user", message);
        await setManagerLlmBusy(true);
        await setManagerLlmError(null);
        const llmState = getManagerLlmState();
        const managerStatePayload = await buildManagerStatePayload(dataDir, bridge);
        const conversation = await runManagerConversation({
          provider: llmState.config.activeProvider,
          config: llmState.config,
          history: llmState.history,
          snapshot: toManagerLlmSnapshot(managerStatePayload),
        });
        await appendManagerLlmMessage("assistant", conversation.reply);
        await addManagerLlmPendingActions(conversation.actions);
        for (const action of conversation.actions) {
          await appendManagerLlmAuditEntry({
            actionId: action.id,
            event: "proposed",
            title: action.title,
            note: conversation.summary,
            action,
            snapshot: null,
            result: null,
          });
        }
        await setManagerLlmResponseMeta(llmState.config.activeProvider, conversation.summary);
        await setManagerLlmBusy(false);
        managerLlmRequestInFlight = false;
        sendJson(res, 200, {
          ok: true,
          assistantMessage: conversation.reply,
          summary: conversation.summary,
          actions: conversation.actions,
          state: getPublicManagerLlmState(),
        });
      } catch (err) {
        managerLlmRequestInFlight = false;
        await setManagerLlmBusy(false);
        await setManagerLlmError(String(err));
        sendJson(res, 400, { ok: false, error: String(err), state: getPublicManagerLlmState() });
      }
      return;
    }

    if (url.pathname === "/api/manager/llm/reject" && req.method === "POST") {
      try {
        const json = await readJsonBody(req);
        const actionId = String(json?.actionId || "").trim();
        const note = String(json?.note || "").trim();
        if (!actionId) throw new Error("missing actionId");
        const action = getManagerLlmState().pendingActions.find((entry) => entry.id === actionId);
        if (!action) throw new Error(`unknown actionId: ${actionId}`);
        await updateManagerLlmAction(action.id, {
          rejectedAt: new Date().toISOString(),
          rejection: note || "Rejected by operator.",
          failedAt: null,
          failure: null,
        });
        await appendManagerLlmAuditEntry({
          actionId: action.id,
          event: "rejected",
          title: action.title,
          note: note || "Rejected by operator.",
          action: { ...action, rejectedAt: new Date().toISOString(), rejection: note || "Rejected by operator." },
          snapshot: null,
          result: null,
        });
        await setManagerLlmError(null);
        sendJson(res, 200, { ok: true, state: getPublicManagerLlmState() });
      } catch (err) {
        await setManagerLlmError(String(err));
        sendJson(res, 400, { ok: false, error: String(err), state: getPublicManagerLlmState() });
      }
      return;
    }

    if (url.pathname === "/api/manager/llm/hide" && req.method === "POST") {
      try {
        const json = await readJsonBody(req);
        const actionId = String(json?.actionId || "").trim();
        if (!actionId) throw new Error("missing actionId");
        const action = getManagerLlmState().pendingActions.find((entry) => entry.id === actionId);
        if (!action) throw new Error(`unknown actionId: ${actionId}`);
        const hiddenAt = new Date().toISOString();
        await updateManagerLlmAction(action.id, { hiddenAt });
        await appendManagerLlmAuditEntry({
          actionId: action.id,
          event: "hidden",
          title: action.title,
          note: "Hidden from the live proposal queue.",
          action: { ...action, hiddenAt },
          snapshot: null,
          result: null,
        });
        sendJson(res, 200, { ok: true, state: getPublicManagerLlmState() });
      } catch (err) {
        await setManagerLlmError(String(err));
        sendJson(res, 400, { ok: false, error: String(err), state: getPublicManagerLlmState() });
      }
      return;
    }

    if (url.pathname === "/api/manager/llm/guide" && req.method === "POST") {
      if (managerLlmRequestInFlight) {
        sendJson(res, 409, { ok: false, error: "A manager request is already in progress.", state: getPublicManagerLlmState() });
        return;
      }
      managerLlmRequestInFlight = true;
      try {
        const json = await readJsonBody(req);
        const actionId = String(json?.actionId || "").trim();
        const guidance = String(json?.message || "").trim();
        if (!actionId) throw new Error("missing actionId");
        if (!guidance) throw new Error("missing guidance message");
        const action = getManagerLlmState().pendingActions.find((entry) => entry.id === actionId);
        if (!action) throw new Error(`unknown actionId: ${actionId}`);
        const prompt = [
          `GUIDANCE FOR PROPOSAL ${action.title}`,
          `Action kind: ${action.kind}`,
          `Proposal why: ${action.why || "No reason supplied."}`,
          "Operator guidance:",
          guidance,
          "Acknowledge the guidance, revise course if needed, and stay within the deterministic Agent 1 rails.",
        ].join("\n");
        await appendManagerLlmMessage("user", prompt);
        await setManagerLlmBusy(true);
        await setManagerLlmError(null);
        const guidedAt = new Date().toISOString();
        await updateManagerLlmAction(action.id, { guidedAt, guideMessage: guidance });
        const llmState = getManagerLlmState();
        const managerStatePayload = await buildManagerStatePayload(dataDir, bridge);
        const conversation = await runManagerConversation({
          provider: llmState.config.activeProvider,
          config: llmState.config,
          history: llmState.history,
          snapshot: toManagerLlmSnapshot(managerStatePayload),
        });
        await appendManagerLlmMessage("assistant", conversation.reply);
        await addManagerLlmPendingActions(conversation.actions);
        for (const nextAction of conversation.actions) {
          await appendManagerLlmAuditEntry({
            actionId: nextAction.id,
            event: "proposed",
            title: nextAction.title,
            note: conversation.summary,
            action: nextAction,
            snapshot: null,
            result: null,
          });
        }
        await appendManagerLlmAuditEntry({
          actionId: action.id,
          event: "guided",
          title: action.title,
          note: guidance,
          action: { ...action, guidedAt, guideMessage: guidance },
          snapshot: null,
          result: { assistantReply: conversation.reply, summary: conversation.summary, addedActions: conversation.actions.map((entry) => entry.id) },
        });
        await setManagerLlmResponseMeta(llmState.config.activeProvider, conversation.summary);
        await setManagerLlmBusy(false);
        managerLlmRequestInFlight = false;
        sendJson(res, 200, {
          ok: true,
          assistantMessage: conversation.reply,
          summary: conversation.summary,
          actions: conversation.actions,
          state: getPublicManagerLlmState(),
        });
      } catch (err) {
        managerLlmRequestInFlight = false;
        await setManagerLlmBusy(false);
        await setManagerLlmError(String(err));
        sendJson(res, 400, { ok: false, error: String(err), state: getPublicManagerLlmState() });
      }
      return;
    }

    if (url.pathname === "/api/manager/llm/apply" && req.method === "POST") {
      let actionId = "";
      try {
        const json = await readJsonBody(req);
        actionId = String(json?.actionId || "").trim();
        if (!actionId) throw new Error("missing actionId");
        const action = getManagerLlmState().pendingActions.find((entry) => entry.id === actionId);
        if (!action) throw new Error(`unknown actionId: ${actionId}`);
        const snapshot = await captureManagerLlmActionSnapshot(dataDir, bridge);
        const applied = await applyManagerLlmAction(action, dataDir, bridge);
        const appliedAt = new Date().toISOString();
        await updateManagerLlmAction(action.id, {
          hiddenAt: null,
          appliedAt: new Date().toISOString(),
          rejectedAt: null,
          rejection: null,
          failedAt: null,
          failure: null,
        });
        await appendManagerLlmAuditEntry({
          actionId: action.id,
          event: "applied",
          title: action.title,
          note: action.why,
          action: { ...action, appliedAt },
          snapshot,
          result: applied,
        });
        await setManagerLlmError(null);
        sendJson(res, 200, {
          ok: true,
          applied,
          state: getPublicManagerLlmState(),
          managerState: await buildManagerStatePayload(dataDir, bridge),
        });
      } catch (err) {
        if (actionId) {
          const failedAction = getManagerLlmState().pendingActions.find((entry) => entry.id === actionId) || null;
          await updateManagerLlmAction(actionId, {
            failedAt: new Date().toISOString(),
            failure: String(err),
          });
          await appendManagerLlmAuditEntry({
            actionId,
            event: "apply_failed",
            title: failedAction?.title || "Manager action",
            note: String(err),
            action: failedAction,
            snapshot: null,
            result: null,
          });
        }
        await setManagerLlmError(String(err));
        sendJson(res, 400, { ok: false, error: String(err), state: getPublicManagerLlmState() });
      }
      return;
    }

    if (url.pathname === "/api/manager/replay-svg" && req.method === "POST") {
      try {
        const json = await readJsonBody(req);
        const replayRequest = normalizeReplaySvgRequest(json);
        if (!bridge.buildReplaySvgExport) {
          sendJson(res, 501, { ok: false, error: "replay svg export requires the live runtime bridge" });
          return;
        }
        const replay = await fromBridgeWithArg(
          bridge.buildReplaySvgExport,
          replayRequest,
          async () => {
            throw new Error("replay svg export requires the live runtime bridge");
          },
        );
        sendJson(res, 200, { ok: true, replay });
      } catch (err) {
        sendJson(res, 400, { ok: false, error: String(err) });
      }
      return;
    }

    const publicExperimentArtifact = /^\/data-doctrine-[a-zA-Z0-9-]+\/(?:audit\.(?:json|txt)|live\.json|fresh-live\.json|completion\.json)$/.test(url.pathname);
    if (!publicExperimentArtifact && (/(?:^|\/)(?:data(?:-[^/]+)?|\.git|\.aws|\.codex|\.agents)(?:\/|$)/i.test(url.pathname) || /(?:wallet|signing-key|signed-intent|signed-withdrawal|intent-state|conversion-state|withdrawal-state|bank-withdrawals|settings)/i.test(url.pathname) && /\.(?:json|dat|hex|jsonl)$/i.test(url.pathname))) {
      sendJson(res, 403, {ok:false,error:"Private runtime files are not downloadable"}); return;
    }
    const filePath = url.pathname === "/"
      ? path.join(staticDir, defaultMonitorFile)
      : path.join(staticDir, url.pathname.replace(/^\/+/, ""));

    try {
      const buf = await readFile(filePath);
      if (filePath.endsWith(".html")) res.setHeader("content-type", "text/html; charset=utf-8");
      else if (filePath.endsWith(".js")) res.setHeader("content-type", "application/javascript; charset=utf-8");
      else if (filePath.endsWith(".css")) res.setHeader("content-type", "text/css; charset=utf-8");
      else if (filePath.endsWith(".png")) res.setHeader("content-type", "image/png");
      else if (filePath.endsWith(".svg")) res.setHeader("content-type", "image/svg+xml");
      else if (filePath.endsWith(".json")) res.setHeader("content-type", "application/json; charset=utf-8");
      else res.setHeader("content-type", "application/octet-stream");
      res.end(buf);
    } catch {
      res.statusCode = 404;
      res.end("not found");
    }
    })().catch((error) => {
      console.error("[monitor-request]", error);
      if (res.destroyed) return;
      if (!res.headersSent) sendJson(res, 503, { ok: false, error: "monitor request failed" });
      else res.destroy();
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  const displayPort = typeof address === "object" && address ? address.port : port;
  console.log(`monitor server: http://localhost:${displayPort}`);
  return server;
}













