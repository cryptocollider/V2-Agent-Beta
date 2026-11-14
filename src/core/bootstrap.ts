import { ColliderClient } from "../collider/client.js";
import { assertNativeSigningContext } from "../collider/native-signing.js";
import { FUJI_NATIVE_V2_RPC } from "./fuji-native-v2.js";
import { FUJI_BONDED_RPC } from "./fuji-bonded.js";
import { AgentWallet, colliderUserIdFromEvmAddress, normalizeEvmAddress } from "../collider/wallet.js";
import { DOCTRINE_PACK_PRESETS, type DoctrinePackId } from "./agent-profile.js";
import {
  BETA_CLC_ASSET,
  normalizeSettings,
  saveSettings,
  type AgentSettings,
  type Rc1FundingStatus,
} from "./settings.js";

export type AgentBootstrapSummary = {
  profile: "rc1_wallet";
  startupMode: "production_rc1" | "fuji_rc1_testnet";
  fundingStatus: Rc1FundingStatus;
  startCommand: string;
  starterQuestion: string;
  starterStyles: Array<{
    promptLabel: "baseline" | "careful" | "stubborn" | "exploratory" | "hybrid";
    doctrinePack: DoctrinePackId;
    doctrineLabel: string;
    summary: string;
  }>;
  user: string | null;
  evmAddress: string | null;
  walletConfigured: boolean;
  rpcConfigured: boolean;
  expectedNetworkDomain: string | null;
  asset: string | null;
  amount: string;
  fundingCheckedAt: string | null;
  fundingError: string | null;
  testnetAutoFunding: {
    enabled: boolean;
    profile: "fuji_rc1_loopback" | "fuji_rc1_public_20261104";
    stage: string;
    detail: string | null;
    updatedAt: string | null;
    error: string | null;
    depositTx: string | null;
  };
  welcomePending: boolean;
  humanLearning: {
    enabled: boolean;
    learnOwnManualThrows: boolean;
    trackedAddresses: string[];
    maxSeedsPerCycle: number | null;
  };
};

const STARTER_QUESTION =
  "How would you like me to play from here: baseline, careful, stubborn, exploratory, or hybrid?";

const STARTER_STYLE_CHOICES: Array<{
  promptLabel: "baseline" | "careful" | "stubborn" | "exploratory" | "hybrid";
  doctrinePack: DoctrinePackId;
}> = [
  { promptLabel: "baseline", doctrinePack: "baseline" },
  { promptLabel: "careful", doctrinePack: "peanut" },
  { promptLabel: "stubborn", doctrinePack: "tough_nut" },
  { promptLabel: "exploratory", doctrinePack: "nutjob" },
  { promptLabel: "hybrid", doctrinePack: "prof_deez_nutz" },
];

function cleanHex(value: unknown): string {
  return String(value ?? "").trim().replace(/^0x/i, "").toLowerCase();
}

function with0x(value: unknown): string {
  const cleaned = cleanHex(value);
  return cleaned ? `0x${cleaned}` : "";
}

function isFunded(balances: Record<string, string>, selectedAsset: string): boolean {
  const selected = cleanHex(selectedAsset);
  const values = selected
    ? Object.entries(balances)
      .filter(([asset]) => cleanHex(asset) === selected)
      .map(([, value]) => value)
    : Object.values(balances);
  return values.some((value) => {
    try {
      return /^\d+$/.test(String(value)) && BigInt(value) > 0n;
    } catch {
      return false;
    }
  });
}

function removeBetaAssetDefaults(settings: AgentSettings): AgentSettings {
  // October RC1 deliberately assigns the historical 0x01..01 identifier to
  // real Fuji USDC. Asset IDs alone therefore cannot identify a beta default.
  // The old synthetic CLC identifier remains beta-only; keep legitimate RC1
  // USDC selections intact and let the live catalog/policy checks validate it.
  const betaAssets = new Set([BETA_CLC_ASSET]);
  const selectedWasBeta = betaAssets.has(cleanHex(settings.asset));
  return normalizeSettings({
    ...settings,
    asset: selectedWasBeta ? "" : settings.asset,
    amount: selectedWasBeta ? "0" : settings.amount,
    allowedAssets: (settings.allowedAssets ?? []).filter((asset) => !betaAssets.has(cleanHex(asset))),
    keepAssets: (settings.keepAssets ?? []).filter((asset) => !betaAssets.has(cleanHex(asset))),
    disposeAssets: (settings.disposeAssets ?? []).filter((asset) => !betaAssets.has(cleanHex(asset))),
  });
}

export function buildBootstrapSummary(settings: AgentSettings): AgentBootstrapSummary {
  const normalized = normalizeSettings(settings);
  const fujiTestnet = !!normalized.testnetAutoFunding?.enabled;
  const onboarding = normalized.onboarding;
  const trackedAddresses = [
    ...(normalized.humanLearning?.addresses ?? []),
    normalized.humanLearning?.learnOwnManualThrows ? cleanHex(normalized.user) : "",
  ].map(cleanHex).filter(Boolean);
  return {
    profile: "rc1_wallet",
    startupMode: fujiTestnet ? "fuji_rc1_testnet" : "production_rc1",
    fundingStatus: onboarding?.fundingStatus ?? "wallet_unconfigured",
    startCommand: normalized.publicRc1 ? "npm run start:fuji:public" : normalized.rpc === FUJI_BONDED_RPC ? "npm run start:fuji:bonded" : normalized.rpc === FUJI_NATIVE_V2_RPC ? "npm run start:fuji:native-v2" : fujiTestnet ? "npm run start:fuji" : "npm start",
    starterQuestion: STARTER_QUESTION,
    starterStyles: STARTER_STYLE_CHOICES.map((entry) => ({
      promptLabel: entry.promptLabel,
      doctrinePack: entry.doctrinePack,
      doctrineLabel: DOCTRINE_PACK_PRESETS[entry.doctrinePack].label,
      summary: DOCTRINE_PACK_PRESETS[entry.doctrinePack].summary,
    })),
    user: cleanHex(normalized.user) || null,
    evmAddress: normalizeEvmAddress(onboarding?.walletAddress ?? normalized.expectedEvmAddress),
    walletConfigured: !!onboarding?.walletConfiguredAt,
    rpcConfigured: !!normalized.rpc,
    expectedNetworkDomain: normalized.expectedNetworkDomain ?? null,
    asset: cleanHex(normalized.asset) || null,
    amount: String(normalized.amount || "0"),
    fundingCheckedAt: onboarding?.fundingCheckedAt ?? null,
    fundingError: onboarding?.fundingError ?? null,
    testnetAutoFunding: {
      enabled: !!normalized.testnetAutoFunding?.enabled,
      profile: normalized.testnetAutoFunding?.profile ?? "fuji_rc1_loopback",
      stage: onboarding?.testnetFundingStage ?? "DISABLED",
      detail: onboarding?.testnetFundingDetail ?? null,
      updatedAt: onboarding?.testnetFundingUpdatedAt ?? null,
      error: onboarding?.testnetFundingError ?? null,
      depositTx: onboarding?.testnetFundingDepositTx ?? null,
    },
    welcomePending: !onboarding?.welcomeDismissedAt,
    humanLearning: {
      enabled: !!normalized.humanLearning?.enabled,
      learnOwnManualThrows: !!normalized.humanLearning?.learnOwnManualThrows,
      trackedAddresses: [...new Set(trackedAddresses)],
      maxSeedsPerCycle: normalized.humanLearning?.maxSeedsPerCycle ?? null,
    },
  };
}

export async function ensureRc1Bootstrap(
  settings: AgentSettings,
  dataDir: string,
  wallet: AgentWallet | null,
): Promise<AgentSettings> {
  let next = removeBetaAssetDefaults(normalizeSettings(settings));
  const now = new Date().toISOString();
  const publicAddress = wallet?.address ?? normalizeEvmAddress(next.expectedEvmAddress);
  const user = publicAddress ? colliderUserIdFromEvmAddress(publicAddress) : "";
  let fundingStatus: Rc1FundingStatus = wallet ? "rpc_unconfigured" : "wallet_unconfigured";
  let fundingCheckedAt: string | null = null;
  let fundingError: string | null = null;

  if (next.rpc && publicAddress) {
    try {
      const client = new ColliderClient(next.rpc);
      const serverUser = await client.userIdFromEvmAddress(publicAddress);
      if (cleanHex(serverUser) !== cleanHex(user)) throw new Error("RPC returned a non-canonical Collider UserId for the Agent1 wallet");
      const context = await client.getAuthContext(with0x(user));
      assertNativeSigningContext(context, next.expectedSigningChainId);
      if (!context.domain_configured || !context.user?.canonical_wallet_user) throw new Error("RPC auth domain is not production-ready");
      if (cleanHex(context.user.user_id) !== cleanHex(user)) throw new Error("RPC auth context user mismatch");
      if (next.expectedNetworkDomain && cleanHex(context.network_domain) !== cleanHex(next.expectedNetworkDomain)) {
        throw new Error("RPC network domain does not match expectedNetworkDomain");
      }
      if (next.expectedNetworkId != null && context.network_id !== next.expectedNetworkId) throw new Error("RPC Avalanche network id mismatch");
      if (next.expectedL1Id && cleanHex(context.l1_id) !== cleanHex(next.expectedL1Id)) throw new Error("RPC L1 id mismatch");
      if (next.expectedChainId && cleanHex(context.chain_id) !== cleanHex(next.expectedChainId)) throw new Error("RPC chain id mismatch");
      fundingStatus = isFunded(await client.getBalances(with0x(user)), next.asset) ? "funded" : "awaiting_funding";
      fundingCheckedAt = now;
    } catch (error) {
      fundingStatus = "rpc_incompatible";
      fundingCheckedAt = now;
      fundingError = String(error);
    }
  }

  next = normalizeSettings({
    ...next,
    user: cleanHex(user),
    expectedEvmAddress: publicAddress,
    onboarding: {
      profile: "rc1_wallet",
      bootstrapVersion: 2,
      walletAddress: publicAddress,
      walletConfiguredAt: wallet ? (next.onboarding?.walletConfiguredAt ?? now) : null,
      fundingStatus,
      fundingCheckedAt,
      fundingError,
      testnetFundingStage: next.testnetAutoFunding?.enabled
        ? (fundingStatus === "funded" ? "COMPLETE" : (next.onboarding?.testnetFundingStage ?? "CHECKING"))
        : "DISABLED",
      testnetFundingDetail: next.onboarding?.testnetFundingDetail ?? null,
      testnetFundingUpdatedAt: next.onboarding?.testnetFundingUpdatedAt ?? null,
      testnetFundingError: next.onboarding?.testnetFundingError ?? null,
      testnetFundingDepositTx: next.onboarding?.testnetFundingDepositTx ?? null,
      welcomeDismissedAt: next.onboarding?.welcomeDismissedAt ?? null,
    },
  });
  await saveSettings(next, dataDir);
  return next;
}
