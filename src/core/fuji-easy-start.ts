import { createHash } from "node:crypto";
import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { autoDetectLocalManagerProvider } from "../llm/autodetect.js";
import {
  getManagerLlmState,
  initManagerLlmState,
  saveManagerLlmConfig,
} from "../llm/state.js";
import { AgentWallet, colliderUserIdFromEvmAddress } from "../collider/wallet.js";
import { FUJI_DIEM_ASSET } from "./fuji-testnet-funding.js";
import { loadOrCreateFujiTestWallet, type FujiTestWalletInfo } from "./fuji-test-wallet.js";
import {
  DEFAULT_ONBOARDING_SETTINGS,
  DEFAULT_SETTINGS,
  DEFAULT_TESTNET_AUTO_FUNDING_SETTINGS,
  loadSettings,
  normalizeSettings,
  saveSettings,
  type AgentSettings,
} from "./settings.js";

export const FUJI_EASY_START_DATA_DIR = "./data-fuji-rc1";
export const FUJI_EASY_START_CADENCE_MS = 60_000;
export const FUJI_EASY_START_SESSION_THROWS = 12_000;
export const FUJI_EASY_START_WEEKLY_THROWS = 10_080;
export const FUJI_EASY_START_MAX_THROWS_PER_GAME = 11;
export const FUJI_EASY_START_MAX_THROW_USD = 10;
export const FUJI_EASY_START_MAX_GAME_EXPOSURE_USD = 110;
export const FUJI_EASY_START_MAX_THROW_BASE = "5555555555555556";

const FUJI_RPC = "http://127.0.0.1:10950/ext/bc/2dTFQSe9RQLSSfv8auy7Ns8LvZZqSxViyxvVrg1QqF7zXYGH9p/collider_v2";
const FUJI_C_RPC = "http://127.0.0.1:10960/ext/bc/C/rpc";
const FUJI_NETWORK_DOMAIN = "0xe39abe180a717ef2f5738321a07dc917f66e368dc490ed982b69fd13f219c35f";
const FUJI_L1_ID = "0xa254bbec169ef57ffd5708997a80910a15a97121b74eba2c21b7c7ca26a856e0";
const FUJI_CHAIN_ID = "0xd6775179d72ada0cdbd6567594de0055afdb0e71ce2d23d7a0a2da702dc1eca1";
const FUJI_CUSTODY = "0xc73a331cd4d49856E95321DefFabad33d5088F05";
const FUJI_ROUTE_ID = "0x3a195f43460b8065a076f72e1c4b248cb46d5f4a3693cdf7f26955886a38f7d6";
const FUJI_ATTESTOR = "0xaad8b1f57773375abd8482a159f33901c8f6b9f4";
const FUJI_DIEM_TOKEN = "0x5Bc1Cb82cb2684fE4eeC76aB7fEB80Ba0797c20c";
const FUJI_DIEM_POLICY = "0x4315da2d9c5375960d5d2d1b4c8ddf75bdb326a4f59d00a203949b410ca1b2ef";
const FUJI_WEEKLY_RESERVE = "5555555555555555";

function cleanAsset(value: string): string {
  return value.replace(/^0x/i, "").toLowerCase();
}

function defaultWalletPath(dataDir: string): string {
  const instance = createHash("sha256").update(path.resolve(dataDir)).digest("hex").slice(0, 16);
  const appData = String(process.env.LOCALAPPDATA ?? "").trim();
  const base = appData || path.join(os.homedir(), ".local", "share");
  return path.join(base, "Collider", "Agent1", "fuji-rc1", instance, "agent1.hex");
}

export function buildFujiEasyStartSettings(wallet: Pick<FujiTestWalletInfo, "address" | "signingKeyFile">): AgentSettings {
  const amount = DEFAULT_TESTNET_AUTO_FUNDING_SETTINGS.defaultThrowAmount;
  const asset = cleanAsset(FUJI_DIEM_ASSET);
  return normalizeSettings({
    ...DEFAULT_SETTINGS,
    rpc: FUJI_RPC,
    user: colliderUserIdFromEvmAddress(wallet.address),
    signingKeyFile: wallet.signingKeyFile,
    expectedEvmAddress: wallet.address,
    expectedNetworkDomain: FUJI_NETWORK_DOMAIN,
    expectedNetworkId: 5,
    expectedL1Id: FUJI_L1_ID,
    expectedChainId: FUJI_CHAIN_ID,
    bridgeWithdrawal: {
      cRpc: FUJI_C_RPC,
      expectedEvmChainId: 43113,
      custodyContract: FUJI_CUSTODY,
      routeId: FUJI_ROUTE_ID,
      expectedAttestor: FUJI_ATTESTOR,
      assets: {
        [FUJI_DIEM_ASSET]: {
          tokenAddress: FUJI_DIEM_TOKEN,
          policyHash: FUJI_DIEM_POLICY,
          minWithdrawalAmount: "1000000000000000",
        },
      },
    },
    asset,
    amount,
    maxCandidates: 60,
    maxMs: 15_000,
    pollMs: 5_000,
    maxThrowsPerGame: FUJI_EASY_START_MAX_THROWS_PER_GAME,
    maxThrowsPerSession: FUJI_EASY_START_SESSION_THROWS,
    minMillisBetweenLiveThrows: FUJI_EASY_START_CADENCE_MS,
    monitorPort: 8787,
    minGameStakeUsd: 0,
    minThrowUsd: 0.09,
    maxThrowUsd: FUJI_EASY_START_MAX_THROW_USD,
    maxSingleThrowUsd: FUJI_EASY_START_MAX_THROW_USD,
    maxGameExposureUsd: FUJI_EASY_START_MAX_GAME_EXPOSURE_USD,
    maxSingleThrowBase: FUJI_EASY_START_MAX_THROW_BASE,
    riskMode: "balanced",
    doctrinePack: "baseline",
    allowedGameIds: [],
    allowedAssets: [asset],
    blockedAssets: [],
    reserveBalanceBase: FUJI_WEEKLY_RESERVE,
    keepAssets: [asset],
    disposeAssets: [],
    baselineResetThrows: 24,
    testnetAutoFunding: {
      ...DEFAULT_TESTNET_AUTO_FUNDING_SETTINGS,
      enabled: true,
    },
    onboarding: {
      ...DEFAULT_ONBOARDING_SETTINGS,
      testnetFundingStage: "CHECKING",
    },
    humanLearning: {
      enabled: true,
      learnOwnManualThrows: true,
      addresses: [],
      maxSeedsPerCycle: 12,
    },
  });
}

function isConfigured(settings: AgentSettings): boolean {
  return !!(
    settings.rpc
    && settings.expectedEvmAddress
    && (settings.signingKeyFile || String(process.env[settings.signingKeyEnv ?? "COLLIDER_AGENT_PRIVATE_KEY"] ?? "").trim())
  );
}

export type FujiEasyStartResult = {
  created: boolean;
  settings: AgentSettings;
  wallet: FujiTestWalletInfo | null;
};

export type FujiEasyStartOptions = {
  workspaceDir?: string;
  signingKeyFile?: string | null;
  allowDisposableTestWallet?: boolean;
};

async function loadSuppliedWallet(signingKeyFile: string): Promise<FujiTestWalletInfo> {
  const resolved = path.resolve(signingKeyFile);
  const wallet = await AgentWallet.load({ signingKeyFile: resolved });
  if (!wallet) throw new Error(`could not load the supplied signing key file ${resolved}`);
  return {
    profile: "fuji_rc1_test_wallet",
    address: wallet.address,
    signingKeyFile: resolved,
    created: false,
  };
}

export async function ensureFujiEasyStart(
  dataDir: string,
  options: FujiEasyStartOptions = {},
): Promise<FujiEasyStartResult> {
  let settingsExists = true;
  try {
    await access(path.join(dataDir, "settings.json"));
  } catch {
    settingsExists = false;
  }
  const existing = await loadSettings(dataDir);
  if (settingsExists && isConfigured(existing)) {
    return { created: false, settings: existing, wallet: null };
  }

  const suppliedKey = String(options.signingKeyFile ?? "").trim();
  let wallet: FujiTestWalletInfo;
  if (suppliedKey) {
    wallet = await loadSuppliedWallet(suppliedKey);
  } else if (options.allowDisposableTestWallet) {
    wallet = await loadOrCreateFujiTestWallet(defaultWalletPath(dataDir), options.workspaceDir ?? process.cwd());
  } else {
    throw new Error(
      "Fuji easy start needs a user-owned signing wallet. Pass --signing-key-file <encrypted-keystore.json> "
      + "(recommended; set COLLIDER_AGENT_KEY_PASSWORD), or explicitly opt into a disposable test-only wallet "
      + "with --create-disposable-test-wallet. Never paste a private key into the monitor UI.",
    );
  }
  const settings = buildFujiEasyStartSettings(wallet);
  await saveSettings(settings, dataDir);
  return { created: true, settings, wallet };
}

export async function prepareFujiEasyStartManager(dataDir: string): Promise<"configured" | "detected" | "not_detected"> {
  await initManagerLlmState(dataDir);
  const current = getManagerLlmState();
  if (Object.values(current.config.providers).some((provider) => provider.enabled)) return "configured";
  const detection = await autoDetectLocalManagerProvider("any");
  if (!detection.selected) return "not_detected";
  await saveManagerLlmConfig({
    activeProvider: detection.selected.providerId,
    autoApply: false,
    providers: {
      [detection.selected.providerId]: {
        enabled: true,
        model: detection.selected.model,
        endpointUrl: detection.selected.endpointUrl,
      },
    },
  });
  return "detected";
}
