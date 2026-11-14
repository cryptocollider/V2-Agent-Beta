#!/usr/bin/env node

import path from "node:path";
import process from "node:process";

import { AgentWallet } from "../collider/wallet.js";
import { Rc1IntentStore } from "../collider/intent-store.js";
import { PendingSignedWithdrawalError, Rc1WithdrawalClient } from "../collider/withdrawal.js";
import type { BridgeWithdrawalArgs } from "../collider/types.js";
import { loadSettings } from "../core/settings.js";
import { assertPublicSettings, acquirePublicSignerLease } from "../public-rc1/profile.js";
let releasePublicLease:(()=>Promise<void>)|null=null;

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : fallback;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function cleanHex(value: unknown): string {
  return String(value ?? "").trim().replace(/^0x/i, "").toLowerCase();
}

function safeResult(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

async function main(): Promise<void> {
  const dataDir = arg("--data-dir", process.env.COLLIDER_DATA_DIR ?? "./data")!;
  const settings = await loadSettings(dataDir);
  if(settings.publicRc1){assertPublicSettings(settings);releasePublicLease=await acquirePublicSignerLease(settings,dataDir);}
  const wallet = await AgentWallet.load(settings);
  if (!wallet) throw new Error("RC1 withdrawal requires a configured Agent1 signing wallet");
  if (!settings.rpc) throw new Error("RC1 withdrawal requires settings.rpc");
  if (!settings.expectedNetworkDomain || settings.expectedNetworkId == null || !settings.expectedL1Id || !settings.expectedChainId) {
    throw new Error("RC1 withdrawal requires all Collider auth-domain pins");
  }
  const bridge = settings.bridgeWithdrawal;
  if (!bridge?.cRpc || !bridge.custodyContract || !bridge.routeId || !bridge.expectedAttestor || !Number.isSafeInteger(bridge.expectedEvmChainId)) {
    throw new Error("RC1 withdrawal requires complete bridgeWithdrawal route pins in settings.json");
  }

  const requestedAsset = arg("--asset", settings.asset)?.trim() ?? "";
  const assetEntry = Object.entries(bridge.assets).find(([asset]) => cleanHex(asset) === cleanHex(requestedAsset));
  if (!assetEntry) throw new Error("requested asset is not present in pinned bridgeWithdrawal.assets");
  const [asset, assetPin] = assetEntry;
  const client = new Rc1WithdrawalClient(settings.rpc, bridge.cRpc, wallet, {
    expectedNetworkDomain: settings.expectedNetworkDomain,
    expectedNetworkId: settings.expectedNetworkId,
    expectedL1Id: settings.expectedL1Id,
    expectedChainId: settings.expectedChainId,
    expectedEvmChainId: bridge.expectedEvmChainId,
    expectedSigningChainId: settings.expectedSigningChainId,
    custodyContract: bridge.custodyContract,
    routeId: bridge.routeId,
    expectedAttestor: bridge.expectedAttestor,
    assetPin,
    stateFile: path.join(dataDir, "rc1-withdrawal-state.json"),
    intentTtlBlocks: settings.intentTtlBlocks,
    reconcilePollMs: settings.intentReconcilePollMs,
    reconcileTimeoutMs: settings.intentReconcileTimeoutMs,
  });

  if (hasFlag("--status")) {
    const requestId = arg("--request-id")?.trim() ?? "";
    const amount = arg("--amount")?.trim() ?? "";
    const evmTxHash = arg("--evm-tx")?.trim() || null;
    if (!/^0x[0-9a-f]{64}$/i.test(requestId)) throw new Error("--request-id must be 32-byte hex");
    if (!/^\d+$/.test(amount) || BigInt(amount) <= 0n) throw new Error("--amount must be a positive exact base-unit decimal string");
    if (evmTxHash && !/^0x[0-9a-f]{64}$/i.test(evmTxHash)) throw new Error("--evm-tx must be 32-byte hex");
    console.log(safeResult(await client.observeWithdrawal({ requestId, asset, amount, evmTxHash })));
    return;
  }

  if (hasFlag("--resume")) {
    const result = await client.reconcilePendingWithdrawal(settings.intentReconcileTimeoutMs ?? 90_000);
    console.log(safeResult(result ?? { status: "no_pending_withdrawal" }));
    if (result?.status === "pending") process.exitCode = 2;
    return;
  }

  const pendingThrow = await new Rc1IntentStore(path.join(dataDir, "rc1-intent-state.json")).loadPending();
  if (pendingThrow) {
    throw new Error(`unresolved signed throw nonce ${pendingThrow.prepared.nonce}; reconcile it before starting a withdrawal`);
  }

  const amount = arg("--amount")?.trim() ?? "";
  const nonceRaw = arg("--withdrawal-nonce")?.trim() ?? "";
  const originRefId = arg("--origin-ref")?.trim() ?? "";
  if (!/^\d+$/.test(amount) || BigInt(amount) <= 0n) throw new Error("--amount must be a positive exact base-unit decimal string");
  if (!/^\d+$/.test(nonceRaw) || !Number.isSafeInteger(Number(nonceRaw))) throw new Error("--withdrawal-nonce must be a safe non-negative integer");
  if (!/^0x[0-9a-f]{64}$/i.test(originRefId)) throw new Error("--origin-ref must be 32-byte hex");

  const expected: BridgeWithdrawalArgs = {
    asset,
    user: wallet.userId,
    amount,
    withdrawalNonce: Number(nonceRaw),
    originRefId,
  };

  if (!hasFlag("--broadcast")) {
    const verified = await client.previewWithdrawal(expected);
    console.log(safeResult({
      status: "verified_dry_run",
      requestId: verified.preview.request_id,
      asset: verified.expected.asset,
      amount: verified.expected.amount,
      withdrawalNonce: verified.expected.withdrawalNonce,
      originRefId: verified.expected.originRefId,
      balanceBefore: verified.balanceBefore,
      balanceAfterReservation: (BigInt(verified.balanceBefore) - BigInt(verified.expected.amount)).toString(),
      routeId: verified.preview.route_id,
      policyHash: verified.preview.policy_hash,
      custodyDigest: verified.preview.custody_digest,
      contractDigestVerified: true,
    }));
    return;
  }

  const result = await client.requestWithdrawalSigned(expected);
  console.log(safeResult(result));
  if (result.status === "pending") process.exitCode = 2;
}

main().finally(async()=>{await releasePublicLease?.();}).catch((error) => {
  if (error instanceof PendingSignedWithdrawalError) {
    console.error(safeResult(error.result));
    process.exitCode = 2;
    return;
  }
  console.error(error);
  process.exitCode = 1;
});
