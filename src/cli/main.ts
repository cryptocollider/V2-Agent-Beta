#!/usr/bin/env node

import process from "node:process";
import { Worker } from "node:worker_threads";

import { runAgentOnce } from "../agent/loop.js";
import { runAgentSession } from "../agent/session.js";
import { ColliderClient } from "../collider/client.js";
import { MASK_LIVE } from "../collider/masks.js";
import {
  getLatestCandidateContext,
  getLatestEligibilitySnapshot,
  getManagerCandidateSet,
  getManagerOverlay,
  initManagerState,
  saveManagerCandidateSet,
  saveManagerOverlay,
} from "../core/manager-state.js";
import { loadSettings } from "../core/settings.js";
import { initStorage, makeSessionId } from "../core/storage.js";
import {
  applyControlAction,
  getControlState,
  getRuntimeSettings,
  initRuntimeSettings,
  updateRuntimeSettings,
} from "../core/runtime-state.js";
import { DEFAULT_POLICY } from "../policy/schema.js";
import { loadVizWasm } from "../sim/wasm.js";

type MonitorBridgeRequest = {
  type: "bridge-request";
  id: string;
  method: string;
  payload?: unknown;
};

function arg(name: string, fallback?: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  return fallback;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

async function handleMonitorBridgeRequest(message: MonitorBridgeRequest): Promise<unknown> {
  switch (message.method) {
    case "getRuntimeSettings":
      return getRuntimeSettings();
    case "updateRuntimeSettings":
      return updateRuntimeSettings((message.payload ?? {}) as Record<string, unknown>);
    case "getControlState":
      return getControlState();
    case "applyControlAction": {
      const request = (message.payload ?? {}) as { action?: string; payload?: Record<string, unknown> };
      return applyControlAction(String(request.action || ""), request.payload ?? {});
    }
    case "getLatestEligibilitySnapshot":
      return getLatestEligibilitySnapshot();
    case "getLatestCandidateContext":
      return getLatestCandidateContext();
    case "getManagerOverlay":
      return getManagerOverlay();
    case "saveManagerOverlay":
      return await saveManagerOverlay((message.payload ?? null) as any);
    case "getManagerCandidateSet":
      return getManagerCandidateSet();
    case "saveManagerCandidateSet":
      return await saveManagerCandidateSet((message.payload ?? null) as any);
    default:
      throw new Error(`unknown monitor bridge method: ${message.method}`);
  }
}

async function startMonitorWorker(cfg: { port: number; dataDir: string; staticDir: string }): Promise<Worker> {
  const workerExt = import.meta.url.endsWith(".ts") ? "ts" : "js";
  const worker = new Worker(new URL(`../monitor/worker.${workerExt}`, import.meta.url), {
    workerData: cfg,
  });

  return await new Promise<Worker>((resolve, reject) => {
    let settled = false;

    const finishResolve = () => {
      if (settled) return;
      settled = true;
      resolve(worker);
    };

    const finishReject = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    worker.on("message", async (message: any) => {
      if (!message || typeof message !== "object") return;

      if (message.type === "bridge-request") {
        try {
          const result = await handleMonitorBridgeRequest(message as MonitorBridgeRequest);
          worker.postMessage({ type: "bridge-response", id: message.id, ok: true, result });
        } catch (err) {
          worker.postMessage({ type: "bridge-response", id: message.id, ok: false, error: String(err) });
        }
        return;
      }

      if (message.type === "listening") {
        finishResolve();
        return;
      }

      if (message.type === "startup_error") {
        finishReject(message.error || "monitor worker failed during startup");
      }
    });

    worker.once("error", (err) => {
      if (settled) {
        console.error("[monitor-worker]", err);
        return;
      }
      finishReject(err);
    });

    worker.once("exit", (code) => {
      if (code === 0) return;
      const error = new Error(`[monitor-worker] exited with code ${code}`);
      if (settled) {
        console.error(error.message);
        return;
      }
      finishReject(error);
    });
  });
}

async function main(): Promise<void> {
  const dataDir = arg("--data-dir", process.env.COLLIDER_DATA_DIR ?? "./data")!;
  const fileSettings = await loadSettings(dataDir);

  const effectiveSettings = {
    ...fileSettings,
    rpc: arg("--rpc", process.env.COLLIDER_RPC_URL ?? fileSettings.rpc)!,
    wasm: arg("--wasm", process.env.COLLIDER_SIM_WASM ?? fileSettings.wasm)!,
    user: arg("--user", process.env.COLLIDER_BOT_USER ?? fileSettings.user)!,
    asset: arg("--asset", process.env.COLLIDER_DEFAULT_ASSET ?? fileSettings.asset)!,
    amount: arg("--amount", process.env.COLLIDER_DEFAULT_AMOUNT ?? fileSettings.amount)!,
    maxCandidates: Number(arg("--max-candidates", String(fileSettings.maxCandidates))),
    maxMs: Number(arg("--max-ms", String(fileSettings.maxMs))),
    pollMs: Number(arg("--poll-ms", String(fileSettings.pollMs))),
    maxThrowsPerGame: Number(arg("--max-throws-per-game", String(fileSettings.maxThrowsPerGame))),
    maxThrowsPerSession: Number(arg("--max-throws-per-session", String(fileSettings.maxThrowsPerSession))),
    minMillisBetweenLiveThrows: Number(
      arg("--min-ms-between-live-throws", String(fileSettings.minMillisBetweenLiveThrows)),
    ),
    monitorPort: Number(arg("--monitor-port", String(fileSettings.monitorPort))),
  };

  initRuntimeSettings(effectiveSettings);
  await initManagerState(dataDir);

  const rpcUrl = effectiveSettings.rpc;
  const wasmPath = effectiveSettings.wasm;
  const botUser = effectiveSettings.user;
  const asset = effectiveSettings.asset;
  const amount = effectiveSettings.amount;
  const maxCandidates = effectiveSettings.maxCandidates;
  const maxMillis = effectiveSettings.maxMs;
  const pollMs = effectiveSettings.pollMs;
  const monitorPort = effectiveSettings.monitorPort;

  if (!rpcUrl) throw new Error("missing rpc");
  if (!wasmPath) throw new Error("missing wasm");
  if (!botUser) throw new Error("missing user");
  if (!asset) throw new Error("missing asset");

  const dryRun = hasFlag("--dry-run");
  const stopOnWinner = hasFlag("--stop-on-winner");
  const loop = hasFlag("--loop");
  const serveMonitor = hasFlag("--serve-monitor");
  const maxCycles = Number(arg("--max-cycles", "999999"));

  const sessionId = makeSessionId();
  const storage = await initStorage(dataDir);

  console.log(
    `session=${sessionId} dataDir=${storage.rootDir} mode=${dryRun ? "dry-run" : "live"} loop=${loop ? "yes" : "no"}`,
  );

  if (serveMonitor) {
    await startMonitorWorker({
      port: monitorPort,
      dataDir,
      staticDir: process.cwd(),
    });
  }

  const client = new ColliderClient(rpcUrl);
  const wasm = await loadVizWasm(wasmPath);

  const policy = {
    ...DEFAULT_POLICY,
    maxThrowsPerGame: effectiveSettings.maxThrowsPerGame,
    maxThrowsPerSession: effectiveSettings.maxThrowsPerSession,
    minMillisBetweenLiveThrows: effectiveSettings.minMillisBetweenLiveThrows,
  };

  const loopCfg = {
    gameStatusMask: MASK_LIVE,
    botUser,
    defaultAsset: asset,
    defaultAmount: amount!,
    dryRun,
    includeSlip1: true,
    sessionId,
    storage,
    candidateBudget: {
      maxCandidates,
      maxMillis,
      stopOnWinner,
      winnerScoreThreshold: 20000,
    },
    candidateGen: {
      xSteps: 3,
      ySteps: 2,
      angleDegs: [-75, -60, -45, -30, -15, 0, 15, 30, 45, 60, 75],
      speedPcts: [35, 50, 65, 80, 95],
      spinPcts: [-50, -25, 0, 25, 50],
    },
    scoreConfig: {
      robustnessWeight: 1.0,
      fragilityWeight: 0.25,
    },
  };

  if (loop) {
    await runAgentSession(
      client,
      wasm,
      policy,
      loopCfg,
      {
        pollMs,
        maxCycles,
        cooldownMsPerGame: 20000,
      },
    );
    return;
  }

  const result = await runAgentOnce(
    client,
    wasm,
    policy,
    loopCfg,
  );

  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

