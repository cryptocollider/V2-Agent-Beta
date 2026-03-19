import type { AgentSettings } from "./settings.js";

let runtimeSettings: AgentSettings | null = null;

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