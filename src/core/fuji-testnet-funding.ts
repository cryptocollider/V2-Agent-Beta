import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  getAddress,
  Interface,
  keccak256,
  Transaction,
  type TransactionRequest,
} from "ethers";

import { AgentWallet } from "../collider/wallet.js";
import { assertNativeSigningContext } from "../collider/native-signing.js";
import type { Rc1AuthContext } from "../collider/types.js";
import { JsonRpcClient } from "./rpc.js";
import type { AgentSettings, TestnetFundingStage } from "./settings.js";

export const FUJI_TESTNET_FAUCET_URL = "http://127.0.0.1:11440";
export const FUJI_DIEM_ASSET = "0x" + "09".repeat(32);
export const FUJI_DIEM_GRANT_AMOUNT = "55555555555555555";
export const FUJI_CHAIN_ID = 43113;
const JOURNAL_SCHEMA = "collider.agent1.fuji-testnet-funding.v1";

export const ERC20 = new Interface([
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner,address spender) view returns (uint256)",
  "function approve(address spender,uint256 amount) returns (bool)",
]);
export const CUSTODY = new Interface([
  "function depositsEnabled(bytes32 asset) view returns (bool)",
  "function cumulativeDeposits(bytes32 asset,address recipient) view returns (uint256)",
  "function depositTo(bytes32 asset,uint256 amount,address recipient)",
]);

type RpcCaller = {
  call<T>(method: string, params?: unknown[], opts?: { retries?: number; timeoutMs?: number }): Promise<T>;
};

type FaucetClaim = {
  address: string;
  asset: string;
  amount: string;
  gas_wei: string;
  stage: string;
  token_tx_id?: string | null;
  gas_tx_id?: string | null;
};

type StoredReceipt = {
  blockNumber: number;
  blockHash: string;
  status: number;
  confirmedAt: string;
};

export type StoredEvmTransaction = {
  kind: "approval" | "deposit";
  to: string;
  data: string;
  nonce: number;
  rawTransaction: string;
  txHash: string;
  signedAt: string;
  broadcastAttemptedAt?: string;
  broadcastAttempts?: number;
  broadcastError?: string | null;
  receipt?: StoredReceipt;
};

export type FujiTestnetFundingJournal = {
  schema: typeof JOURNAL_SCHEMA;
  wallet: string;
  faucetUrl: string;
  asset: string;
  tokenAddress: string;
  custodyContract: string;
  amount: string;
  baselineCumulativeDeposit: string;
  baselineColliderCredit: string;
  expectedCumulativeDeposit: string;
  stage: TestnetFundingStage;
  createdAt: string;
  updatedAt: string;
  claim?: FaucetClaim;
  approval?: StoredEvmTransaction;
  deposit?: StoredEvmTransaction;
  colliderCredit?: string;
  colliderBalance?: string;
  error?: string | null;
};

export type FujiTestnetFundingProgress = {
  stage: TestnetFundingStage;
  detail: string | null;
  updatedAt: string;
  error: string | null;
  depositTx: string | null;
};

export type FujiTestnetFundingResult = {
  status: "ALREADY_FUNDED" | "FUNDED";
  asset: string;
  amount: string;
  wallet: string;
  depositTx: string | null;
  colliderCredit: string;
  colliderBalance: string;
};

export type FujiTestnetFundingDependencies = {
  fetchFn?: typeof fetch;
  evmRpc?: RpcCaller;
  colliderRpc?: RpcCaller;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
};

export class AmbiguousEvmTransactionError extends Error {
  constructor(readonly txHash: string, message: string) {
    super(message);
    this.name = "AmbiguousEvmTransactionError";
  }
}

function cleanHex(value: unknown): string {
  return String(value ?? "").trim().replace(/^0x/i, "").toLowerCase();
}

export function normalizeAddress(value: unknown, label: string): string {
  const raw = String(value ?? "").trim();
  try {
    return getAddress(raw).toLowerCase();
  } catch {
    throw new Error(label + " must be a valid EVM address");
  }
}

function normalizeHex32(value: unknown, label: string): string {
  const clean = cleanHex(value);
  if (!/^[0-9a-f]{64}$/.test(clean)) throw new Error(label + " must be 32-byte hex");
  return "0x" + clean;
}

function exactInteger(value: unknown, label: string): string {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text)) throw new Error(label + " must be an exact non-negative integer");
  return BigInt(text).toString();
}

export function parseHexQuantity(value: unknown, label: string): bigint {
  const text = String(value ?? "").trim();
  if (!/^0x[0-9a-f]+$/i.test(text)) throw new Error(label + " is not an EVM hex quantity");
  return BigInt(text);
}

function hexQuantity(value: bigint): string {
  return "0x" + value.toString(16);
}

function assertLoopbackFaucetUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("testnet faucet URL is invalid");
  }
  if (url.protocol !== "http:") throw new Error("testnet faucet must use loopback HTTP");
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error("testnet faucet must remain loopback-only");
  }
  if (url.username || url.password || url.search || url.hash) throw new Error("testnet faucet URL must not contain credentials, query, or fragment");
  if (url.pathname !== "/" && url.pathname !== "") throw new Error("testnet faucet URL must not contain a path");
  return url.origin;
}

function selectedBalance(balances: Record<string, string>, asset: string): string {
  const key = cleanHex(asset);
  for (const [candidate, value] of Object.entries(balances)) {
    if (cleanHex(candidate) === key) return exactInteger(value, "Collider balance");
  }
  return "0";
}

function creditedAmount(value: Record<string, unknown>): string {
  return exactInteger(value.credited_cumulative_amount ?? "0", "credited cumulative amount");
}

export async function atomicWriteJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = file + ".tmp-" + process.pid + "-" + Date.now();
  await writeFile(temporary, JSON.stringify(value, null, 2), "utf8");
  await rename(temporary, file);
}

async function loadJournal(file: string): Promise<FujiTestnetFundingJournal | null> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as FujiTestnetFundingJournal;
    if (parsed.schema !== JOURNAL_SCHEMA) throw new Error("unexpected testnet funding journal schema");
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function jsonRequest<T>(
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit = {},
  allowNotFound = false,
): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetchFn(url, { ...init, signal: controller.signal });
    if (allowNotFound && response.status === 404) return null;
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) throw new Error(String(payload.error ?? ("HTTP " + response.status)));
    return payload as T;
  } finally {
    clearTimeout(timer);
  }
}

async function ethCall(
  rpc: RpcCaller,
  to: string,
  data: string,
): Promise<string> {
  return await rpc.call<string>("eth_call", [{ to, data }, "latest"]);
}

export async function readUint(rpc: RpcCaller, to: string, iface: Interface, method: string, args: unknown[]): Promise<bigint> {
  const raw = await ethCall(rpc, to, iface.encodeFunctionData(method, args));
  return BigInt(iface.decodeFunctionResult(method, raw)[0]);
}

export async function readBool(rpc: RpcCaller, to: string, iface: Interface, method: string, args: unknown[]): Promise<boolean> {
  const raw = await ethCall(rpc, to, iface.encodeFunctionData(method, args));
  return Boolean(iface.decodeFunctionResult(method, raw)[0]);
}

function verifyStoredTransaction(
  stored: StoredEvmTransaction,
  wallet: AgentWallet,
  to: string,
  data: string,
): void {
  if (normalizeAddress(stored.to, "stored transaction destination") !== normalizeAddress(to, "expected transaction destination")) {
    throw new Error("stored transaction destination changed");
  }
  if (cleanHex(stored.data) !== cleanHex(data)) throw new Error("stored transaction calldata changed");
  if (keccak256(stored.rawTransaction).toLowerCase() !== stored.txHash.toLowerCase()) {
    throw new Error("stored raw transaction hash mismatch");
  }
  const parsed = Transaction.from(stored.rawTransaction);
  if (!parsed.from || parsed.from.toLowerCase() !== wallet.address.toLowerCase()) throw new Error("stored transaction signer mismatch");
  if (!parsed.to || parsed.to.toLowerCase() !== normalizeAddress(to, "expected transaction destination")) {
    throw new Error("stored transaction target mismatch");
  }
  if (cleanHex(parsed.data) !== cleanHex(data) || parsed.value !== 0n || parsed.chainId !== BigInt(FUJI_CHAIN_ID)) {
    throw new Error("stored transaction fields differ from the pinned Fuji operation");
  }
}

export async function signStoredTransaction(params: {
  kind: "approval" | "deposit";
  wallet: AgentWallet;
  evm: RpcCaller;
  to: string;
  data: string;
  now: () => Date;
}): Promise<StoredEvmTransaction> {
  const chainId = Number(parseHexQuantity(await params.evm.call<string>("eth_chainId", []), "C-Chain id"));
  if (chainId !== FUJI_CHAIN_ID) throw new Error("testnet auto-funding is pinned to Fuji C-Chain 43113");
  const nonce = Number(parseHexQuantity(
    await params.evm.call<string>("eth_getTransactionCount", [params.wallet.address, "pending"]),
    "wallet transaction count",
  ));
  if (!Number.isSafeInteger(nonce) || nonce < 0) throw new Error("wallet EVM nonce is invalid");
  const gasPrice = parseHexQuantity(await params.evm.call<string>("eth_gasPrice", []), "gas price");
  const estimateRequest = {
    from: params.wallet.address,
    to: params.to,
    data: params.data,
    value: "0x0",
  };
  const estimatedGas = parseHexQuantity(
    await params.evm.call<string>("eth_estimateGas", [estimateRequest]),
    "gas estimate",
  );
  const transaction: TransactionRequest = {
    type: 0,
    chainId: FUJI_CHAIN_ID,
    nonce,
    to: params.to,
    data: params.data,
    value: 0n,
    gasPrice,
    gasLimit: (estimatedGas * 12n + 9n) / 10n,
  };
  const rawTransaction = await params.wallet.signEvmTransaction(transaction);
  const txHash = keccak256(rawTransaction);
  const stored: StoredEvmTransaction = {
    kind: params.kind,
    to: normalizeAddress(params.to, "transaction destination"),
    data: params.data,
    nonce,
    rawTransaction,
    txHash,
    signedAt: params.now().toISOString(),
  };
  verifyStoredTransaction(stored, params.wallet, params.to, params.data);
  return stored;
}

export async function sendAndConfirmTransaction(params: {
  stored: StoredEvmTransaction;
  journal: object;
  journalFile: string;
  wallet: AgentWallet;
  evm: RpcCaller;
  to: string;
  data: string;
  confirmations: number;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
}): Promise<StoredEvmTransaction> {
  const stored = params.stored;
  verifyStoredTransaction(stored, params.wallet, params.to, params.data);
  if (stored.receipt?.status === 1) return stored;
  stored.broadcastAttemptedAt = params.now().toISOString();
  stored.broadcastAttempts = Number(stored.broadcastAttempts ?? 0) + 1;
  await atomicWriteJson(params.journalFile, params.journal);
  try {
    const returned = await params.evm.call<string>("eth_sendRawTransaction", [stored.rawTransaction], { retries: 0 });
    if (returned.toLowerCase() !== stored.txHash.toLowerCase()) throw new Error("EVM RPC returned a different transaction hash");
    stored.broadcastError = null;
  } catch (error) {
    // A timeout, already-known response, or nonce-too-low response is
    // ambiguous. Reconcile the pre-journaled hash below; a later process may
    // rebroadcast this exact raw transaction but never signs a replacement.
    stored.broadcastError = String(error);
  }
  await atomicWriteJson(params.journalFile, params.journal);
  const deadline = Date.now() + 3 * 60_000;
  while (Date.now() < deadline) {
    const receipt = await params.evm.call<Record<string, unknown> | null>(
      "eth_getTransactionReceipt",
      [stored.txHash],
      { retries: 0 },
    ).catch(() => null);
    if (receipt) {
      const status = Number(parseHexQuantity(receipt.status, "transaction receipt status"));
      if (status !== 1) throw new Error(stored.kind + " transaction reverted: " + stored.txHash);
      const blockNumber = Number(parseHexQuantity(receipt.blockNumber, "transaction block number"));
      const latestBlock = Number(parseHexQuantity(await params.evm.call<string>("eth_blockNumber", []), "latest block"));
      if (latestBlock - blockNumber + 1 < params.confirmations) {
        await params.sleep(2_000);
        continue;
      }
      stored.receipt = {
        blockNumber,
        blockHash: normalizeHex32(receipt.blockHash, "transaction block hash"),
        status,
        confirmedAt: params.now().toISOString(),
      };
      stored.broadcastError = null;
      await atomicWriteJson(params.journalFile, params.journal);
      return stored;
    }
    await params.sleep(2_000);
  }
  throw new AmbiguousEvmTransactionError(
    stored.txHash,
    stored.kind + " transaction remains ambiguous; resume the same funding journal and do not sign a replacement",
  );
}

function assertJournalPins(
  journal: FujiTestnetFundingJournal,
  params: { wallet: string; faucetUrl: string; token: string; custody: string },
): void {
  if (normalizeAddress(journal.wallet, "journal wallet") !== normalizeAddress(params.wallet, "configured wallet")) {
    throw new Error("testnet funding journal wallet changed");
  }
  if (journal.faucetUrl !== params.faucetUrl) throw new Error("testnet funding journal faucet changed");
  if (normalizeHex32(journal.asset, "journal asset") !== FUJI_DIEM_ASSET) throw new Error("testnet funding journal asset changed");
  if (normalizeAddress(journal.tokenAddress, "journal token") !== normalizeAddress(params.token, "pinned token")) {
    throw new Error("testnet funding journal token changed");
  }
  if (normalizeAddress(journal.custodyContract, "journal custody") !== normalizeAddress(params.custody, "pinned custody")) {
    throw new Error("testnet funding journal custody changed");
  }
  if (journal.amount !== FUJI_DIEM_GRANT_AMOUNT) throw new Error("testnet funding journal amount changed");
}

async function waitForClaim(params: {
  faucetUrl: string;
  wallet: AgentWallet;
  fetchFn: typeof fetch;
  pollMs: number;
  timeoutMs: number;
  sleep: (ms: number) => Promise<void>;
  onClaim: (claim: FaucetClaim) => Promise<void>;
  expectedColliderChain?: string;
}): Promise<FaucetClaim> {
  const claimUrl = params.faucetUrl + "/v1/claims/" + params.wallet.address;
  let claim = await jsonRequest<FaucetClaim>(params.fetchFn, claimUrl, {}, true);
  if (!claim) {
    const challenge = await jsonRequest<{ address: string; nonce: string; message: string; expires_at: number }>(
      params.fetchFn,
      params.faucetUrl + "/v1/challenge?address=" + encodeURIComponent(params.wallet.address),
    );
    if (!challenge) throw new Error("faucet challenge response is missing");
    if (normalizeAddress(challenge.address, "challenge address") !== params.wallet.address.toLowerCase()) {
      throw new Error("faucet challenge address mismatch");
    }
    if (!/^[0-9a-f]{32}$/i.test(challenge.nonce)) throw new Error("faucet challenge nonce is invalid");
    if (!challenge.message.includes("Fuji C-Chain 43113") || !challenge.message.includes(params.wallet.address.toLowerCase())) {
      throw new Error("faucet challenge message is not pinned to this Fuji wallet");
    }
    if (params.expectedColliderChain && (!challenge.message.includes("Collider chain: " + params.expectedColliderChain)
        || !challenge.message.endsWith("One test-only claim; no transfer or custody approval is authorized."))) {
      throw new Error("faucet challenge is not scoped to the new native chain and test-only grant");
    }
    const signature = await params.wallet.signPersonalMessage(challenge.message);
    try {
      claim = await jsonRequest<FaucetClaim>(params.fetchFn, params.faucetUrl + "/v1/claim", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address: params.wallet.address, nonce: challenge.nonce, signature }),
      });
    } catch (error) {
      claim = await jsonRequest<FaucetClaim>(params.fetchFn, claimUrl, {}, true);
      if (!claim) throw new Error("faucet claim admission is ambiguous; poll this wallet before requesting another challenge: " + String(error));
    }
  }
  if (!claim) throw new Error("faucet claim is unavailable");
  const deadline = Date.now() + params.timeoutMs;
  const pendingStages = new Set(["QUEUED", "TOKEN_SIGNED_UNCERTAIN", "TOKEN_FINAL", "GAS_SIGNED_UNCERTAIN", "GAS_FINAL"]);
  while (true) {
    if (normalizeAddress(claim.address, "claim address") !== params.wallet.address.toLowerCase()) throw new Error("faucet claim wallet mismatch");
    if (normalizeHex32(claim.asset, "claim asset") !== FUJI_DIEM_ASSET) throw new Error("faucet claim asset mismatch");
    if (exactInteger(claim.amount, "claim amount") !== FUJI_DIEM_GRANT_AMOUNT) throw new Error("faucet claim amount mismatch");
    await params.onClaim(claim);
    if (claim.stage === "COMPLETE") return claim;
    if (!pendingStages.has(claim.stage)) throw new Error("unexpected faucet claim stage " + claim.stage);
    if (Date.now() >= deadline) throw new Error("faucet claim remains pending at stage " + claim.stage);
    const health = await jsonRequest<{ ready: boolean; network: string; asset: string; faucet: string }>(
      params.fetchFn,
      params.faucetUrl + "/healthz",
    );
    if (!health?.ready || health.network !== "fuji" || health.faucet !== "test-only"
      || normalizeHex32(health.asset, "faucet health asset") !== FUJI_DIEM_ASSET) {
      throw new Error("Fuji testnet faucet requires operator reconciliation");
    }
    await params.sleep(params.pollMs);
    claim = await jsonRequest<FaucetClaim>(params.fetchFn, claimUrl);
    if (!claim) throw new Error("faucet claim disappeared");
  }
}

export async function ensureFujiTestnetFunding(params: {
  settings: AgentSettings;
  dataDir: string;
  wallet: AgentWallet;
  onProgress?: (progress: FujiTestnetFundingProgress) => void | Promise<void>;
  dependencies?: FujiTestnetFundingDependencies;
}): Promise<FujiTestnetFundingResult> {
  const config = params.settings.testnetAutoFunding;
  if (!config?.enabled) throw new Error("Fuji testnet auto-funding is not enabled");
  const faucetUrl = assertLoopbackFaucetUrl(config.faucetUrl);
  const bridge = params.settings.bridgeWithdrawal;
  if (!bridge || bridge.expectedEvmChainId !== FUJI_CHAIN_ID) throw new Error("Fuji auto-funding requires pinned C-Chain 43113 bridge settings");
  const pin = Object.entries(bridge.assets).find(([asset]) => cleanHex(asset) === cleanHex(FUJI_DIEM_ASSET))?.[1];
  if (!pin) throw new Error("Fuji auto-funding requires the pinned DIEM bridge asset");
  const token = normalizeAddress(pin.tokenAddress, "pinned DIEM token");
  const custody = normalizeAddress(bridge.custodyContract, "pinned custody contract");
  const rpc = params.dependencies?.evmRpc ?? new JsonRpcClient(bridge.cRpc);
  const collider = params.dependencies?.colliderRpc ?? new JsonRpcClient(params.settings.rpc);
  const fetchFn = params.dependencies?.fetchFn ?? fetch;
  const sleep = params.dependencies?.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = params.dependencies?.now ?? (() => new Date());
  const journalFile = path.join(params.dataDir, "testnet-funding-state.json");
  const lockFile = path.join(params.dataDir, "testnet-funding.lock");
  await mkdir(params.dataDir, { recursive: true });
  let lock;
  try {
    lock = await open(lockFile, "wx");
    await lock.writeFile(String(process.pid), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("another Agent1 testnet funding process holds the data-directory lock");
    throw error;
  }

  let journal = await loadJournal(journalFile);
  const progress = async (stage: TestnetFundingStage, error: string | null = null): Promise<void> => {
    if (journal) {
      journal.stage = stage;
      journal.updatedAt = now().toISOString();
      journal.error = error;
      await atomicWriteJson(journalFile, journal);
    }
    await params.onProgress?.({
      stage,
      detail: null,
      updatedAt: now().toISOString(),
      error,
      depositTx: journal?.deposit?.txHash ?? null,
    });
  };

  try {
    await progress("CHECKING");
    const health = await jsonRequest<{ ready: boolean; network: string; asset: string; faucet: string;
      collider_chain_id?: string; route_id?: string; custody_address?: string; token?: string; amount?: string; gas_wei?: string }>(
      fetchFn,
      faucetUrl + "/healthz",
    );
    if (!health?.ready || health.network !== "fuji" || health.faucet !== "test-only"
      || normalizeHex32(health.asset, "faucet health asset") !== FUJI_DIEM_ASSET) {
      throw new Error("loopback Fuji faucet is not ready");
    }
    const colliderChain = new URL(params.settings.rpc).pathname.match(/\/ext\/bc\/([^/]+)\/collider_v2$/)?.[1];
    if (config.readinessUrl && (!colliderChain || health.collider_chain_id !== colliderChain
        || cleanHex(health.route_id) !== cleanHex(bridge.routeId)
        || cleanHex(health.custody_address) !== cleanHex(custody)
        || cleanHex(health.token) !== cleanHex(token) || health.amount !== FUJI_DIEM_GRANT_AMOUNT
        || health.gas_wei !== "5000000000000000")) {
      throw new Error("external dispenser is not pinned to this custody/route/chain and exact grant");
    }
    const auth = await collider.call<Record<string, unknown>>("colliderV2.getAuthContext", [params.wallet.userId]);
    if (Number(auth.network_id) !== 5 || auth.domain_configured !== true) throw new Error("Collider endpoint is not the pinned Fuji RC1 network");
    for (const [field, expected] of [["network_domain", params.settings.expectedNetworkDomain],
      ["l1_id", params.settings.expectedL1Id], ["chain_id", params.settings.expectedChainId]]) {
      if (expected && cleanHex(auth[String(field)]) !== cleanHex(expected)) throw new Error("Fuji auto-funding native route pin mismatch");
    }
    if (params.settings.expectedSigningChainId != null) assertNativeSigningContext(auth as Rc1AuthContext, params.settings.expectedSigningChainId);
    if (config.readinessUrl) {
      const readinessUrl = new URL(config.readinessUrl);
      assertLoopbackFaucetUrl(readinessUrl.origin);
      if (readinessUrl.pathname !== "/status" || readinessUrl.username || readinessUrl.password
          || readinessUrl.search || readinessUrl.hash) throw new Error("invalid readiness URL");
      const readiness = await jsonRequest<{ ready: boolean; expiresAtMs: number; scope: {
        contract: string; routeId: string; networkDomain: string; evmChainId: number } }>(fetchFn, config.readinessUrl);
      if (!readiness?.ready || !Number.isSafeInteger(readiness.expiresAtMs) || readiness.expiresAtMs <= Date.now()
          || cleanHex(readiness.scope.contract) !== cleanHex(custody)
          || cleanHex(readiness.scope.routeId) !== cleanHex(bridge.routeId)
          || cleanHex(readiness.scope.networkDomain) !== cleanHex(params.settings.expectedNetworkDomain)
          || readiness.scope.evmChainId !== FUJI_CHAIN_ID) throw new Error("new-chain bridge readiness is stale or route-mismatched");
    }
    if (Number(parseHexQuantity(await rpc.call<string>("eth_chainId", []), "C-Chain id")) !== FUJI_CHAIN_ID) {
      throw new Error("C-Chain endpoint is not Fuji 43113");
    }
    if (!await readBool(rpc, custody, CUSTODY, "depositsEnabled", [FUJI_DIEM_ASSET])) {
      throw new Error("DIEM custody deposits are disabled");
    }
    const balances = await collider.call<Record<string, string>>("colliderV2.getBalances", [params.wallet.userId]);
    const balanceBefore = selectedBalance(balances, FUJI_DIEM_ASSET);
    const creditBefore = creditedAmount(await collider.call<Record<string, unknown>>(
      "colliderV2.getBridgeDepositCredit",
      [FUJI_DIEM_ASSET, params.wallet.userId],
    ));
    if (BigInt(balanceBefore) > 0n && !journal) {
      await params.onProgress?.({ stage: "COMPLETE", detail: "ALREADY_FUNDED", updatedAt: now().toISOString(), error: null, depositTx: null });
      return {
        status: "ALREADY_FUNDED",
        asset: FUJI_DIEM_ASSET,
        amount: FUJI_DIEM_GRANT_AMOUNT,
        wallet: params.wallet.address,
        depositTx: null,
        colliderCredit: creditBefore,
        colliderBalance: balanceBefore,
      };
    }
    const cumulativeBefore = (await readUint(
      rpc,
      custody,
      CUSTODY,
      "cumulativeDeposits",
      [FUJI_DIEM_ASSET, params.wallet.address],
    )).toString();
    if (!journal) {
      const stamp = now().toISOString();
      journal = {
        schema: JOURNAL_SCHEMA,
        wallet: params.wallet.address,
        faucetUrl,
        asset: FUJI_DIEM_ASSET,
        tokenAddress: token,
        custodyContract: custody,
        amount: FUJI_DIEM_GRANT_AMOUNT,
        baselineCumulativeDeposit: cumulativeBefore,
        baselineColliderCredit: creditBefore,
        expectedCumulativeDeposit: (BigInt(cumulativeBefore) + BigInt(FUJI_DIEM_GRANT_AMOUNT)).toString(),
        stage: "CHECKING",
        createdAt: stamp,
        updatedAt: stamp,
      };
      await atomicWriteJson(journalFile, journal);
    } else {
      assertJournalPins(journal, { wallet: params.wallet.address, faucetUrl, token, custody });
    }

    const expectedCumulative = BigInt(journal.expectedCumulativeDeposit);
    let currentCumulative = await readUint(rpc, custody, CUSTODY, "cumulativeDeposits", [FUJI_DIEM_ASSET, params.wallet.address]);
    if (currentCumulative < expectedCumulative) {
      await progress("CLAIM_PENDING");
      journal.claim = await waitForClaim({
        expectedColliderChain: config.readinessUrl ? colliderChain : undefined,
        faucetUrl,
        wallet: params.wallet,
        fetchFn,
        pollMs: config.claimPollMs,
        timeoutMs: config.claimTimeoutMs,
        sleep,
        onClaim: async (claim) => {
          if (!journal) return;
          journal.claim = claim;
          journal.updatedAt = now().toISOString();
          await atomicWriteJson(journalFile, journal);
          await params.onProgress?.({
            stage: "CLAIM_PENDING",
            detail: claim.stage,
            updatedAt: now().toISOString(),
            error: null,
            depositTx: journal.deposit?.txHash ?? null,
          });
        },
      });
      await progress("CLAIM_COMPLETE");
      const tokenBalance = await readUint(rpc, token, ERC20, "balanceOf", [params.wallet.address]);
      if (tokenBalance < BigInt(FUJI_DIEM_GRANT_AMOUNT)) throw new Error("wallet did not receive the exact DIEM faucet grant");
      let allowance = await readUint(rpc, token, ERC20, "allowance", [params.wallet.address, custody]);
      if (allowance !== 0n && allowance !== BigInt(FUJI_DIEM_GRANT_AMOUNT)) {
        throw new Error("existing DIEM allowance is not zero or the exact grant amount");
      }
      if (allowance === 0n) {
        await progress("APPROVAL_PENDING");
        const data = ERC20.encodeFunctionData("approve", [custody, FUJI_DIEM_GRANT_AMOUNT]);
        journal.approval = journal.approval ?? await signStoredTransaction({
          kind: "approval", wallet: params.wallet, evm: rpc, to: token, data, now,
        });
        await atomicWriteJson(journalFile, journal);
        journal.approval = await sendAndConfirmTransaction({
          stored: journal.approval,
          journal,
          journalFile,
          wallet: params.wallet,
          evm: rpc,
          to: token,
          data,
          confirmations: config.evmConfirmations,
          now,
          sleep,
        });
        allowance = await readUint(rpc, token, ERC20, "allowance", [params.wallet.address, custody]);
        if (allowance !== BigInt(FUJI_DIEM_GRANT_AMOUNT)) throw new Error("exact DIEM approval did not settle");
      }
      await progress("APPROVAL_CONFIRMED");
      await progress("DEPOSIT_PENDING");
      const data = CUSTODY.encodeFunctionData("depositTo", [FUJI_DIEM_ASSET, FUJI_DIEM_GRANT_AMOUNT, params.wallet.address]);
      journal.deposit = journal.deposit ?? await signStoredTransaction({
        kind: "deposit", wallet: params.wallet, evm: rpc, to: custody, data, now,
      });
      await atomicWriteJson(journalFile, journal);
      journal.deposit = await sendAndConfirmTransaction({
        stored: journal.deposit,
        journal,
        journalFile,
        wallet: params.wallet,
        evm: rpc,
        to: custody,
        data,
        confirmations: config.evmConfirmations,
        now,
        sleep,
      });
      currentCumulative = await readUint(rpc, custody, CUSTODY, "cumulativeDeposits", [FUJI_DIEM_ASSET, params.wallet.address]);
      if (currentCumulative !== expectedCumulative) throw new Error("custody cumulative deposit does not equal the journaled target");
    }
    await progress("EVM_DEPOSIT_CONFIRMED");
    await progress("COLLIDER_CREDIT_PENDING");
    const deadline = Date.now() + config.creditTimeoutMs;
    while (true) {
      const credit = creditedAmount(await collider.call<Record<string, unknown>>(
        "colliderV2.getBridgeDepositCredit",
        [FUJI_DIEM_ASSET, params.wallet.userId],
      ));
      const currentBalances = await collider.call<Record<string, string>>("colliderV2.getBalances", [params.wallet.userId]);
      const balance = selectedBalance(currentBalances, FUJI_DIEM_ASSET);
      if (BigInt(credit) >= expectedCumulative && BigInt(balance) > 0n) {
        journal.colliderCredit = credit;
        journal.colliderBalance = balance;
        await progress("COMPLETE");
        return {
          status: "FUNDED",
          asset: FUJI_DIEM_ASSET,
          amount: FUJI_DIEM_GRANT_AMOUNT,
          wallet: params.wallet.address,
          depositTx: journal.deposit?.txHash ?? null,
          colliderCredit: credit,
          colliderBalance: balance,
        };
      }
      if (Date.now() >= deadline) throw new Error("EVM deposit is confirmed but Collider credit remains pending");
      await sleep(config.creditPollMs);
    }
  } catch (error) {
    const stage: TestnetFundingStage = error instanceof AmbiguousEvmTransactionError ? "AMBIGUOUS" : "FAILED";
    await progress(stage, String(error));
    throw error;
  } finally {
    await lock?.close().catch(() => undefined);
    await rm(lockFile, { force: true }).catch(() => undefined);
  }
}
