import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type AgentSettings = {
  rpc: string;
  wasm: string;
  user: string;
  asset: string;
  amount: string;
  maxCandidates: number;
  maxMs: number;
  pollMs: number;
  maxThrowsPerGame: number;
  maxThrowsPerSession: number;
  minMillisBetweenLiveThrows: number;
  monitorPort: number;
  minGameStakeUsd?: number | null;
  maxSingleThrowUsd?: number | null;
  maxGameExposureUsd?: number | null;
  minThrowUsd?: number | null;
  maxThrowUsd?: number | null;
  riskMode?: "defensive" | "balanced" | "aggressive";
  copySlammerWhenSameHoleType?: boolean;
  allowedAssets?: string[];
  blockedAssets?: string[];
  reserveBalanceBase?: string;
  targetBalanceUsd?: number | null;
  targetProfitUsd?: number | null;
  keepAssets?: string[];
  disposeAssets?: string[];
};

export const DEFAULT_SETTINGS: AgentSettings = {
  rpc: "https://v2.cryptocollider.com:4430/ext/bc/WdFeSwHfau9U7Vj8B1wEHhNMtubRQKfVGiuJwgTyDUBLbCH4s/collider_v2",
  wasm: "./assets/sim_core.wasm",
  user: "",
  asset: "",
  amount: "1000000",
  maxCandidates: 50,
  maxMs: 20000,
  pollMs: 15000,
  maxThrowsPerGame: 3,
  maxThrowsPerSession: 50,
  minMillisBetweenLiveThrows: 20000,
  monitorPort: 8787,
  minGameStakeUsd: null,
  maxSingleThrowUsd: null,
  maxGameExposureUsd: null,
  minThrowUsd: null,
  maxThrowUsd: null,
  riskMode: "balanced",
  copySlammerWhenSameHoleType: false,
  allowedAssets: [],
  blockedAssets: [],
  reserveBalanceBase: "0",
  targetBalanceUsd: null,
  targetProfitUsd: null,
  keepAssets: [],
  disposeAssets: [],
};

export async function loadSettings(dataDir = "./data"): Promise<AgentSettings> {
  await mkdir(dataDir, { recursive: true });
  const file = path.join(dataDir, "settings.json");

  try {
    const txt = await readFile(file, "utf8");
    const parsed = JSON.parse(txt) as Partial<AgentSettings>;
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    await saveSettings(DEFAULT_SETTINGS, dataDir);
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(settings: AgentSettings, dataDir = "./data"): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const file = path.join(dataDir, "settings.json");
  await writeFile(file, JSON.stringify(settings, null, 2), "utf8");
}