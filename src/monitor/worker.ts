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

const pending = new Map<string, { resolve: (value: unknown) => void; reject: (reason?: unknown) => void }>();
let seq = 0;

workerPort.on("message", (message: BridgeResponse) => {
  if (!message || typeof message !== "object" || message.type !== "bridge-response") return;
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  if (message.ok) {
    request.resolve(message.result ?? null);
  } else {
    request.reject(new Error(String(message.error || "monitor bridge request failed")));
  }
});

function requestMain(method: string, payload?: unknown): Promise<unknown> {
  const id = `monitor-${Date.now()}-${++seq}`;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    workerPort.postMessage({ type: "bridge-request", id, method, payload });
  });
}

const bridge: MonitorBridge = {
  getRuntimeSettings: () => requestMain("getRuntimeSettings"),
  updateRuntimeSettings: (patch) => requestMain("updateRuntimeSettings", patch),
  getControlState: () => requestMain("getControlState"),
  applyControlAction: (request) => requestMain("applyControlAction", request),
  getLatestEligibilitySnapshot: () => requestMain("getLatestEligibilitySnapshot"),
  getLatestCandidateContext: () => requestMain("getLatestCandidateContext"),
  getManagerOverlay: () => requestMain("getManagerOverlay"),
  saveManagerOverlay: (overlay) => requestMain("saveManagerOverlay", overlay),
  getManagerCandidateSet: () => requestMain("getManagerCandidateSet"),
  saveManagerCandidateSet: (candidateSet) => requestMain("saveManagerCandidateSet", candidateSet),
  buildReplaySvgExport: (request) => requestMain("buildReplaySvgExport", request),
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

