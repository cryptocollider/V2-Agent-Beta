import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { buildFujiEasyStartSettings } from "./fuji-easy-start.js";
import { normalizeSettings, saveSettings, type AgentSettings } from "./settings.js";

export const FUJI_NATIVE_V2_DATA_DIR = "./data-rc1-native-v2-20261017a";
export const FUJI_NATIVE_V2_CHAIN = "2PwogmkNhdhcoSaZbduRADZ8yiEQcpQRTdLhKQxBC8T2n3jAyx";
export const FUJI_NATIVE_V2_RPC = `http://127.0.0.1:11450/ext/bc/${FUJI_NATIVE_V2_CHAIN}/collider_v2`;
export const FUJI_NATIVE_V2_READINESS = "http://127.0.0.1:11395/status";
export const FUJI_NATIVE_V2_DOMAIN = "0x7373a33eb682031eaab71b2f17204cc58e14726b1a15f281718e3c4ac9265db7";
export const FUJI_NATIVE_V2_CUSTODY = "0x3f0f93f79b85b7c330f36d3a84599e111280c178";
export const FUJI_NATIVE_V2_ROUTE = "0xd118e6632659c8807fea4db8a07ad41d489dd50ce1fbca6868699e98b250dee7";

/** Fresh chain means fresh history/funding journals, even when reusing an owner wallet. */
export function buildFujiNativeV2Settings(owner: AgentSettings, expectedAttestor: string): AgentSettings {
  if (!owner.expectedEvmAddress || !owner.signingKeyFile) throw new Error("native v2 profile requires an existing owner wallet");
  const defaults = buildFujiEasyStartSettings({ address: owner.expectedEvmAddress, signingKeyFile: owner.signingKeyFile });
  return normalizeSettings({
    ...defaults, ...owner,
    user: defaults.user,
    rpc: FUJI_NATIVE_V2_RPC,
    expectedNetworkDomain: FUJI_NATIVE_V2_DOMAIN, expectedNetworkId: 5,
    expectedL1Id: "0x4daa0115bea372c467b823ef77783aca1e562c4cbfe48123bddc8397bc9b6a2d",
    expectedChainId: "0xb7cb9a7dfc1c502b2e166f9fb66defef2a870a418a69e0c08ede7a1029a127d1",
    expectedSigningChainId: 43113,
    bridgeWithdrawal: {
      cRpc: "http://127.0.0.1:10960/ext/bc/C/rpc", expectedEvmChainId: 43113,
      custodyContract: FUJI_NATIVE_V2_CUSTODY, routeId: FUJI_NATIVE_V2_ROUTE, expectedAttestor,
      assets: {
        ["0x" + "01".repeat(32)]: { tokenAddress: "0x5425890298aed601595a70ab815c96711a31bc65",
          policyHash: "0xe300b199f3ff3e9f3e99ba2d69f1f8cfe61465eb25e38d2a29c21d88ce3a2769", minWithdrawalAmount: "100000" },
        ["0x" + "09".repeat(32)]: { tokenAddress: "0x5bc1cb82cb2684fe4eec76ab7feb80ba0797c20c",
          policyHash: "0x4bafd12f78976aec349c1d718bbec5a6633163a54c39b74e4fb74e02b195d058", minWithdrawalAmount: "1000000000000000" },
        ["0x3e0e0f0eedd306b23b0f386df33a36fac07cbd9e45a7ad02d1c40adedbee2e16"]: {
          tokenAddress: "0xecc6b8a90da074d16aef72230a4fda1dda4a7374",
          policyHash: "0x6e588702128dea76b5328cce68cda9fecd1185863ce2d65148eb4da5e4181cc4", minWithdrawalAmount: "10000000000000000" },
      },
    },
    asset: "09".repeat(32), allowedAssets: ["09".repeat(32)], keepAssets: ["09".repeat(32)],
    allowedGameIds: [],
    testnetAutoFunding: { ...defaults.testnetAutoFunding!, enabled: true, readinessUrl: FUJI_NATIVE_V2_READINESS },
    onboarding: { ...defaults.onboarding!, fundingStatus: "awaiting_funding", testnetFundingStage: "CHECKING" },
  });
}

export async function ensureFujiNativeV2Profile(dataDir: string): Promise<void> {
  const settings = JSON.parse(await readFile(path.join(dataDir, "settings.json"), "utf8")) as AgentSettings;
  const expected = buildFujiNativeV2Settings(settings, String(settings.bridgeWithdrawal?.expectedAttestor ?? ""));
  if (!path.basename(path.resolve(dataDir)).startsWith("data-rc1-native-v2-")
      || settings.rpc !== FUJI_NATIVE_V2_RPC || settings.expectedNetworkDomain !== FUJI_NATIVE_V2_DOMAIN
      || settings.expectedSigningChainId !== 43113
      || settings.expectedNetworkId !== 5 || settings.expectedL1Id !== expected.expectedL1Id
      || settings.expectedChainId !== expected.expectedChainId
      || settings.bridgeWithdrawal?.custodyContract.toLowerCase() !== FUJI_NATIVE_V2_CUSTODY
      || settings.bridgeWithdrawal.routeId !== FUJI_NATIVE_V2_ROUTE
      || settings.bridgeWithdrawal.cRpc !== expected.bridgeWithdrawal!.cRpc
      || settings.bridgeWithdrawal.expectedEvmChainId !== 43113
      || JSON.stringify(settings.bridgeWithdrawal.assets) !== JSON.stringify(expected.bridgeWithdrawal!.assets)
      || settings.testnetAutoFunding?.readinessUrl !== FUJI_NATIVE_V2_READINESS) {
    throw new Error("native signing v2 requires its isolated data directory and pinned profile");
  }
}

export async function createFujiNativeV2Profile(dataDir: string, owner: AgentSettings, attestor: string): Promise<AgentSettings> {
  if (!path.basename(path.resolve(dataDir)).startsWith("data-rc1-native-v2-")) throw new Error("use a fresh native-v2 data directory");
  const entries = await readdir(dataDir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  if (entries.length) throw new Error("native-v2 data directory must be empty; never reuse old journals");
  const settings = buildFujiNativeV2Settings(owner, attestor);
  await saveSettings(settings, dataDir);
  return settings;
}
