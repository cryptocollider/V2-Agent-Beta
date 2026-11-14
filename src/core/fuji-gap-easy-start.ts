import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { AgentWallet } from "../collider/wallet.js";
import { buildFujiEasyStartSettings } from "./fuji-easy-start.js";
import { loadOrCreateFujiTestWallet, type FujiTestWalletInfo } from "./fuji-test-wallet.js";
import { normalizeSettings, saveSettings, type AgentSettings } from "./settings.js";

// Isolated protocol-46 gap-closure chain. Never repoint the original week canary.
export const FUJI_GAP_DATA_DIR = "./data-rc1-gap-fresh-20261010a";
export const FUJI_GAP_CHAIN = "g6Vm94onFjVDAAE9NxsgcYfm1Uxcfc2BnuuG1rRhDJyNvTWw5";
export const FUJI_GAP_RPC = `http://127.0.0.1:10970/ext/bc/${FUJI_GAP_CHAIN}/collider_v2`;
export const FUJI_GAP_DOMAIN = "0x5f93cb676beca3347ac9e6bc8cfcb1c055049972ce9a9cfc105f094afc2882e9";
export const FUJI_GAP_CHAIN_ID = "0x58c4f93048c5ee91fa810f4727e74188570560b232b63ed938fc3112ad275b55";
export const FUJI_GAP_L1_ID = "0x3a64eac9f5eac3b3af8ad82a3468b19741511e3baa69904d98493d623e72c34e";
export const FUJI_GAP_CUSTODY = "0xad2c343733b766932105a4da1b23ea0f5a17be27";
export const FUJI_GAP_ROUTE = "0x4f8f12f975b21b741c646b13a139c77aae18e0d7c732043ae2860c49346e58f6";
export const FUJI_GAP_ATTESTOR = "0x0636e5c92d19eaff07524818999030f7a5b80b06";
export const FUJI_GAP_MONITOR_PORT = 8795;
export const FUJI_GAP_INITIAL_SESSION_CAP = 120;

const USDC = "0x" + "01".repeat(32);
const MDIEM = "0x" + "09".repeat(32);
const LINK = "0x" + "0b".repeat(32);

export function buildFujiGapSettings(wallet: Pick<FujiTestWalletInfo, "address" | "signingKeyFile">): AgentSettings {
  const base = buildFujiEasyStartSettings(wallet);
  return normalizeSettings({
    ...base,
    rpc: FUJI_GAP_RPC,
    expectedNetworkDomain: FUJI_GAP_DOMAIN,
    expectedNetworkId: 5,
    expectedL1Id: FUJI_GAP_L1_ID,
    expectedChainId: FUJI_GAP_CHAIN_ID,
    monitorPort: FUJI_GAP_MONITOR_PORT,
    maxThrowsPerSession: FUJI_GAP_INITIAL_SESSION_CAP,
    bridgeWithdrawal: {
      cRpc: "http://127.0.0.1:10960/ext/bc/C/rpc",
      expectedEvmChainId: 43113,
      custodyContract: FUJI_GAP_CUSTODY,
      routeId: FUJI_GAP_ROUTE,
      expectedAttestor: FUJI_GAP_ATTESTOR,
      assets: {
        [USDC]: {
          tokenAddress: "0x5425890298aed601595a70ab815c96711a31bc65",
          policyHash: "0x16207bb1fe20f94477d380075e58094c0f15ac8664febf86e96aebc74f1d5525",
          minWithdrawalAmount: "100000",
        },
        [MDIEM]: {
          tokenAddress: "0x5bc1cb82cb2684fe4eec76ab7feb80ba0797c20c",
          policyHash: "0x7db093c0b10f8b3098677290cb7ba0a90285d6558ce6b40485767c87597b3906",
          minWithdrawalAmount: "1000000000000000",
        },
        [LINK]: {
          tokenAddress: "0x0b9d5d9136855f6fec3c0993fee6e9ce8a297846",
          policyHash: "0x2623001f800d1be950f3ba2eeb21389facc9a5ca096fbe1ad2892849833c6515",
          minWithdrawalAmount: "10000000000000000",
        },
      },
    },
  });
}

function assertFreshPins(settings: AgentSettings): void {
  const bridge = settings.bridgeWithdrawal;
  const expected = buildFujiGapSettings({
    address: String(settings.expectedEvmAddress ?? ""),
    signingKeyFile: String(settings.signingKeyFile ?? ""),
  });
  if (settings.rpc !== FUJI_GAP_RPC
    || settings.expectedNetworkDomain !== FUJI_GAP_DOMAIN
    || settings.expectedChainId !== FUJI_GAP_CHAIN_ID
    || settings.expectedL1Id !== FUJI_GAP_L1_ID
    || settings.expectedNetworkId !== 5
    || !bridge
    || bridge.custodyContract.toLowerCase() !== FUJI_GAP_CUSTODY
    || bridge.routeId !== FUJI_GAP_ROUTE
    || bridge.expectedAttestor.toLowerCase() !== FUJI_GAP_ATTESTOR
    || bridge.expectedEvmChainId !== 43113
    || bridge.cRpc !== expected.bridgeWithdrawal?.cRpc
    || Object.keys(bridge.assets).length !== 3
    || Object.entries(expected.bridgeWithdrawal?.assets ?? {}).some(([asset, pin]) => {
      const observed = bridge.assets[asset];
      return !observed || observed.tokenAddress.toLowerCase() !== pin.tokenAddress
        || observed.policyHash !== pin.policyHash
        || observed.minWithdrawalAmount !== pin.minWithdrawalAmount;
    })) throw new Error("existing data directory is not pinned to the fresh Fuji route");
}

export async function ensureFujiGapEasyStart(
  dataDir: string,
  options: { signingKeyFile?: string | null; allowDisposableTestWallet?: boolean; workspaceDir?: string } = {},
): Promise<{ created: boolean; settings: AgentSettings; wallet: FujiTestWalletInfo | null }> {
  if (!path.basename(path.resolve(dataDir)).startsWith("data-rc1-gap-")) {
    throw new Error("fresh Fuji profile requires its own data-rc1-gap-* directory");
  }
  const file = path.join(dataDir, "settings.json");
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as AgentSettings;
    const existing = normalizeSettings(parsed);
    assertFreshPins(existing);
    return { created: false, settings: existing, wallet: null };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const entries = await readdir(dataDir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  if (entries.length) throw new Error("fresh Fuji data directory is not empty");
  const supplied = String(options.signingKeyFile ?? "").trim();
  let wallet: FujiTestWalletInfo;
  if (supplied) {
    const signingKeyFile = path.resolve(supplied);
    const loaded = await AgentWallet.load({ signingKeyFile });
    if (!loaded) throw new Error("could not load the supplied owner wallet");
    wallet = { profile: "fuji_rc1_test_wallet", address: loaded.address, signingKeyFile, created: false };
  } else if (options.allowDisposableTestWallet) {
    const hash = createHash("sha256").update(path.resolve(dataDir)).digest("hex").slice(0, 16);
    const base = String(process.env.LOCALAPPDATA ?? "").trim() || path.join(os.homedir(), ".local", "share");
    wallet = await loadOrCreateFujiTestWallet(
      path.join(base, "Collider", "Agent1", "fuji-gap-rc1", hash, "agent1.hex"),
      options.workspaceDir ?? process.cwd(),
    );
  } else {
    throw new Error("fresh Fuji start needs an owner wallet or explicit --create-disposable-test-wallet");
  }
  const settings = buildFujiGapSettings(wallet);
  await saveSettings(settings, dataDir);
  return { created: true, settings, wallet };
}
