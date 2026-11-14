import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_SETTINGS } from "./settings.js";
import { ensureFujiTestnetFunding, FUJI_DIEM_ASSET, FUJI_DIEM_GRANT_AMOUNT } from "./fuji-testnet-funding.js";
import type { AgentWallet } from "../collider/wallet.js";
import { buildFujiNativeV2Settings, createFujiNativeV2Profile, ensureFujiNativeV2Profile,
  FUJI_NATIVE_V2_CUSTODY, FUJI_NATIVE_V2_RPC } from "./fuji-native-v2.js";

const owner = { ...DEFAULT_SETTINGS, expectedEvmAddress: "0x" + "11".repeat(20),
  signingKeyFile: "C:\\owner-only\\agent.hex", maxThrowsPerSession: 9340,
  maxThrowsPerGame: 22, minMillisBetweenLiveThrows: 30000 };
test("new route preserves play limits but uses independent native/funding history and all new policy pins", async () => {
  const settings = buildFujiNativeV2Settings(owner, "0x" + "22".repeat(20));
  assert.equal(settings.rpc, FUJI_NATIVE_V2_RPC);
  assert.equal(settings.expectedSigningChainId, 43113);
  assert.equal(settings.bridgeWithdrawal?.custodyContract, FUJI_NATIVE_V2_CUSTODY);
  assert.equal(settings.testnetAutoFunding?.enabled, true);
  assert.equal(settings.testnetAutoFunding?.readinessUrl, "http://127.0.0.1:11395/status");
  assert.equal(settings.maxThrowsPerSession, 9340);
  assert.equal(settings.minMillisBetweenLiveThrows, 30000);
  assert.equal(settings.maxThrowsPerGame, 22);
  assert.equal(Object.keys(settings.bridgeWithdrawal!.assets).length, 3);
  assert.ok(!Object.keys(settings.bridgeWithdrawal!.assets).some(key => key === "0x" + "0b".repeat(32)));
  const root = await mkdtemp(path.join(os.tmpdir(), "agent1-native-v2-"));
  try {
    const dir = path.join(root, "data-rc1-native-v2-test");
    await createFujiNativeV2Profile(dir, owner, "0x" + "22".repeat(20));
    await ensureFujiNativeV2Profile(dir);
    await assert.rejects(createFujiNativeV2Profile(dir, owner, "0x" + "22".repeat(20)), /empty/);
    await writeFile(path.join(dir, "settings.json"), JSON.stringify({ ...settings, rpc: "http://127.0.0.1:10970/old" }));
    await assert.rejects(ensureFujiNativeV2Profile(dir), /pinned/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("new-chain funding rejects retired dispenser scope and expired readiness before any claim or EVM send", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent1-v2-funding-gates-"));
  const settings = buildFujiNativeV2Settings(owner, "0x" + "22".repeat(20));
  const wallet = { address: owner.expectedEvmAddress, userId: settings.user } as AgentWallet;
  let requests = 0;
  const auth = { network_id: 5, domain_configured: true, network_domain: settings.expectedNetworkDomain,
    l1_id: settings.expectedL1Id, chain_id: settings.expectedChainId,
    native_intent_signing: { evm_chain_id: 43113, epoch: 0 },
    eip712: { name: "Collider V2", version: "2", uses_chain_id: true, chain_id: "43113", domain_separator_field: "salt" } };
  const health = { ready: true, network: "fuji", faucet: "test-only", asset: FUJI_DIEM_ASSET,
    collider_chain_id: "2PwogmkNhdhcoSaZbduRADZ8yiEQcpQRTdLhKQxBC8T2n3jAyx",
    custody_address: settings.bridgeWithdrawal!.custodyContract, route_id: settings.bridgeWithdrawal!.routeId,
    token: settings.bridgeWithdrawal!.assets[FUJI_DIEM_ASSET].tokenAddress,
    amount: FUJI_DIEM_GRANT_AMOUNT, gas_wei: "5000000000000000" };
  try {
    for (const wrongScope of [true, false]) {
      await assert.rejects(ensureFujiTestnetFunding({ settings, dataDir: dir, wallet, dependencies: {
        fetchFn: async (url) => {
          requests++;
          if (String(url).endsWith("/healthz")) return new Response(JSON.stringify({ ...health,
            collider_chain_id: wrongScope ? "retired-chain" : health.collider_chain_id }));
          assert.equal(String(url), settings.testnetAutoFunding!.readinessUrl);
          return new Response(JSON.stringify({ ready: true, expiresAtMs: 0, scope: {
            contract: health.custody_address, routeId: health.route_id, networkDomain: settings.expectedNetworkDomain, evmChainId: 43113 } }));
        },
        colliderRpc: { async call<T>() { return auth as T; } },
        evmRpc: { async call<T>(): Promise<T> { throw new Error("EVM must not be called before route gates pass"); } },
      } }), wrongScope ? /external dispenser/ : /stale or route-mismatched/);
    }
    assert.equal(requests, 3);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
