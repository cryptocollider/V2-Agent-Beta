import { parentPort, workerData } from "node:worker_threads";
import { startMonitorServer, type MonitorBridge, type ServerConfig } from "./server.js";

type BridgeResponse = {
  type: "bridge-response";
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
};

const port = parentPort;
if (!port) {
  throw new Error("monitor worker requires parentPort");
}
const workerPort = port as NonNullable<typeof parentPort>;

const BRIDGE_READ_TIMEOUT_MS = 3000;
const BRIDGE_WRITE_TIMEOUT_MS = 5000;
const BRIDGE_REPLAY_TIMEOUT_MS = 30000;

const pending = new Map<string, {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}>();
let seq = 0;

workerPort.on("message", (message: BridgeResponse) => {
  if (!message || typeof message !== "object" || message.type !== "bridge-response") return;
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  clearTimeout(request.timer);
  if (message.ok) {
    request.resolve(message.result ?? null);
  } else {
    request.reject(new Error(String(message.error || "monitor bridge request failed")));
  }
});

function requestMain(method: string, payload?: unknown, timeoutMs = BRIDGE_READ_TIMEOUT_MS): Promise<unknown> {
  const id = `monitor-${Date.now()}-${++seq}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const request = pending.get(id);
      if (!request) return;
      pending.delete(id);
      request.reject(new Error(`monitor bridge timeout for ${method} after ${timeoutMs}ms`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    workerPort.postMessage({ type: "bridge-request", id, method, payload });
  });
}

const bridge: MonitorBridge = {
  getRuntimeSettings: () => requestMain("getRuntimeSettings", undefined, BRIDGE_READ_TIMEOUT_MS),
  updateRuntimeSettings: (patch) => requestMain("updateRuntimeSettings", patch, BRIDGE_WRITE_TIMEOUT_MS),
  getControlState: () => requestMain("getControlState", undefined, BRIDGE_READ_TIMEOUT_MS),
  applyControlAction: (request) => requestMain("applyControlAction", request, BRIDGE_WRITE_TIMEOUT_MS),
  getLatestEligibilitySnapshot: () => requestMain("getLatestEligibilitySnapshot", undefined, BRIDGE_READ_TIMEOUT_MS),
  getLatestCandidateContext: () => requestMain("getLatestCandidateContext", undefined, BRIDGE_READ_TIMEOUT_MS),
  getManagerOverlay: () => requestMain("getManagerOverlay", undefined, BRIDGE_READ_TIMEOUT_MS),
  saveManagerOverlay: (overlay) => requestMain("saveManagerOverlay", overlay, BRIDGE_WRITE_TIMEOUT_MS),
  getManagerCandidateSet: () => requestMain("getManagerCandidateSet", undefined, BRIDGE_READ_TIMEOUT_MS),
  saveManagerCandidateSet: (candidateSet) => requestMain("saveManagerCandidateSet", candidateSet, BRIDGE_WRITE_TIMEOUT_MS),
  buildReplaySvgExport: (request) => requestMain("buildReplaySvgExport", request, BRIDGE_REPLAY_TIMEOUT_MS),
};

const cfg = (workerData || {}) as ServerConfig;

startMonitorServer({ ...cfg, bridge })
  .then((server) => {
    const address = server.address();
    const displayPort = typeof address === "object" && address ? address.port : cfg.port;
    workerPort.postMessage({ type: "listening", port: displayPort });
  })
  .catch((err) => {
    workerPort.postMessage({ type: "startup_error", error: String(err) });
  });
