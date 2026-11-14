import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildFujiEasyStartSettings } from "./fuji-easy-start.js";
import { normalizeSettings, saveSettings, type AgentSettings } from "./settings.js";
import { CONFIRMATION_DEFAULT_BOUNDS } from "../confirmations/service.js";
import { CANDIDATE_WASM_SHA256, CLC_ASSET } from "../confirmations/contract.js";

export const FUJI_BONDED_DATA_DIR = "./data-rc1-bonded-20261021a";
export const FUJI_BONDED_CHAIN = "2eptdaEYvBtpw33aCSb8QDVPKVkd3VLMg1GVQARX3sKEKeihUb";
export const FUJI_BONDED_RPC = "http://127.0.0.1:11550/ext/bc/" + FUJI_BONDED_CHAIN + "/collider_v2";
export const FUJI_BONDED_DOMAIN = "0x226c56613af0707eab7d4532282691a6d2cc78ce99f179d5068ebeb5adb32277";
export const FUJI_BONDED_PINS = { networkId: 5,
  l1Id: "0xd39ac55da0b30556c2c3623a93f9b4db65a6a4f513b168bc917550beb8dcca61",
  chainId: "0xd9957e47e9391f31a63dbc2ed8a4f073a2a6e5c4b12801d5d12b7f3f965e61e7",
  networkDomain: FUJI_BONDED_DOMAIN, signingChainId: 43113 };
const CUSTODY = "0x214b60558281d87f4e272baf3348ddf2bd8c8ebf";
const ROUTE = "0x6890a9a191c0476680cedffdf81bd86b355a434be187c58b3d92b5494fd15312";
const ATTESTOR = "0x50ab2ac2b466f1ee235a585a37f3a4af7e03ddb1";
const WASM = "./assets/confirmations/v2-20261020/sim_core.wasm";
export function buildFujiBondedSettings(owner: AgentSettings): AgentSettings {
  if (!owner.expectedEvmAddress || !owner.signingKeyFile) throw new Error("bonded profile requires the existing Agent1-owned wallet");
  const defaults = buildFujiEasyStartSettings({ address: owner.expectedEvmAddress, signingKeyFile: owner.signingKeyFile });
  return normalizeSettings({ ...defaults, ...owner, rpc: FUJI_BONDED_RPC, wasm: WASM, user: defaults.user,
    expectedNetworkId: 5, expectedNetworkDomain: FUJI_BONDED_DOMAIN, expectedL1Id: FUJI_BONDED_PINS.l1Id,
    expectedChainId: FUJI_BONDED_PINS.chainId, expectedSigningChainId: 43113,
    bridgeWithdrawal: { cRpc: "http://127.0.0.1:10960/ext/bc/C/rpc", expectedEvmChainId: 43113,
      custodyContract: CUSTODY, routeId: ROUTE, expectedAttestor: ATTESTOR, assets: {
        [CLC_ASSET]: { tokenAddress: "0xecc6b8a90da074d16aef72230a4fda1dda4a7374",
          policyHash: "0x20364092c47473a1042b8a1b6995414803cbe65a7d7566dc16f5f8339ab29321", minWithdrawalAmount: "10000000000000000" },
        ["0x" + "01".repeat(32)]: { tokenAddress: "0x5425890298aed601595a70ab815c96711a31bc65",
          policyHash: "0xf77aafeb39f5f425c7c92f99ea4d520aba208c6ce0fe601fcccb61ad1eb95bcb", minWithdrawalAmount: "100000" },
        ["0x" + "09".repeat(32)]: { tokenAddress: "0x5bc1cb82cb2684fe4eec76ab7feb80ba0797c20c",
          policyHash: "0x31f11448bbe7f74f01946d5862e10333904e7d8fe20a5ca17f1a8a0172422b13", minWithdrawalAmount: "1000000000000000" },
      } },
    asset: "09".repeat(32), allowedAssets: ["09".repeat(32)], keepAssets: ["09".repeat(32)], allowedGameIds: [],
    testnetAutoFunding: { ...defaults.testnetAutoFunding!, enabled: true,
      faucetUrl: "http://127.0.0.1:11441", readinessUrl: "http://127.0.0.1:11396/status" },
    onboarding: { ...defaults.onboarding!, fundingStatus: "awaiting_funding", testnetFundingStage: "CHECKING" },
  });
}
export async function createFujiBondedProfile(dataDir: string, owner: AgentSettings, publicManifestPath: string): Promise<AgentSettings> {
  if (!path.basename(path.resolve(dataDir)).startsWith("data-rc1-bonded-")) throw new Error("use an isolated bonded data directory");
  const entries = await readdir(dataDir).catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return []; throw e; });
  if (entries.length) throw new Error("bonded data directory must be empty; never copy old journals");
  const manifest = JSON.parse(await readFile(publicManifestPath, "utf8"));
  if (manifest.network_id !== 5 || manifest.blockchain_id !== FUJI_BONDED_CHAIN
      || manifest.wasm_sha256 !== CANDIDATE_WASM_SHA256
      || manifest.genesis_sha256 !== "246fb6f2a4d387513af00a76cc81f0af5788c7cf6b22b669f694517d6f0e93da"
      || manifest.plugin_sha256 !== "dbf4730fc0f49ea0b2ccda7261798dac15e7e56e9e1d2238eae335fb9d3412e4"
      || manifest.bridge_route?.custody_contract?.toLowerCase() !== CUSTODY) throw new Error("reviewed bonded deployment manifest mismatch");
  const settings = buildFujiBondedSettings(owner);
  await saveSettings(settings, dataDir);
  await writeFile(path.join(dataDir, "bonded-confirmations.json"), JSON.stringify({ ...CONFIRMATION_DEFAULT_BOUNDS,
    enabled: false, pins: FUJI_BONDED_PINS, wasmPath: WASM,
    clcToken: settings.bridgeWithdrawal!.assets[CLC_ASSET].tokenAddress }, null, 2));
  return settings;
}
export async function ensureFujiBondedProfile(dataDir: string): Promise<void> {
  const settings = JSON.parse(await readFile(path.join(dataDir, "settings.json"), "utf8")) as AgentSettings;
  const expected = buildFujiBondedSettings(settings);
  const keys = ["rpc", "wasm", "expectedNetworkId", "expectedNetworkDomain", "expectedL1Id", "expectedChainId",
    "expectedSigningChainId", "bridgeWithdrawal"] as const;
  if (!path.basename(path.resolve(dataDir)).startsWith("data-rc1-bonded-")
      || settings.user.replace(/^0x/, "").toLowerCase() !== expected.user.replace(/^0x/, "").toLowerCase()
      || keys.some(key => JSON.stringify(settings[key]) !== JSON.stringify(expected[key]))
      || settings.testnetAutoFunding?.faucetUrl !== expected.testnetAutoFunding?.faucetUrl
      || settings.testnetAutoFunding?.readinessUrl !== expected.testnetAutoFunding?.readinessUrl) throw new Error("bonded route/profile pins mismatch");
}
