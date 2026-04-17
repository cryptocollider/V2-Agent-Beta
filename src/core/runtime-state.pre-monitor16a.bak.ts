import type { AgentSettings } from "./settings.js";

export type AgentControlState = {
  state: "live" | "paused" | "stopping";
  mode: string;
  lastAction: {
    action: string;
    ts: string;
    throwsTarget?: number | null;
    exclusive?: boolean;
  } | null;
  lastMessage: string | null;
  throwsTarget: number | null;
  exclusive: boolean;
};

let runtimeSettings: AgentSettings | null = null;
let controlState: AgentControlState = {
  state: "live",
  mode: "regular",
  lastAction: null,
  lastMessage: null,
  throwsTarget: null,
  exclusive: false,
};

export function initRuntimeSettings(settings: AgentSettings): AgentSettings {
  runtimeSettings = { ...settings };
  return { ...runtimeSettings };
}

export function getRuntimeSettings(): AgentSettings {
  if (!runtimeSettings) {
    throw new Error("runtime settings not initialized");
  }
  return { ...runtimeSettings };
}

export function updateRuntimeSettings(patch: Partial<AgentSettings>): AgentSettings {
  if (!runtimeSettings) {
    throw new Error("runtime settings not initialized");
  }
  runtimeSettings = { ...runtimeSettings, ...patch };
  return { ...runtimeSettings };
}

export function getControlState(): AgentControlState {
  return { ...controlState, lastAction: controlState.lastAction ? { ...controlState.lastAction } : null };
}

export function updateControlState(patch: Partial<AgentControlState>): AgentControlState {
  controlState = {
    ...controlState,
    ...patch,
    lastAction: patch.lastAction === undefined
      ? controlState.lastAction
      : (patch.lastAction ? { ...patch.lastAction } : null),
  };
  return getControlState();
}

export function applyControlAction(action: string, payload: Record<string, unknown> = {}): AgentControlState {
  const ts = new Date().toISOString();
  const throwsTarget = Number.isFinite(Number(payload.throwsTarget)) ? Number(payload.throwsTarget) : null;
  const exclusive = !!payload.exclusive;

  switch (action) {
    case "start":
      return updateControlState({
        state: "live",
        mode: "regular",
        throwsTarget: null,
        exclusive: false,
        lastAction: { action, ts, throwsTarget: null, exclusive: false },
        lastMessage: "Agent resumed.",
      });
    case "stop":
      return updateControlState({
        state: "paused",
        mode: "regular",
        lastAction: { action, ts, throwsTarget: null, exclusive: false },
        lastMessage: "Agent paused by operator.",
      });
    case "calibrate":
      return updateControlState({
        state: "live",
        mode: "calibrate-50",
        throwsTarget,
        exclusive,
        lastAction: { action, ts, throwsTarget, exclusive },
        lastMessage: `Calibration run requested${throwsTarget ? ` (${throwsTarget} throws)` : ""}.`,
      });
    case "full_clean":
      return updateControlState({
        state: "live",
        mode: "full-clean-2000",
        throwsTarget,
        exclusive: true,
        lastAction: { action, ts, throwsTarget, exclusive: true },
        lastMessage: `Full clean requested${throwsTarget ? ` (${throwsTarget} throws)` : ""}.`,
      });
    default:
      return updateControlState({
        lastAction: { action, ts, throwsTarget, exclusive },
        lastMessage: `Unknown control action: ${action}`,
      });
  }
}
