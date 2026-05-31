import { existsSync } from "node:fs";
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { ColliderClient } from "../collider/client.js";
import { buildEligibilityCompactCode } from "../agent/eligibility.js";
import { buildSettingsAuditReport } from "../agent/settings-audit.js";
import { resolveAgentProfile } from "../core/agent-profile.js";
import { buildBootstrapSummary } from "../core/bootstrap.js";
import { normalizeAssetsMetaPayload } from "../core/assets-meta.js";
import { normalizeReplaySvgRequest, type ReplaySvgRequest } from "./replay-svg.js";
import { buildHonestPerformanceBaseline } from "../core/hps-baseline.js";
import {
  getControlState,
  getRuntimeSettings,
  applyControlAction,
  updateRuntimeSettings,
} from "../core/runtime-state.js";
import { loadSettings, normalizeSettings, saveSettings } from "../core/settings.js";
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
import { autoSetupLocalManagerRuntime, buildLocalManagerSetupPlan } from "../llm/local-setup.js";
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

const BRIDGE_READ_TIMEOUT_MS = 3000;

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

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

    if (url.pathname === "/api/logs/runs") {
      const txt = await safeReadText(path.join(dataDir, "runs.jsonl"));
      sendJson(res, 200, parseJsonl(txt));
      return;
    }

    if (url.pathname === "/api/logs/throws") {
      const txt = await safeReadText(path.join(dataDir, "throws.jsonl"));
      sendJson(res, 200, parseJsonl(txt));
      return;
    }

    if (url.pathname === "/api/logs/results") {
      const txt = await safeReadText(path.join(dataDir, "results.jsonl"));
      sendJson(res, 200, parseJsonl(txt));
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
        () => safeRuntimeSettings(),
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
      const runtime = await fromBridgeRead(
        bridge.getRuntimeSettings,
        () => safeRuntimeSettings(),
        "runtime settings",
      );
      if (!runtime) {
        sendJson(res, 500, { ok: false, error: "runtime settings not initialized" });
        return;
      }
      sendJson(res, 200, runtime);
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
      const resultsText = await safeReadText(path.join(dataDir, "results.jsonl"));
      const honestPerformance = buildHonestPerformanceSnapshot(parseJsonl(resultsText));
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
      });
      return;
    }

    if (url.pathname === "/api/manager/reveals" && req.method === "GET") {
      const limit = parseLimit(url, 10, 100);
      const includeArtifacts = queryFlag(url, "includeArtifacts");
      const gameId = cleanHex(url.searchParams.get("gameId") || "");
      const decisionId = cleanHex(url.searchParams.get("decisionId") || "");
      const resultsText = await safeReadText(path.join(dataDir, "results.jsonl"));
      const honestPerformance = buildHonestPerformanceSnapshot(parseJsonl(resultsText));
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

    if (url.pathname === "/api/manager/llm" && req.method === "GET") {
      sendJson(res, 200, { state: getPublicManagerLlmState() });
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
        const setupPlan = buildLocalManagerSetupPlan();
        if (!detection.selected) {
          sendJson(res, 404, {
            ok: false,
            error: "No supported local manager runtime was detected. Start Ollama or a local OpenAI-compatible server first.",
            candidates: detection.candidates,
            setupPlan,
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
          setupPlan,
          state,
        });
      } catch (err) {
        sendJson(res, 400, { ok: false, error: String(err), setupPlan: buildLocalManagerSetupPlan(), state: getPublicManagerLlmState() });
      }
      return;
    }

    if (url.pathname === "/api/manager/llm/local-setup" && req.method === "POST") {
      const setupPlan = buildLocalManagerSetupPlan();
      try {
        const json = await readJsonBody(req).catch(() => ({}));
        const planId = String(json?.planId || setupPlan.recommendedPlanId || "ollama").trim() || setupPlan.recommendedPlanId;
        const execution = await autoSetupLocalManagerRuntime(planId);
        if (!execution.ok) {
          sendJson(res, 400, {
            ok: false,
            error: execution.error || execution.message,
            message: execution.message,
            steps: execution.steps,
            setupPlan,
            state: getPublicManagerLlmState(),
          });
          return;
        }
        const state = await saveManagerLlmConfig({
          activeProvider: execution.option.providerId,
          providers: {
            [execution.option.providerId]: {
              enabled: true,
              model: execution.option.model,
              endpointUrl: execution.option.endpointUrl,
            },
          },
        });
        await setManagerLlmError(null);
        sendJson(res, 200, {
          ok: true,
          message: execution.message,
          steps: execution.steps,
          detected: execution.detected ?? {
            providerId: execution.option.providerId,
            endpointUrl: execution.option.endpointUrl,
            model: execution.option.model,
            label: execution.option.label,
            source: "local_setup",
          },
          setupPlan,
          state,
        });
      } catch (err) {
        sendJson(res, 400, { ok: false, error: String(err), setupPlan, state: getPublicManagerLlmState() });
      }
      return;
    }

    if (url.pathname === "/api/manager/llm/reset" && req.method === "POST") {
      sendJson(res, 200, { ok: true, state: await resetManagerLlmSession() });
      return;
    }

    if (url.pathname === "/api/manager/llm/chat" && req.method === "POST") {
      try {
        const json = await readJsonBody(req);
        const message = String(json?.message || "").trim();
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
        sendJson(res, 200, {
          ok: true,
          assistantMessage: conversation.reply,
          summary: conversation.summary,
          actions: conversation.actions,
          state: getPublicManagerLlmState(),
        });
      } catch (err) {
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
        sendJson(res, 200, {
          ok: true,
          assistantMessage: conversation.reply,
          summary: conversation.summary,
          actions: conversation.actions,
          state: getPublicManagerLlmState(),
        });
      } catch (err) {
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
  });

  await new Promise<void>((resolve) => {
    server.listen(port, () => resolve());
  });

  const address = server.address();
  const displayPort = typeof address === "object" && address ? address.port : port;
  console.log(`monitor server: http://localhost:${displayPort}`);
  return server;
}













