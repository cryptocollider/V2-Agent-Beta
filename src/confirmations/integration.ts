import { createHash } from "node:crypto";
import { readFile, writeFile, rename } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentSettings } from "../core/settings.js";
import type { ColliderClient } from "../collider/client.js";
import type { AgentWallet } from "../collider/wallet.js";
import { ConfirmationReadRpc } from "./adapter.js";
import { ConfirmationStore } from "./store.js";
import { BondedConfirmationService, CONFIRMATION_DEFAULT_BOUNDS, type ConfirmationConfig } from "./service.js";
import { CANDIDATE_WASM_SHA256, hex, RETIRED_FUJI_DOMAIN } from "./contract.js";

export async function loadBondedConfirmations(configFile: string | undefined, settings: AgentSettings,
  dataDir: string, client: ColliderClient, wallet: AgentWallet | null): Promise<BondedConfirmationService | null> {
  if (!configFile) return null; // No extra RPCs, files, signing or artifact changes without explicit opt-in.
  if (!wallet) throw new Error("confirmation service requires the existing serialized wallet");
  const supplied = JSON.parse(await readFile(configFile, "utf8")) as Partial<ConfirmationConfig>;
  const config = { ...CONFIRMATION_DEFAULT_BOUNDS, ...supplied } as ConfirmationConfig;
  if (typeof supplied.enabled !== "boolean" || !config.pins || !config.wasmPath
      || hex(config.pins.networkDomain) === RETIRED_FUJI_DOMAIN
      || config.pins.networkDomain !== settings.expectedNetworkDomain || config.pins.networkId !== settings.expectedNetworkId
      || config.pins.l1Id !== settings.expectedL1Id || config.pins.chainId !== settings.expectedChainId
      || config.pins.signingChainId !== settings.expectedSigningChainId) throw new Error("reviewed fresh confirmation route/config required");
  const [candidate, gameplay] = await Promise.all([readFile(config.wasmPath), readFile(settings.wasm)]);
  if ([candidate, gameplay].some(bytes => createHash("sha256").update(bytes).digest("hex") !== CANDIDATE_WASM_SHA256)) {
    throw new Error("future confirmation/gameplay artifacts must match the reviewed candidate");
  }
  const id = createHash("sha256").update(path.resolve(dataDir) + config.pins.networkDomain).digest("hex").slice(0, 24);
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), ".local/share");
  const store = new ConfirmationStore(path.join(local, "Collider/Agent1/private-confirmations", id));
  const service = new BondedConfirmationService(config, store, client, wallet, new ConfirmationReadRpc(settings.rpc, client),
    undefined, undefined, {
      persistEnabled: async enabled => {
        const temporary = configFile + ".pending";
        await writeFile(temporary, JSON.stringify({ ...config, enabled }, null, 2), { mode: 0o600 });
        await rename(temporary, configFile);
      },
      publish: async jobs => {
        const target = path.join(dataDir, "confirmation-receipts.json");
        await writeFile(target + ".pending", JSON.stringify({ schema: "agent1.confirmation-public-receipts.v1",
          asOf: new Date().toISOString(), user: wallet.userId, networkDomain: config.pins.networkDomain, jobs }, null, 2));
        await rename(target + ".pending", target);
      },
    });
  await service.init();
  return service;
}
