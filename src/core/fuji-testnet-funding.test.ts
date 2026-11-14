import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Interface, Transaction, Wallet } from "ethers";

import { AgentWallet } from "../collider/wallet.js";
import {
  FUJI_DIEM_ASSET,
  FUJI_DIEM_GRANT_AMOUNT,
  ensureFujiTestnetFunding,
} from "./fuji-testnet-funding.js";
import { DEFAULT_TESTNET_AUTO_FUNDING_SETTINGS, normalizeSettings } from "./settings.js";

const TOKEN = "0x1111111111111111111111111111111111111111";
const CUSTODY_ADDRESS = "0x2222222222222222222222222222222222222222";
const ERC20 = new Interface([
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner,address spender) view returns (uint256)",
  "function approve(address spender,uint256 amount) returns (bool)",
]);
const CUSTODY = new Interface([
  "function depositsEnabled(bytes32 asset) view returns (bool)",
  "function cumulativeDeposits(bytes32 asset,address recipient) view returns (uint256)",
  "function depositTo(bytes32 asset,uint256 amount,address recipient)",
]);

async function testWallet(): Promise<AgentWallet> {
  const privateKey = Wallet.createRandom().privateKey;
  const wallet = await AgentWallet.load(
    { signingKeyEnv: "TEST_KEY" },
    { TEST_KEY: privateKey },
  );
  assert.ok(wallet);
  return wallet;
}

function jsonResponse(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("Fuji onboarding claims once, deposits exactly, credits Collider, and resumes without duplicate transactions", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "agent1-fuji-funding-"));
  t.after(async () => { await rm(dataDir, { recursive: true, force: true }); });
  const wallet = await testWallet();
  const state = {
    tokenBalance: 0n,
    allowance: 0n,
    cumulative: 0n,
    nonce: 0,
    sent: [] as string[],
    failFirstSendResponse: true,
    claimStage: "",
    claimPolls: 0,
  };
  const message = [
    "Collider Fuji RC1 test-token faucet",
    "Network: Fuji C-Chain 43113",
    "Collider chain: test",
    "Wallet: " + wallet.address.toLowerCase(),
    "Nonce: " + "ab".repeat(16),
    "Issued: 1",
    "One test-only claim; no transfer or custody approval is authorized.",
  ].join("\n");
  const fetchFn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.endsWith("/healthz")) {
      return jsonResponse(200, { ready: true, network: "fuji", asset: FUJI_DIEM_ASSET, faucet: "test-only" });
    }
    if (url.includes("/v1/challenge?")) {
      return jsonResponse(200, { address: wallet.address, nonce: "ab".repeat(16), message, expires_at: 9999999999 });
    }
    if (url.endsWith("/v1/claim") && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, string>;
      assert.deepEqual(Object.keys(body).sort(), ["address", "nonce", "signature"]);
      state.claimStage = "QUEUED";
      return jsonResponse(200, {
        address: wallet.address,
        asset: FUJI_DIEM_ASSET,
        amount: FUJI_DIEM_GRANT_AMOUNT,
        gas_wei: "5000000000000000",
        stage: state.claimStage,
      });
    }
    if (url.includes("/v1/claims/")) {
      if (!state.claimStage) return jsonResponse(404, { error: "claim not found" });
      state.claimPolls += 1;
      state.claimStage = state.claimPolls === 1 ? "TOKEN_SIGNED_UNCERTAIN" : "COMPLETE";
      if (state.claimStage === "COMPLETE") state.tokenBalance = BigInt(FUJI_DIEM_GRANT_AMOUNT);
      return jsonResponse(200, {
        address: wallet.address,
        asset: FUJI_DIEM_ASSET,
        amount: FUJI_DIEM_GRANT_AMOUNT,
        gas_wei: "5000000000000000",
        stage: state.claimStage,
      });
    }
    throw new Error("unexpected fetch " + url);
  };
  const evm = {
    async call<T>(method: string, params: unknown[] = []): Promise<T> {
      if (method === "eth_chainId") return "0xa869" as T;
      if (method === "eth_getTransactionCount") return ("0x" + state.nonce.toString(16)) as T;
      if (method === "eth_gasPrice") return "0x5d21dba00" as T;
      if (method === "eth_estimateGas") return "0x186a0" as T;
      if (method === "eth_blockNumber") return "0x65" as T;
      if (method === "eth_call") {
        const request = params[0] as { to: string; data: string };
        const selector = request.data.slice(0, 10);
        if (request.to.toLowerCase() === TOKEN.toLowerCase()) {
          if (selector === ERC20.getFunction("balanceOf")!.selector) {
            return ERC20.encodeFunctionResult("balanceOf", [state.tokenBalance]) as T;
          }
          if (selector === ERC20.getFunction("allowance")!.selector) {
            return ERC20.encodeFunctionResult("allowance", [state.allowance]) as T;
          }
        }
        if (request.to.toLowerCase() === CUSTODY_ADDRESS.toLowerCase()) {
          if (selector === CUSTODY.getFunction("depositsEnabled")!.selector) {
            return CUSTODY.encodeFunctionResult("depositsEnabled", [true]) as T;
          }
          if (selector === CUSTODY.getFunction("cumulativeDeposits")!.selector) {
            return CUSTODY.encodeFunctionResult("cumulativeDeposits", [state.cumulative]) as T;
          }
        }
        throw new Error("unexpected eth_call");
      }
      if (method === "eth_sendRawTransaction") {
        const raw = String(params[0]);
        const tx = Transaction.from(raw);
        state.sent.push(tx.hash!);
        state.nonce += 1;
        if (tx.to?.toLowerCase() === TOKEN.toLowerCase()) {
          const decoded = ERC20.decodeFunctionData("approve", tx.data);
          assert.equal(String(decoded[0]).toLowerCase(), CUSTODY_ADDRESS.toLowerCase());
          assert.equal(String(decoded[1]), FUJI_DIEM_GRANT_AMOUNT);
          state.allowance = BigInt(FUJI_DIEM_GRANT_AMOUNT);
        } else {
          const decoded = CUSTODY.decodeFunctionData("depositTo", tx.data);
          assert.equal(String(decoded[0]).toLowerCase(), FUJI_DIEM_ASSET);
          assert.equal(String(decoded[1]), FUJI_DIEM_GRANT_AMOUNT);
          assert.equal(String(decoded[2]).toLowerCase(), wallet.address.toLowerCase());
          state.cumulative += BigInt(FUJI_DIEM_GRANT_AMOUNT);
          state.tokenBalance -= BigInt(FUJI_DIEM_GRANT_AMOUNT);
          state.allowance = 0n;
        }
        if (state.failFirstSendResponse) {
          state.failFirstSendResponse = false;
          throw new Error("simulated RPC timeout after accepting transaction");
        }
        return tx.hash as T;
      }
      if (method === "eth_getTransactionReceipt") {
        const txHash = String(params[0]);
        if (!state.sent.includes(txHash)) return null as T;
        return {
          status: "0x1",
          blockNumber: "0x64",
          blockHash: "0x" + "33".repeat(32),
        } as T;
      }
      throw new Error("unexpected EVM RPC " + method);
    },
  };
  const collider = {
    async call<T>(method: string): Promise<T> {
      if (method === "colliderV2.getAuthContext") {
        return { network_id: 5, domain_configured: true } as T;
      }
      if (method === "colliderV2.getBalances") {
        return { [FUJI_DIEM_ASSET]: state.cumulative.toString() } as T;
      }
      if (method === "colliderV2.getBridgeDepositCredit") {
        return { credited_cumulative_amount: state.cumulative.toString() } as T;
      }
      throw new Error("unexpected Collider RPC " + method);
    },
  };
  const settings = normalizeSettings({
    rpc: "http://127.0.0.1:10950/collider_v2",
    asset: FUJI_DIEM_ASSET,
    amount: "55555555555556",
    expectedEvmAddress: wallet.address,
    bridgeWithdrawal: {
      cRpc: "http://127.0.0.1:10960/ext/bc/C/rpc",
      expectedEvmChainId: 43113,
      custodyContract: CUSTODY_ADDRESS,
      routeId: "0x" + "44".repeat(32),
      expectedAttestor: "0x3333333333333333333333333333333333333333",
      assets: {
        [FUJI_DIEM_ASSET]: {
          tokenAddress: TOKEN,
          policyHash: "0x" + "55".repeat(32),
          minWithdrawalAmount: "1",
        },
      },
    },
    testnetAutoFunding: { ...DEFAULT_TESTNET_AUTO_FUNDING_SETTINGS, enabled: true },
  });
  const stages: string[] = [];
  const details: string[] = [];
  const dependencies = {
    fetchFn: fetchFn as typeof fetch,
    evmRpc: evm,
    colliderRpc: collider,
    sleep: async () => undefined,
  };
  const funded = await ensureFujiTestnetFunding({
    settings,
    dataDir,
    wallet,
    dependencies,
    onProgress: (progress) => {
      stages.push(progress.stage);
      if (progress.detail) details.push(progress.detail);
    },
  });
  assert.equal(funded.status, "FUNDED");
  assert.equal(funded.colliderBalance, FUJI_DIEM_GRANT_AMOUNT);
  assert.equal(state.sent.length, 2);
  assert.ok(stages.includes("CLAIM_PENDING"));
  assert.ok(details.includes("TOKEN_SIGNED_UNCERTAIN"));
  assert.ok(stages.includes("EVM_DEPOSIT_CONFIRMED"));
  assert.equal(stages.at(-1), "COMPLETE");
  const journal = JSON.parse(await readFile(path.join(dataDir, "testnet-funding-state.json"), "utf8"));
  assert.equal(journal.stage, "COMPLETE");
  assert.equal(journal.expectedCumulativeDeposit, FUJI_DIEM_GRANT_AMOUNT);
  assert.equal(journal.approval.rawTransaction.startsWith("0x"), true);
  assert.equal(journal.deposit.rawTransaction.startsWith("0x"), true);

  const resumed = await ensureFujiTestnetFunding({ settings, dataDir, wallet, dependencies });
  assert.equal(resumed.status, "FUNDED");
  assert.equal(state.sent.length, 2);
});

test("Fuji auto-funding refuses a non-loopback faucet before any request", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "agent1-fuji-public-refusal-"));
  t.after(async () => { await rm(dataDir, { recursive: true, force: true }); });
  const wallet = await testWallet();
  const settings = normalizeSettings({
    rpc: "http://127.0.0.1:10950/collider_v2",
    asset: FUJI_DIEM_ASSET,
    amount: "1",
    bridgeWithdrawal: {
      cRpc: "http://127.0.0.1:10960/ext/bc/C/rpc",
      expectedEvmChainId: 43113,
      custodyContract: CUSTODY_ADDRESS,
      routeId: "0x" + "44".repeat(32),
      expectedAttestor: "0x3333333333333333333333333333333333333333",
      assets: {
        [FUJI_DIEM_ASSET]: {
          tokenAddress: TOKEN,
          policyHash: "0x" + "55".repeat(32),
          minWithdrawalAmount: "1",
        },
      },
    },
    testnetAutoFunding: {
      ...DEFAULT_TESTNET_AUTO_FUNDING_SETTINGS,
      enabled: true,
      faucetUrl: "https://public.example/faucet",
    },
  });
  await assert.rejects(
    ensureFujiTestnetFunding({ settings, dataDir, wallet }),
    /loopback HTTP/,
  );
});
