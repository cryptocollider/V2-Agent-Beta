import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { buildEligibilityCompactCode } from "../agent/eligibility.js";
import { buildSettingsAuditReport } from "../agent/settings-audit.js";
import { resolveAgentProfile } from "../core/agent-profile.js";
import { buildBootstrapSummary } from "../core/bootstrap.js";
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

function resultRowCompletenessScore(row: any): number {
  let score = 0;
  if (row?.actual?.throwMatch) score += 4;
  if (row?.actual?.throwMatch?.hole_type != null) score += 8;
  if (row?.actual?.throwMatch?.value_usd_e8 != null) score += 4;
  if (row?.actual?.throwMatch?.matched) score += 2;
  if (Array.isArray(row?.actual?.wholeGame?.per_user_scoreboard)) score += 1;
  if (row?.actual?.expectationVsActual?.actual_hole_type != null) score += 2;
  return score;
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
    if (nextScore > prevScore || (nextScore === prevScore && nextTs >= prevTs)) {
      map.set(key, row);
    }
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

export async function startMonitorServer(cfg: ServerConfig = {}): Promise<http.Server> {
  const port = cfg.port ?? 8787;
  const dataDir = cfg.dataDir ?? "./data";
  const staticDir = cfg.staticDir ?? process.cwd();
  const bridge = cfg.bridge ?? {};

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

    if (url.pathname === "/api/settings" && req.method === "GET") {
      const settings = await loadSettings(dataDir);
      const runtime = await fromBridge(bridge.getRuntimeSettings, () => safeRuntimeSettings());
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
        const current = await loadSettings(dataDir);
        const merged = normalizeSettings({
          ...current,
          ...json,
          goalWeights: {
            ...(current.goalWeights ?? {}),
            ...((json?.goalWeights && typeof json.goalWeights === "object") ? json.goalWeights : {}),
          },
          onboarding: {
            ...(current.onboarding ?? {}),
            ...((json?.onboarding && typeof json.onboarding === "object") ? json.onboarding : {}),
          },
          humanLearning: {
            ...(current.humanLearning ?? {}),
            ...((json?.humanLearning && typeof json.humanLearning === "object") ? json.humanLearning : {}),
          },
        });

        await saveSettings(merged, dataDir);
        const runtime = await fromBridgeWithArg(
          bridge.updateRuntimeSettings,
          merged,
          (patch) => updateRuntimeSettings(patch),
        );

        sendJson(res, 200, {
          ok: true,
          settings: mergeEffectiveSettings(
            merged,
            (runtime && typeof runtime === "object") ? runtime as Record<string, unknown> : null,
          ),
          runtime,
        });
      } catch (err) {
        sendJson(res, 400, { ok: false, error: String(err) });
      }
      return;
    }

    if (url.pathname === "/api/runtime-settings" && req.method === "GET") {
      const runtime = await fromBridge(bridge.getRuntimeSettings, () => safeRuntimeSettings());
      if (!runtime) {
        sendJson(res, 500, { ok: false, error: "runtime settings not initialized" });
        return;
      }
      sendJson(res, 200, runtime);
      return;
    }

    if (url.pathname === "/api/control/status" && req.method === "GET") {
      sendJson(res, 200, await fromBridge(bridge.getControlState, () => getControlState()));
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
      const settings = await loadSettings(dataDir);
      const latestEligibility = await fromBridge(
        bridge.getLatestEligibilitySnapshot,
        () => getLatestEligibilitySnapshot(),
      );
      const resultsText = await safeReadText(path.join(dataDir, "results.jsonl"));
      const honestPerformance = buildHonestPerformanceSnapshot(parseJsonl(resultsText));
      const runtime = await fromBridge(bridge.getRuntimeSettings, () => safeRuntimeSettings());
      const settingsSource = (runtime && typeof runtime === "object")
        ? normalizeSettings({ ...settings, ...(runtime as Record<string, unknown>) })
        : settings;
      const profile = resolveAgentProfile(settingsSource);
      sendJson(res, 200, {
        settings,
        runtime,
        onboarding: buildBootstrapSummary(settingsSource),
        profile,
        control: await fromBridge(bridge.getControlState, () => getControlState()),
        audit: buildSettingsAuditReport(settings),
        overlay: await fromBridge(bridge.getManagerOverlay, () => getManagerOverlay()),
        managerCandidateSet: await fromBridge(bridge.getManagerCandidateSet, () => getManagerCandidateSet()),
        latestEligibility,
        eligibilityCode: buildEligibilityCompactCode(latestEligibility as any),
        latestCandidates: await fromBridge(bridge.getLatestCandidateContext, () => getLatestCandidateContext()),
        honestPerformance: {
          counts: honestPerformance.counts,
          baseline: honestPerformance.baseline,
          latest: honestPerformance.revealRows[0] ? summarizeHonestPerformanceRow(honestPerformance.revealRows[0]) : null,
          latestScored: honestPerformance.scoredRows[0] ? summarizeHonestPerformanceRow(honestPerformance.scoredRows[0]) : null,
        },
      });
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
      const latestEligibility = await fromBridge(
        bridge.getLatestEligibilitySnapshot,
        () => getLatestEligibilitySnapshot(),
      );
      sendJson(res, 200, {
        snapshot: latestEligibility,
        eligibilityCode: buildEligibilityCompactCode(latestEligibility as any),
      });
      return;
    }

    if (url.pathname === "/api/manager/candidates" && req.method === "GET") {
      sendJson(res, 200, {
        latest: await fromBridge(bridge.getLatestCandidateContext, () => getLatestCandidateContext()),
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
      const runtime = await fromBridge(bridge.getRuntimeSettings, () => safeRuntimeSettings());
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
      ? path.join(staticDir, "monitor.html")
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



