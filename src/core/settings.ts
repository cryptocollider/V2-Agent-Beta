import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { normalizeMapPriorities } from "./map-priority.js";
import type { DoctrinePackId, GoalWeights } from "./agent-profile.js";
import type { BridgeWithdrawalSettings } from "../collider/types.js";

// Retained only for historical fixtures and beta-log research. RC1 defaults do
// not select or fund these synthetic assets.
export const BETA_USDC_ASSET = "0101010101010101010101010101010101010101010101010101010101010101";
export const BETA_CLC_ASSET = "0303030303030303030303030303030303030303030303030303030303030303";
export const BETA_DEFAULT_THROW_AMOUNT = "11000000";
export const BETA_TEST_TOKEN_AMOUNT = "1000000000";
export const BETA_DEFAULT_THROW_AMOUNT_DISPLAY = "11";
export const BETA_TEST_TOKEN_AMOUNT_DISPLAY = "1000";

export type Rc1FundingStatus =
  | "wallet_unconfigured"
  | "rpc_unconfigured"
  | "rpc_incompatible"
  | "awaiting_funding"
  | "funded";

export type TestnetFundingStage =
  | "DISABLED"
  | "CHECKING"
  | "CLAIM_PENDING"
  | "CLAIM_COMPLETE"
  | "APPROVAL_PENDING"
  | "APPROVAL_CONFIRMED"
  | "DEPOSIT_PENDING"
  | "EVM_DEPOSIT_CONFIRMED"
  | "COLLIDER_CREDIT_PENDING"
  | "COMPLETE"
  | "AMBIGUOUS"
  | "FAILED"
  | "AWAITING_FAUCET_SETUP";

export type TestnetAutoFundingSettings = {
  enabled: boolean;
  profile: "fuji_rc1_loopback" | "fuji_rc1_public_20261104";
  faucetUrl: string;
  readinessUrl?: string | null;
  claimPollMs: number;
  claimTimeoutMs: number;
  creditPollMs: number;
  creditTimeoutMs: number;
  evmConfirmations: number;
  defaultThrowAmount: string;
};

export type AgentOnboardingSettings = {
  profile: "rc1_wallet";
  bootstrapVersion: number;
  walletAddress: string | null;
  walletConfiguredAt: string | null;
  fundingStatus: Rc1FundingStatus;
  fundingCheckedAt: string | null;
  fundingError: string | null;
  testnetFundingStage: TestnetFundingStage;
  testnetFundingDetail: string | null;
  testnetFundingUpdatedAt: string | null;
  testnetFundingError: string | null;
  testnetFundingDepositTx: string | null;
  welcomeDismissedAt: string | null;
};

export type HumanLearningSettings = {
  enabled: boolean;
  learnOwnManualThrows: boolean;
  addresses: string[];
  maxSeedsPerCycle: number | null;
};

export type AgentSettings = {
  rpc: string;
  wasm: string;
  user: string;
  signingKeyFile?: string | null;
  signingKeyEnv?: string;
  signingKeyPasswordEnv?: string;
  expectedEvmAddress?: string | null;
  expectedNetworkDomain?: string | null;
  expectedNetworkId?: number | null;
  expectedL1Id?: string | null;
  expectedChainId?: string | null;
  expectedSigningChainId?: number | null;
  bridgeWithdrawal?: BridgeWithdrawalSettings | null;
  intentTtlBlocks?: number;
  intentReconcilePollMs?: number;
  intentReconcileTimeoutMs?: number;
  logTailLimit?: number;
  maxActiveLogBytes?: number;
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
  maxSingleThrowBase?: string;
  riskMode?: "defensive" | "balanced" | "aggressive";
  doctrinePack?: DoctrinePackId | null;
  goalWeights?: GoalWeights | null;
  customStrategy?: string | null;
  copySlammerWhenSameHoleType?: boolean;
  allowedGameIds?: string[];
  mapPriorities?: Record<string, number>;
  allowedAssets?: string[];
  blockedAssets?: string[];
  reserveBalanceBase?: string;
  targetBalanceUsd?: number | null;
  targetProfitUsd?: number | null;
  keepAssets?: string[];
  disposeAssets?: string[];
  baselineResetThrows?: number | null;
  testnetAutoFunding?: TestnetAutoFundingSettings | null;
  onboarding?: AgentOnboardingSettings | null;
  humanLearning?: HumanLearningSettings | null;
  publicRc1?: { profile:"fuji_rc1_public_20261104"; ownerWallet:string; ownerSourceDir:string;
    faucetOperatorProofFile:string|null; artifactSha256:string; depositAmountBase:string; gasReserveWei:string } | null;
};

export const DEFAULT_ONBOARDING_SETTINGS: AgentOnboardingSettings = {
  profile: "rc1_wallet",
  bootstrapVersion: 2,
  walletAddress: null,
  walletConfiguredAt: null,
  fundingStatus: "wallet_unconfigured",
  fundingCheckedAt: null,
  fundingError: null,
  testnetFundingStage: "DISABLED",
  testnetFundingDetail: null,
  testnetFundingUpdatedAt: null,
  testnetFundingError: null,
  testnetFundingDepositTx: null,
  welcomeDismissedAt: null,
};

export const DEFAULT_TESTNET_AUTO_FUNDING_SETTINGS: TestnetAutoFundingSettings = {
  enabled: false,
  profile: "fuji_rc1_loopback",
  faucetUrl: "http://127.0.0.1:11440",
  claimPollMs: 2_000,
  claimTimeoutMs: 15 * 60_000,
  creditPollMs: 3_000,
  creditTimeoutMs: 10 * 60_000,
  evmConfirmations: 2,
  defaultThrowAmount: "55555555555556",
};

export const DEFAULT_HUMAN_LEARNING_SETTINGS: HumanLearningSettings = {
  enabled: true,
  learnOwnManualThrows: true,
  addresses: [],
  maxSeedsPerCycle: 12,
};

export const DEFAULT_SETTINGS: AgentSettings = {
  rpc: "",
  wasm: "./assets/sim_core.wasm",
  user: "",
  signingKeyFile: null,
  signingKeyEnv: "COLLIDER_AGENT_PRIVATE_KEY",
  signingKeyPasswordEnv: "COLLIDER_AGENT_KEY_PASSWORD",
  expectedEvmAddress: null,
  expectedNetworkDomain: null,
  expectedNetworkId: null,
  expectedL1Id: null,
  expectedChainId: null,
  bridgeWithdrawal: null,
  intentTtlBlocks: 32,
  intentReconcilePollMs: 1_500,
  intentReconcileTimeoutMs: 90_000,
  logTailLimit: 500,
  maxActiveLogBytes: 64 * 1024 * 1024,
  asset: "",
  amount: "0",
  maxCandidates: 150,
  maxMs: 20000,
  pollMs: 15000,
  maxThrowsPerGame: 50,
  maxThrowsPerSession: 5000,
  minMillisBetweenLiveThrows: 20000,
  monitorPort: 8787,
  minGameStakeUsd: 0,
  maxSingleThrowUsd: 12,
  maxGameExposureUsd: 20000,
  minThrowUsd: 2,
  maxThrowUsd: 12,
  maxSingleThrowBase: "0",
  riskMode: "balanced",
  doctrinePack: "baseline",
  goalWeights: null,
  customStrategy: null,
  copySlammerWhenSameHoleType: false,
  allowedGameIds: [],
  mapPriorities: {},
  allowedAssets: [],
  blockedAssets: [],
  reserveBalanceBase: "0",
  targetBalanceUsd: null,
  targetProfitUsd: null,
  keepAssets: [],
  disposeAssets: [],
  baselineResetThrows: 24,
  testnetAutoFunding: { ...DEFAULT_TESTNET_AUTO_FUNDING_SETTINGS },
  onboarding: { ...DEFAULT_ONBOARDING_SETTINGS },
  humanLearning: { ...DEFAULT_HUMAN_LEARNING_SETTINGS },
};

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => String(entry ?? "").trim()).filter(Boolean);
}

function normalizeNullableNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeNullableInteger(value: unknown): number | null {
  const numeric = normalizeNullableNumber(value);
  return numeric != null && Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : null;
}

function normalizePositiveInteger(value: unknown, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0 ? Math.min(numeric, max) : fallback;
}

function normalizeNullableString(value: unknown): string | null {
  const trimmed = String(value ?? "").trim();
  return trimmed ? trimmed : null;
}

function normalizeBridgeWithdrawalSettings(value: BridgeWithdrawalSettings | null | undefined): BridgeWithdrawalSettings | null {
  if (!value || typeof value !== "object") return null;
  const assets = Object.fromEntries(Object.entries(value.assets ?? {}).map(([asset, pin]) => [
    String(asset).trim().toLowerCase(),
    {
      tokenAddress: String(pin?.tokenAddress ?? "").trim(),
      policyHash: String(pin?.policyHash ?? "").trim(),
      minWithdrawalAmount: String(pin?.minWithdrawalAmount ?? "").trim(),
    },
  ]));
  return {
    cRpc: String(value.cRpc ?? "").trim(),
    expectedEvmChainId: Number(value.expectedEvmChainId),
    custodyContract: String(value.custodyContract ?? "").trim(),
    routeId: String(value.routeId ?? "").trim(),
    expectedAttestor: String(value.expectedAttestor ?? "").trim(),
    assets,
  };
}

function normalizeUnifiedMaxThrowUsd(...values: Array<unknown>): number | null {
  const normalized = values
    .map((value) => normalizeNullableNumber(value))
    .filter((value): value is number => value != null);
  if (!normalized.length) return null;
  return Math.min(...normalized);
}

function normalizeFundingStatus(value: unknown): Rc1FundingStatus {
  switch (String(value ?? "")) {
    case "rpc_unconfigured":
    case "rpc_incompatible":
    case "awaiting_funding":
    case "funded":
      return String(value) as Rc1FundingStatus;
    default:
      return "wallet_unconfigured";
  }
}

function normalizeOnboardingSettings(value: Partial<AgentOnboardingSettings> | null | undefined): AgentOnboardingSettings {
  const stage = String(value?.testnetFundingStage ?? "DISABLED") as TestnetFundingStage;
  const allowedStages = new Set<TestnetFundingStage>([
    "DISABLED", "CHECKING", "CLAIM_PENDING", "CLAIM_COMPLETE", "APPROVAL_PENDING",
    "APPROVAL_CONFIRMED", "DEPOSIT_PENDING", "EVM_DEPOSIT_CONFIRMED",
    "COLLIDER_CREDIT_PENDING", "COMPLETE", "AMBIGUOUS", "FAILED", "AWAITING_FAUCET_SETUP",
  ]);
  return {
    ...DEFAULT_ONBOARDING_SETTINGS,
    ...(value ?? {}),
    profile: "rc1_wallet",
    bootstrapVersion: 2,
    walletAddress: normalizeNullableString(value?.walletAddress),
    walletConfiguredAt: normalizeNullableString(value?.walletConfiguredAt),
    fundingStatus: normalizeFundingStatus(value?.fundingStatus),
    fundingCheckedAt: normalizeNullableString(value?.fundingCheckedAt),
    fundingError: normalizeNullableString(value?.fundingError),
    testnetFundingStage: allowedStages.has(stage) ? stage : "DISABLED",
    testnetFundingDetail: normalizeNullableString(value?.testnetFundingDetail),
    testnetFundingUpdatedAt: normalizeNullableString(value?.testnetFundingUpdatedAt),
    testnetFundingError: normalizeNullableString(value?.testnetFundingError),
    testnetFundingDepositTx: normalizeNullableString(value?.testnetFundingDepositTx),
    welcomeDismissedAt: normalizeNullableString(value?.welcomeDismissedAt),
  };
}

function normalizeTestnetAutoFundingSettings(
  value: Partial<TestnetAutoFundingSettings> | null | undefined,
): TestnetAutoFundingSettings {
  return {
    ...DEFAULT_TESTNET_AUTO_FUNDING_SETTINGS,
    ...(value ?? {}),
    enabled: value?.enabled == null ? DEFAULT_TESTNET_AUTO_FUNDING_SETTINGS.enabled : !!value.enabled,
    profile: value?.profile === "fuji_rc1_public_20261104" ? "fuji_rc1_public_20261104" : "fuji_rc1_loopback",
    faucetUrl: String(value?.faucetUrl ?? DEFAULT_TESTNET_AUTO_FUNDING_SETTINGS.faucetUrl).trim(),
    readinessUrl: normalizeNullableString(value?.readinessUrl),
    claimPollMs: normalizePositiveInteger(value?.claimPollMs, DEFAULT_TESTNET_AUTO_FUNDING_SETTINGS.claimPollMs, 60_000),
    claimTimeoutMs: normalizePositiveInteger(value?.claimTimeoutMs, DEFAULT_TESTNET_AUTO_FUNDING_SETTINGS.claimTimeoutMs, 60 * 60_000),
    creditPollMs: normalizePositiveInteger(value?.creditPollMs, DEFAULT_TESTNET_AUTO_FUNDING_SETTINGS.creditPollMs, 60_000),
    creditTimeoutMs: normalizePositiveInteger(value?.creditTimeoutMs, DEFAULT_TESTNET_AUTO_FUNDING_SETTINGS.creditTimeoutMs, 60 * 60_000),
    evmConfirmations: normalizePositiveInteger(value?.evmConfirmations, DEFAULT_TESTNET_AUTO_FUNDING_SETTINGS.evmConfirmations, 32),
    defaultThrowAmount: /^\d+$/.test(String(value?.defaultThrowAmount ?? "").trim())
      ? String(value?.defaultThrowAmount).trim()
      : DEFAULT_TESTNET_AUTO_FUNDING_SETTINGS.defaultThrowAmount,
  };
}

function normalizeHumanLearningSettings(value: Partial<HumanLearningSettings> | null | undefined): HumanLearningSettings {
  return {
    ...DEFAULT_HUMAN_LEARNING_SETTINGS,
    ...(value ?? {}),
    enabled: value?.enabled == null ? DEFAULT_HUMAN_LEARNING_SETTINGS.enabled : !!value.enabled,
    learnOwnManualThrows: value?.learnOwnManualThrows == null
      ? DEFAULT_HUMAN_LEARNING_SETTINGS.learnOwnManualThrows
      : !!value.learnOwnManualThrows,
    addresses: normalizeStringArray(value?.addresses),
    maxSeedsPerCycle: normalizeNullableNumber(value?.maxSeedsPerCycle) ?? DEFAULT_HUMAN_LEARNING_SETTINGS.maxSeedsPerCycle,
  };
}

export function normalizeSettings(settings: Partial<AgentSettings> | null | undefined): AgentSettings {
  const allowedGameIds = normalizeStringArray(settings?.allowedGameIds);
  const allowedAssets = normalizeStringArray(settings?.allowedAssets);
  const merged = { ...DEFAULT_SETTINGS, ...(settings ?? {}) };
  const unifiedMaxThrowUsd = normalizeUnifiedMaxThrowUsd(merged.maxThrowUsd, merged.maxSingleThrowUsd);
  return {
    ...DEFAULT_SETTINGS,
    ...(settings ?? {}),
    rpc: String(settings?.rpc ?? DEFAULT_SETTINGS.rpc).trim(),
    wasm: String(settings?.wasm ?? DEFAULT_SETTINGS.wasm).trim(),
    user: String(settings?.user ?? DEFAULT_SETTINGS.user).trim(),
    signingKeyFile: normalizeNullableString(settings?.signingKeyFile),
    signingKeyEnv: String(settings?.signingKeyEnv ?? DEFAULT_SETTINGS.signingKeyEnv).trim() || DEFAULT_SETTINGS.signingKeyEnv,
    signingKeyPasswordEnv: String(settings?.signingKeyPasswordEnv ?? DEFAULT_SETTINGS.signingKeyPasswordEnv).trim() || DEFAULT_SETTINGS.signingKeyPasswordEnv,
    expectedEvmAddress: normalizeNullableString(settings?.expectedEvmAddress),
    expectedNetworkDomain: normalizeNullableString(settings?.expectedNetworkDomain),
    expectedNetworkId: normalizeNullableInteger(settings?.expectedNetworkId),
    expectedL1Id: normalizeNullableString(settings?.expectedL1Id),
    expectedChainId: normalizeNullableString(settings?.expectedChainId),
    expectedSigningChainId: normalizeNullableInteger(settings?.expectedSigningChainId),
    bridgeWithdrawal: normalizeBridgeWithdrawalSettings(settings?.bridgeWithdrawal),
    intentTtlBlocks: normalizePositiveInteger(settings?.intentTtlBlocks, DEFAULT_SETTINGS.intentTtlBlocks ?? 32, 100_000),
    intentReconcilePollMs: normalizePositiveInteger(settings?.intentReconcilePollMs, DEFAULT_SETTINGS.intentReconcilePollMs ?? 1_500, 60_000),
    intentReconcileTimeoutMs: normalizePositiveInteger(settings?.intentReconcileTimeoutMs, DEFAULT_SETTINGS.intentReconcileTimeoutMs ?? 90_000, 600_000),
    logTailLimit: normalizePositiveInteger(settings?.logTailLimit, DEFAULT_SETTINGS.logTailLimit ?? 500, 10_000),
    maxActiveLogBytes: normalizePositiveInteger(settings?.maxActiveLogBytes, DEFAULT_SETTINGS.maxActiveLogBytes ?? 64 * 1024 * 1024),
    asset: String(settings?.asset ?? DEFAULT_SETTINGS.asset).trim(),
    amount: String(settings?.amount ?? DEFAULT_SETTINGS.amount).trim(),
    maxCandidates: Number(settings?.maxCandidates ?? DEFAULT_SETTINGS.maxCandidates) || DEFAULT_SETTINGS.maxCandidates,
    maxMs: Number(settings?.maxMs ?? DEFAULT_SETTINGS.maxMs) || DEFAULT_SETTINGS.maxMs,
    pollMs: Number(settings?.pollMs ?? DEFAULT_SETTINGS.pollMs) || DEFAULT_SETTINGS.pollMs,
    maxThrowsPerGame: Number(settings?.maxThrowsPerGame ?? DEFAULT_SETTINGS.maxThrowsPerGame) || DEFAULT_SETTINGS.maxThrowsPerGame,
    maxThrowsPerSession: Number(settings?.maxThrowsPerSession ?? DEFAULT_SETTINGS.maxThrowsPerSession) || DEFAULT_SETTINGS.maxThrowsPerSession,
    minMillisBetweenLiveThrows: Number(settings?.minMillisBetweenLiveThrows ?? DEFAULT_SETTINGS.minMillisBetweenLiveThrows) || DEFAULT_SETTINGS.minMillisBetweenLiveThrows,
    monitorPort: Number(settings?.monitorPort ?? DEFAULT_SETTINGS.monitorPort) || DEFAULT_SETTINGS.monitorPort,
    minGameStakeUsd: normalizeNullableNumber(settings?.minGameStakeUsd),
    maxSingleThrowUsd: unifiedMaxThrowUsd,
    maxGameExposureUsd: normalizeNullableNumber(settings?.maxGameExposureUsd),
    minThrowUsd: normalizeNullableNumber(settings?.minThrowUsd),
    maxThrowUsd: unifiedMaxThrowUsd,
    maxSingleThrowBase: /^\d+$/.test(String(settings?.maxSingleThrowBase ?? "0").trim())
      ? String(settings?.maxSingleThrowBase ?? "0").trim() : "0",
    riskMode: settings?.riskMode ?? DEFAULT_SETTINGS.riskMode,
    doctrinePack: settings?.doctrinePack ?? DEFAULT_SETTINGS.doctrinePack,
    goalWeights: settings?.goalWeights ?? DEFAULT_SETTINGS.goalWeights,
    customStrategy: normalizeNullableString(settings?.customStrategy),
    copySlammerWhenSameHoleType: settings?.copySlammerWhenSameHoleType == null
      ? !!DEFAULT_SETTINGS.copySlammerWhenSameHoleType
      : !!settings.copySlammerWhenSameHoleType,
    allowedGameIds,
    mapPriorities: normalizeMapPriorities(settings?.mapPriorities),
    allowedAssets: allowedAssets.length ? allowedAssets : [...(DEFAULT_SETTINGS.allowedAssets ?? [])],
    blockedAssets: normalizeStringArray(settings?.blockedAssets),
    reserveBalanceBase: String(settings?.reserveBalanceBase ?? DEFAULT_SETTINGS.reserveBalanceBase ?? "0").trim() || "0",
    targetBalanceUsd: normalizeNullableNumber(settings?.targetBalanceUsd),
    targetProfitUsd: normalizeNullableNumber(settings?.targetProfitUsd),
    keepAssets: normalizeStringArray(settings?.keepAssets),
    disposeAssets: normalizeStringArray(settings?.disposeAssets),
    baselineResetThrows: normalizeNullableNumber(settings?.baselineResetThrows) ?? DEFAULT_SETTINGS.baselineResetThrows,
    testnetAutoFunding: normalizeTestnetAutoFundingSettings(settings?.testnetAutoFunding),
    onboarding: normalizeOnboardingSettings(settings?.onboarding),
    humanLearning: normalizeHumanLearningSettings(settings?.humanLearning),
  };
}

export async function loadSettings(dataDir = "./data"): Promise<AgentSettings> {
  await mkdir(dataDir, { recursive: true });
  const file = path.join(dataDir, "settings.json");

  try {
    const txt = await readFile(file, "utf8");
    const parsed = JSON.parse(txt) as Partial<AgentSettings>;
    return normalizeSettings(parsed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Settings could not be loaded safely; existing profile was preserved");
    await saveSettings(DEFAULT_SETTINGS, dataDir);
    return normalizeSettings(DEFAULT_SETTINGS);
  }
}

export async function saveSettings(settings: AgentSettings, dataDir = "./data"): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const file = path.join(dataDir, "settings.json");
  await writeFile(file, JSON.stringify(normalizeSettings(settings), null, 2), "utf8");
}
