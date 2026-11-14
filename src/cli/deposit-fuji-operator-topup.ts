#!/usr/bin/env node

// One exact, externally supplied mock-token grant. This never calls a faucet.
import { mkdir, open, readFile, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createConnection } from "node:net";
import { AgentWallet } from "../collider/wallet.js";
import {
  atomicWriteJson, CUSTODY, ERC20, FUJI_CHAIN_ID, FUJI_DIEM_ASSET,
  normalizeAddress, parseHexQuantity, readBool, readUint,
  sendAndConfirmTransaction, signStoredTransaction,
  type StoredEvmTransaction,
} from "../core/fuji-testnet-funding.js";
import { JsonRpcClient } from "../core/rpc.js";
import { loadSettings } from "../core/settings.js";
import {
  FUJI_GAP_CHAIN_ID, FUJI_GAP_CUSTODY, FUJI_GAP_DOMAIN, FUJI_GAP_L1_ID,
  FUJI_GAP_ROUTE, FUJI_GAP_RPC,
} from "../core/fuji-gap-easy-start.js";
import { ensureFujiBondedProfile, FUJI_BONDED_PINS } from "../core/fuji-bonded.js";
import { assertCapabilities } from "../confirmations/contract.js";
import type { Rc1AuthContext } from "../collider/types.js";
import { BONDED_TOPUP, assertBondedTopupLocal, assertBondedTopupOrigin, bondedAttemptReceipt } from "../core/bonded-topup.js";

const requestedCampaign = process.argv.indexOf("--campaign");
const CAMPAIGN = requestedCampaign < 0 ? "operator-diem-20261009a" : process.argv[requestedCampaign + 1];
if (!["operator-diem-20261009a", "gap-operator-diem-20261011a", BONDED_TOPUP.campaign].includes(CAMPAIGN ?? "")) {
  throw new Error("unsupported one-use operator top-up campaign");
}
const freshGap = CAMPAIGN === "gap-operator-diem-20261011a";
const bonded = CAMPAIGN === BONDED_TOPUP.campaign;
const AMOUNT = bonded ? BONDED_TOPUP.amount : freshGap ? 10000000000000000000n : 100000000000000000n;
const BASELINE = 55555555555555555n;
const WALLET = bonded ? BONDED_TOPUP.wallet : freshGap ? "0xe46ed7d9c10fa1d0d9fbc80ca3662405dd968de2"
  : "0x938d4b3aeb2ca7a8bb8ed2a66b7181a7bd725338";
const TOKEN = "0x5bc1cb82cb2684fe4eec76ab7feb80ba0797c20c";
const CUSTODY_ADDRESS = bonded ? BONDED_TOPUP.custody : freshGap ? FUJI_GAP_CUSTODY : "0xc73a331cd4d49856e95321deffabad33d5088f05";
const PORTS = bonded ? [11550, 11552, 11554, 11556, 11558] : freshGap ? [10970, 10972, 10974, 10976, 10978] : [10950, 10952, 10954, 10956, 10958];
const EXPECTED = BASELINE + AMOUNT;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const now = () => new Date();

type Journal = {
  schema: "collider.agent1.fuji-operator-topup.v1";
  campaign: typeof CAMPAIGN;
  wallet: string;
  asset: string;
  token: string;
  custody: string;
  amount: string;
  baseline: string;
  expected: string;
  stage: string;
  createdAt: string;
  updatedAt: string;
  approval?: StoredEvmTransaction;
  deposit?: StoredEvmTransaction;
};

function selectedCredit(value: Record<string, unknown>): bigint {
  const raw = String(value.credited_cumulative_amount ?? "");
  if (!/^\d+$/.test(raw)) throw new Error("invalid cumulative VM bridge credit");
  return BigInt(raw);
}

async function credits(rpcUrl: string, userId: string): Promise<bigint[]> {
  return await Promise.all(PORTS.map(async (port) => {
    const url = new URL(rpcUrl);
    if (url.hostname !== "127.0.0.1" || url.port !== String(PORTS[0]) || !url.pathname.endsWith("/collider_v2")) {
      throw new Error("unexpected primary Collider RPC pin");
    }
    url.port = String(port);
    const rpc = new JsonRpcClient(url.toString());
    if (bonded) {
      const auth = await rpc.call<Rc1AuthContext>("colliderV2.getAuthContext", [userId]);
      assertCapabilities(auth, FUJI_BONDED_PINS);
      if (!auth.user || auth.user.accepted_next_nonce !== auth.user.next_available_nonce) throw new Error("native nonce reservation requires reconciliation");
    }
    const result = await rpc.call<Record<string, unknown>>(
      "colliderV2.getBridgeDepositCredit", [FUJI_DIEM_ASSET, userId],
    );
    return selectedCredit(result);
  }));
}

async function main(): Promise<void> {
  const position = process.argv.indexOf("--data-dir");
  const dataDir = position >= 0 ? process.argv[position + 1] : undefined;
  if (!dataDir || !path.isAbsolute(dataDir)) throw new Error("--data-dir requires the absolute canary directory");
  if (freshGap && !path.basename(path.resolve(dataDir)).startsWith("data-rc1-gap-")) {
    throw new Error("fresh campaign requires its isolated data-rc1-gap-* directory");
  }
  const dryRun = process.argv.includes("--dry-run");
  const broadcast = process.argv.includes("--broadcast");
  if (dryRun === broadcast) throw new Error("specify exactly one of --dry-run or --broadcast");
  const settings = await loadSettings(dataDir);
  if (bonded) {
    await ensureFujiBondedProfile(dataDir);
    // A separate signing CLI is allowed only while the original Agent1 has exited.
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection({ host: "127.0.0.1", port: settings.monitorPort });
      socket.setTimeout(1000);
      socket.once("connect", () => { socket.destroy(); reject(new Error("stop the reconciled Agent1 before a separate EVM signer")); });
      socket.once("timeout", () => { socket.destroy(); reject(new Error("monitor singleton check timed out")); });
      socket.once("error", (error: NodeJS.ErrnoException) => error.code === "ECONNREFUSED" ? resolve() : reject(error));
    });
    const local = async (name: string) => readFile(path.join(dataDir, name), "utf8").then(JSON.parse).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null; throw error;
    });
    const [funding, native, conversion, publicReceipts] = await Promise.all([
      local("testnet-funding-state.json"), local("rc1-intent-state.json"),
      local("rc1-points-conversion-state.json"), local("confirmation-receipts.json"),
    ]);
    assertBondedTopupLocal(settings, { originalFundingStage: funding?.stage, nativePending: !!native?.pending,
      conversionPending: !!conversion?.pending, jobs: publicReceipts?.jobs?.length ?? 0 });
  }
  const wallet = await AgentWallet.load(settings);
  if (!wallet || normalizeAddress(wallet.address, "wallet") !== normalizeAddress(WALLET, "campaign wallet")) {
    throw new Error("configured signer does not match the campaign wallet");
  }
  const bridge = settings.bridgeWithdrawal;
  if (!bridge || bridge.expectedEvmChainId !== FUJI_CHAIN_ID) throw new Error("Fuji bridge pin mismatch");
  if (freshGap && (
    settings.rpc !== FUJI_GAP_RPC
    || settings.expectedNetworkDomain !== FUJI_GAP_DOMAIN
    || settings.expectedChainId !== FUJI_GAP_CHAIN_ID
    || settings.expectedL1Id !== FUJI_GAP_L1_ID
    || bridge.routeId !== FUJI_GAP_ROUTE
    || bridge.expectedAttestor.toLowerCase() !== "0x0636e5c92d19eaff07524818999030f7a5b80b06"
  )) throw new Error("fresh campaign route/auth pins mismatch");
  if (normalizeAddress(bridge.custodyContract, "custody") !== normalizeAddress(CUSTODY_ADDRESS, "campaign custody")) {
    throw new Error("custody pin mismatch");
  }
  const pin = Object.entries(bridge.assets).find(([asset]) => asset.toLowerCase().replace(/^0x/, "") === FUJI_DIEM_ASSET.slice(2))?.[1];
  if (!pin || normalizeAddress(pin.tokenAddress, "token") !== normalizeAddress(TOKEN, "campaign token")) {
    throw new Error("DIEM token pin mismatch");
  }
  if (freshGap && pin.policyHash !== "0x7db093c0b10f8b3098677290cb7ba0a90285d6558ce6b40485767c87597b3906") {
    throw new Error("fresh DIEM bridge policy pin mismatch");
  }
  const evm = new JsonRpcClient(bridge.cRpc);
  if (bonded) {
    assertBondedTopupOrigin(await evm.call("eth_getTransactionReceipt", [BONDED_TOPUP.origin]));
    const ready = await fetch("http://127.0.0.1:11396/status", { signal: AbortSignal.timeout(10000) }).then(r => r.json());
    if (!ready.ready || ready.expiresAtMs <= Date.now() || ready.scope?.contract?.toLowerCase() !== CUSTODY_ADDRESS
        || ready.scope?.routeId?.toLowerCase() !== bridge.routeId.toLowerCase()
        || ready.scope?.networkDomain !== settings.expectedNetworkDomain || ready.scope?.evmChainId !== 43113) throw new Error("bonded readiness unavailable or pin mismatch");
  }
  if (parseHexQuantity(await evm.call<string>("eth_chainId", []), "chain id") !== BigInt(FUJI_CHAIN_ID)) {
    throw new Error("C-Chain is not Fuji");
  }
  if (!await readBool(evm, CUSTODY_ADDRESS, CUSTODY, "depositsEnabled", [FUJI_DIEM_ASSET])) {
    throw new Error("DIEM deposits are disabled");
  }
  const file = path.join(dataDir, "testnet-topup-" + CAMPAIGN + ".json");
  const lockFile = path.join(dataDir, "testnet-topup-" + CAMPAIGN + ".lock");
  let journal: Journal | null = null;
  try {
    journal = JSON.parse(await readFile(file, "utf8")) as Journal;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (journal && (
    journal.schema !== "collider.agent1.fuji-operator-topup.v1" ||
    journal.campaign !== CAMPAIGN ||
    normalizeAddress(journal.wallet, "journal wallet") !== wallet.address.toLowerCase() ||
    journal.asset !== FUJI_DIEM_ASSET ||
    normalizeAddress(journal.token, "journal token") !== normalizeAddress(TOKEN, "campaign token") ||
    normalizeAddress(journal.custody, "journal custody") !== normalizeAddress(CUSTODY_ADDRESS, "campaign custody") ||
    journal.amount !== AMOUNT.toString() ||
    journal.baseline !== BASELINE.toString() ||
    journal.expected !== EXPECTED.toString()
  )) throw new Error("existing top-up journal does not match this exact campaign");
  const cumulative = await readUint(evm, CUSTODY_ADDRESS, CUSTODY, "cumulativeDeposits", [FUJI_DIEM_ASSET, wallet.address]);
  const observedCredits = await credits(settings.rpc, wallet.userId);
  if (observedCredits.some((credit) => credit !== observedCredits[0])) throw new Error("five-node bridge credit disagreement");
  if (cumulative !== BASELINE && cumulative !== EXPECTED) throw new Error("unexpected custody cumulative deposit");
  if (observedCredits[0] !== BASELINE && observedCredits[0] !== EXPECTED) throw new Error("unexpected VM cumulative credit");
  if (cumulative === EXPECTED && !journal) throw new Error("deposit already occurred without this campaign journal; reconcile manually");
  const tokenBalance = await readUint(evm, TOKEN, ERC20, "balanceOf", [wallet.address]);
  const allowance = await readUint(evm, TOKEN, ERC20, "allowance", [wallet.address, CUSTODY_ADDRESS]);
  if (allowance !== 0n && allowance !== AMOUNT) throw new Error("unexpected DIEM allowance");
  if (cumulative === BASELINE && tokenBalance !== AMOUNT) throw new Error("wallet does not hold the exact campaign grant");
  const gasBalance = parseHexQuantity(await evm.call<string>("eth_getBalance", [wallet.address, "latest"]), "wallet gas balance");
  const sendOnce = async (stored: StoredEvmTransaction, data: string, to: string, journal: Journal) => {
    if (bonded && stored.broadcastAttemptedAt) {
      // Reconcile a prior attempt by its hash, never retransmit it or sign a replacement.
      const receipt = await evm.call<any>("eth_getTransactionReceipt", [stored.txHash], { retries: 0 });
      const tip = parseHexQuantity(await evm.call<string>("eth_blockNumber", []), "EVM tip");
      stored.receipt = bondedAttemptReceipt(stored, receipt, tip);
      await atomicWriteJson(file, journal);
    }
    return sendAndConfirmTransaction({ stored, journal, journalFile: file, wallet, evm, to, data,
      confirmations: settings.testnetAutoFunding?.evmConfirmations ?? 2, now, sleep });
  };
  console.log(JSON.stringify({
    campaign: CAMPAIGN, mode: dryRun ? "dry-run" : "broadcast",
    cumulative: cumulative.toString(), credit: observedCredits[0].toString(),
    tokenBalance: tokenBalance.toString(), allowance: allowance.toString(),
    gasWei: gasBalance.toString(), existingJournal: !!journal,
    approvalTx: journal?.approval?.txHash ?? null, depositTx: journal?.deposit?.txHash ?? null,
  }));
  if (dryRun) return;
  if (gasBalance < 100000000000000n && cumulative === BASELINE) throw new Error("insufficient Fuji gas for a safe approval/deposit attempt");
  await mkdir(dataDir, { recursive: true });
  const lock = await open(lockFile, "wx");
  try {
    if (!journal) {
      journal = {
        schema: "collider.agent1.fuji-operator-topup.v1", campaign: CAMPAIGN,
        wallet: wallet.address, asset: FUJI_DIEM_ASSET, token: TOKEN, custody: CUSTODY_ADDRESS,
        amount: AMOUNT.toString(), baseline: BASELINE.toString(), expected: EXPECTED.toString(),
        stage: "PREFLIGHT", createdAt: now().toISOString(), updatedAt: now().toISOString(),
      };
      await atomicWriteJson(file, journal);
    }
    const save = async (stage: string): Promise<void> => {
      journal!.stage = stage;
      journal!.updatedAt = now().toISOString();
      await atomicWriteJson(file, journal);
    };
    if (cumulative === BASELINE) {
      if (!journal.approval && !journal.deposit) {
        const latest = await evm.call<string>("eth_getTransactionCount", [wallet.address, "latest"]);
        const pending = await evm.call<string>("eth_getTransactionCount", [wallet.address, "pending"]);
        if (latest !== pending) throw new Error("wallet has an unrelated pending EVM transaction");
      }
      if (allowance === 0n) {
        const data = ERC20.encodeFunctionData("approve", [CUSTODY_ADDRESS, AMOUNT]);
        journal.approval ??= await signStoredTransaction({ kind: "approval", wallet, evm, to: TOKEN, data, now });
        await save("APPROVAL_SIGNED");
        await sendOnce(journal.approval, data, TOKEN, journal);
        if (await readUint(evm, TOKEN, ERC20, "allowance", [wallet.address, CUSTODY_ADDRESS]) !== AMOUNT) {
          throw new Error("exact approval did not settle");
        }
        await save("APPROVAL_CONFIRMED");
      }
      const data = CUSTODY.encodeFunctionData("depositTo", [FUJI_DIEM_ASSET, AMOUNT, wallet.address]);
      journal.deposit ??= await signStoredTransaction({ kind: "deposit", wallet, evm, to: CUSTODY_ADDRESS, data, now });
      await save("DEPOSIT_SIGNED");
      await sendOnce(journal.deposit, data, CUSTODY_ADDRESS, journal);
      await save("DEPOSIT_CONFIRMED");
    }
    if (await readUint(evm, CUSTODY_ADDRESS, CUSTODY, "cumulativeDeposits", [FUJI_DIEM_ASSET, wallet.address]) !== EXPECTED) {
      throw new Error("custody cumulative deposit did not reach exact campaign target");
    }
    const deadline = Date.now() + 10 * 60_000;
    while (true) {
      const values = await credits(settings.rpc, wallet.userId);
      if (values.every((credit) => credit === EXPECTED)) break;
      if (values.some((credit) => credit > EXPECTED)) throw new Error("bridge credit exceeded exact campaign target");
      if (Date.now() >= deadline) throw new Error("five-node VM credit pending; reconcile same journal later");
      await sleep(3000);
    }
    await save("COMPLETE");
    console.log(JSON.stringify({ campaign: CAMPAIGN, stage: journal.stage, approvalTx: journal.approval?.txHash ?? null,
      depositTx: journal.deposit?.txHash ?? null, fiveNodeCredit: EXPECTED.toString() }));
  } finally {
    await lock.close();
    await rm(lockFile, { force: true });
  }
}

main().catch((error) => {
  console.error(String(error));
  process.exitCode = 1;
});
