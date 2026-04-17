import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { buildEligibilityCompactCode } from "../agent/eligibility.js";
import { buildSettingsAuditReport } from "../agent/settings-audit.js";
import {
  getControlState,
  getRuntimeSettings,
  applyControlAction,
  updateRuntimeSettings,
} from "../core/runtime-state.js";
import { loadSettings, saveSettings } from "../core/settings.js";
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
      sendJson(res, 200, settings);
      return;
    }

    if (url.pathname === "/api/settings" && req.method === "POST") {
      try {
        const json = await readJsonBody(req);
        const current = await loadSettings(dataDir);
        const merged = { ...current, ...json };

        await saveSettings(merged, dataDir);
        const runtime = await fromBridgeWithArg(
          bridge.updateRuntimeSettings,
          merged,
          (patch) => updateRuntimeSettings(patch),
        );

        sendJson(res, 200, { ok: true, settings: merged, runtime });
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

    if (url.pathname === "/api/manager/state" && req.method === "GET") {
      const settings = await loadSettings(dataDir);
      const latestEligibility = await fromBridge(
        bridge.getLatestEligibilitySnapshot,
        () => getLatestEligibilitySnapshot(),
      );
      sendJson(res, 200, {
        settings,
        runtime: await fromBridge(bridge.getRuntimeSettings, () => safeRuntimeSettings()),
        control: await fromBridge(bridge.getControlState, () => getControlState()),
        audit: buildSettingsAuditReport(settings),
        overlay: await fromBridge(bridge.getManagerOverlay, () => getManagerOverlay()),
        managerCandidateSet: await fromBridge(bridge.getManagerCandidateSet, () => getManagerCandidateSet()),
        latestEligibility,
        eligibilityCode: buildEligibilityCompactCode(latestEligibility as any),
        latestCandidates: await fromBridge(bridge.getLatestCandidateContext, () => getLatestCandidateContext()),
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

