import { setTimeout as sleep } from "node:timers/promises";

import { Interface, TypedDataEncoder, type TypedDataDomain, type TypedDataField } from "ethers";

import { JsonRpcClient } from "../core/rpc.js";
import type {
  BridgeAssetPin,
  BridgeWithdrawalArgs,
  BridgeWithdrawalPreview,
  BridgeWithdrawalResult,
  BridgeWithdrawalObservation,
  Hex32,
  PreparedSignedIntent,
  Rc1AuthContext,
  SubmittedSignedIntent,
} from "./types.js";
import { AgentWallet, evmAddressFromColliderUserId } from "./wallet.js";
import { verifyNativePreparedEnvelope } from "./native-signing.js";
import { Rc1WithdrawalStore, type PendingSignedWithdrawal } from "./withdrawal-store.js";
import { assertNativeSigningContext } from "./native-signing.js";

const HEX_20_RE = /^0x[0-9a-f]{40}$/i;
const HEX_32_RE = /^0x[0-9a-f]{64}$/i;
const HEX_65_RE = /^0x[0-9a-f]{130}$/i;
const CUSTODY_INTERFACE = new Interface([
  "function custodyAuthorizationDigest(bytes32 requestId, bytes32 policyHash, address token, address beneficiary, uint128 amount, uint8 action, uint8 authorityKind) view returns (bytes32)",
]);
const PUBLIC_CUSTODY_INTERFACE = new Interface([
  "function custodyAuthorizationDigest(bytes32 requestId,bytes32 policyHash,address token,address beneficiary,uint256 amount,uint8 action,uint8 authorityKind) view returns (bytes32)",
]);

export type Rc1WithdrawalClientOptions = {
  expectedNetworkDomain: Hex32;
  expectedNetworkId: number;
  expectedL1Id: Hex32;
  expectedChainId: Hex32;
  expectedEvmChainId: number;
  expectedSigningChainId?: number | null;
  custodyContract: string;
  routeId: Hex32;
  expectedAttestor: string;
  assetPin: BridgeAssetPin;
  stateFile: string;
  intentTtlBlocks?: number;
  reconcilePollMs?: number;
  reconcileTimeoutMs?: number;
};

type BridgePolicy = {
  asset: Hex32;
  token_address: string;
  min_withdrawal_amount: string;
  policy_hash: Hex32;
  [key: string]: unknown;
};

export type VerifiedWithdrawalPreview = {
  expected: BridgeWithdrawalArgs;
  preview: BridgeWithdrawalPreview;
  balanceBefore: string;
  policy: BridgePolicy;
};

function normalizeHex32(value: unknown, label: string): string {
  const raw = String(value ?? "").trim();
  const prefixed = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (!HEX_32_RE.test(prefixed)) throw new Error(`${label} must be 32-byte hex`);
  return prefixed.toLowerCase();
}

function normalizeAddress(value: unknown, label: string): string {
  const raw = String(value ?? "").trim();
  const prefixed = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (!HEX_20_RE.test(prefixed)) throw new Error(`${label} must be a 20-byte EVM address`);
  return prefixed.toLowerCase();
}

function cleanHex(value: unknown): string {
  return String(value ?? "").trim().replace(/^0x/i, "").toLowerCase();
}

function arrayHex(value: unknown, bytes: number, label: string): string {
  if (!Array.isArray(value) || value.length !== bytes) throw new Error(`${label} must be a ${bytes}-byte array`);
  const values = value.map(Number);
  if (values.some((entry) => !Number.isInteger(entry) || entry < 0 || entry > 255)) {
    throw new Error(`${label} contains invalid bytes`);
  }
  return `0x${Buffer.from(values).toString("hex")}`;
}

function typedData(value: unknown, label: string): {
  types: Record<string, TypedDataField[]>;
  primaryType: string;
  domain: TypedDataDomain;
  message: Record<string, unknown>;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is missing`);
  const row = value as Record<string, unknown>;
  if (!row.types || typeof row.types !== "object") throw new Error(`${label}.types is missing`);
  if (!row.domain || typeof row.domain !== "object") throw new Error(`${label}.domain is missing`);
  if (!row.message || typeof row.message !== "object") throw new Error(`${label}.message is missing`);
  return {
    types: row.types as Record<string, TypedDataField[]>,
    primaryType: String(row.primaryType ?? ""),
    domain: row.domain as TypedDataDomain,
    message: row.message as Record<string, unknown>,
  };
}

function eventPayload(event: unknown, kind: string): Record<string, unknown> | null {
  if (!event || typeof event !== "object" || Array.isArray(event)) return null;
  const payload = (event as Record<string, unknown>)[kind];
  return payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : null;
}

function parseWithdrawalDetails(details: string): Record<string, unknown> {
  const exactJson = details.replace(/"amount"\s*:\s*(\d+)/, '"amount":"$1"');
  const parsed = JSON.parse(exactJson) as Record<string, unknown>;
  const op = parsed.RequestWithdrawal;
  if (!op || typeof op !== "object" || Array.isArray(op)) {
    throw new Error("prepared intent details are not a RequestWithdrawal operation");
  }
  return op as Record<string, unknown>;
}

function assertAuthContext(context: Rc1AuthContext, wallet: AgentWallet, options: Rc1WithdrawalClientOptions): void {
  if(options.expectedSigningChainId!=null||options.expectedNetworkDomain==="0x33b848fb090b5558d6dd420513f6c8070737faebe58f5408897a2e862d084672")assertNativeSigningContext(context,options.expectedSigningChainId);
  if (!context.domain_configured) throw new Error("Collider RPC is not an initialized RC1 auth domain");
  if (!context.user?.canonical_wallet_user) throw new Error("Collider RPC rejected Agent1's canonical wallet-backed UserId");
  if (cleanHex(context.user.user_id) !== cleanHex(wallet.userId)) throw new Error("Collider auth context returned a different user identity");
  if (normalizeHex32(context.network_domain, "auth network domain") !== normalizeHex32(options.expectedNetworkDomain, "expected network domain")) {
    throw new Error("Collider RPC network domain mismatch");
  }
  if (context.network_id !== options.expectedNetworkId) throw new Error("Collider RPC Avalanche network id mismatch");
  if (normalizeHex32(context.l1_id, "auth l1 id") !== normalizeHex32(options.expectedL1Id, "expected l1 id")) throw new Error("Collider RPC L1 id mismatch");
  if (normalizeHex32(context.chain_id, "auth chain id") !== normalizeHex32(options.expectedChainId, "expected chain id")) throw new Error("Collider RPC chain id mismatch");
}

export function verifyBridgeWithdrawalPreview(params: {
  preview: BridgeWithdrawalPreview;
  expected: BridgeWithdrawalArgs;
  wallet: AgentWallet;
  options: Rc1WithdrawalClientOptions;
}): void {
  const { preview, expected, wallet, options } = params;
  if (!preview.user_custody_signature_required || !preview.attestor_required_after_acceptance) {
    throw new Error("RC1 withdrawal preview omitted required user or attestor authorization");
  }
  if (normalizeAddress(preview.expected_user_signer, "expected user signer") !== normalizeAddress(wallet.address, "wallet address")) {
    throw new Error("withdrawal preview expects a different wallet signer");
  }
  if (normalizeHex32(preview.origin_ref_id, "preview origin_ref_id") !== normalizeHex32(expected.originRefId, "origin_ref_id")) {
    throw new Error("withdrawal preview origin reference mismatch");
  }
  if (preview.withdrawal_nonce !== expected.withdrawalNonce) throw new Error("withdrawal preview nonce mismatch");
  if (normalizeHex32(preview.route_id, "preview route_id") !== normalizeHex32(options.routeId, "expected route_id")) {
    throw new Error("withdrawal preview route mismatch");
  }
  if (normalizeHex32(preview.policy_hash, "preview policy_hash") !== normalizeHex32(options.assetPin.policyHash, "expected policy_hash")) {
    throw new Error("withdrawal preview policy mismatch");
  }
  if (normalizeAddress(preview.expected_attestor_after_acceptance, "preview attestor") !== normalizeAddress(options.expectedAttestor, "expected attestor")) {
    throw new Error("withdrawal preview attestor mismatch");
  }

  const custody = typedData(preview.custody_typed_data, "custody typed data");
  if (custody.primaryType !== "CustodyWithdrawal") throw new Error("unexpected custody EIP-712 primary type");
  if (String(custody.domain.name) !== "Collider V2 Custody" || String(custody.domain.version) !== "1") {
    throw new Error("unexpected custody EIP-712 domain name/version");
  }
  if (Number(custody.domain.chainId) !== options.expectedEvmChainId) throw new Error("custody EIP-712 chain id mismatch");
  if (normalizeAddress(custody.domain.verifyingContract, "custody verifying contract") !== normalizeAddress(options.custodyContract, "expected custody contract")) {
    throw new Error("custody EIP-712 verifying contract mismatch");
  }
  if (normalizeHex32(custody.domain.salt, "custody domain salt") !== normalizeHex32(options.routeId, "expected route_id")) {
    throw new Error("custody EIP-712 route salt mismatch");
  }
  const message = custody.message;
  if (normalizeHex32(message.requestId, "custody requestId") !== normalizeHex32(preview.request_id, "preview request_id")) throw new Error("custody request id mismatch");
  if (normalizeHex32(message.policyHash, "custody policyHash") !== normalizeHex32(preview.policy_hash, "preview policy hash")) throw new Error("custody policy hash mismatch");
  if (normalizeAddress(message.token, "custody token") !== normalizeAddress(options.assetPin.tokenAddress, "expected token")) throw new Error("custody token mismatch");
  if (normalizeAddress(message.beneficiary, "custody beneficiary") !== normalizeAddress(wallet.address, "wallet address")) throw new Error("custody beneficiary mismatch");
  if (String(message.amount) !== expected.amount) throw new Error("custody exact amount mismatch");
  if (String(message.action) !== "1" || String(message.authorityKind) !== "1") throw new Error("custody action or authority kind mismatch");

  const digest = TypedDataEncoder.hash(
    custody.domain,
    { CustodyWithdrawal: custody.types.CustodyWithdrawal ?? [] },
    custody.message,
  );
  if (normalizeHex32(digest, "local custody digest") !== normalizeHex32(preview.custody_digest, "preview custody digest")) {
    throw new Error("local custody EIP-712 digest does not match the VM preview");
  }
}

export function verifyPreparedWithdrawalIntent(params: {
  prepared: PreparedSignedIntent;
  context: Rc1AuthContext;
  expected: BridgeWithdrawalArgs;
  custodySignature: string;
  wallet: AgentWallet;
  options: Rc1WithdrawalClientOptions;
}): void {
  const { prepared, context, expected, custodySignature, wallet, options } = params;
  const signer = normalizeHex32(prepared.signer, "prepared signer");
  if (signer !== normalizeHex32(wallet.userId, "wallet user") || signer !== normalizeHex32(expected.user, "withdrawal user")) {
    throw new Error("prepared withdrawal signer does not match the configured wallet");
  }
  if (prepared.action !== "bridge.withdraw.request") throw new Error(`unexpected prepared action ${prepared.action}`);
  if (!Number.isSafeInteger(prepared.nonce) || prepared.nonce < 0) throw new Error("prepared nonce is not a safe non-negative integer");
  if (!Number.isSafeInteger(prepared.issued_at_height) || !Number.isSafeInteger(prepared.valid_until_height)) throw new Error("prepared height exceeds JavaScript safe-integer range");
  if (prepared.valid_until_height <= prepared.issued_at_height) throw new Error("prepared intent has invalid expiry window");
  if (prepared.nonce !== context.user?.next_available_nonce) throw new Error("prepared nonce does not match current auth context");
  if (normalizeHex32(prepared.network_domain, "prepared network domain") !== normalizeHex32(options.expectedNetworkDomain, "expected network domain")) {
    throw new Error("prepared withdrawal network domain mismatch");
  }

  const op = parseWithdrawalDetails(prepared.details);
  if (arrayHex(op.token, 32, "details.token") !== normalizeHex32(expected.asset, "asset")) throw new Error("prepared withdrawal asset mismatch");
  if (arrayHex(op.user, 32, "details.user") !== normalizeHex32(expected.user, "user")) throw new Error("prepared withdrawal user mismatch");
  if (String(op.amount ?? "") !== expected.amount) throw new Error("prepared withdrawal exact amount mismatch");
  if (Number(op.withdrawal_nonce) !== expected.withdrawalNonce) throw new Error("prepared withdrawal nonce mismatch");
  if (arrayHex(op.origin_ref_id, 32, "details.origin_ref_id") !== normalizeHex32(expected.originRefId, "origin_ref_id")) throw new Error("prepared withdrawal origin reference mismatch");
  if (arrayHex(op.custody_signature, 65, "details.custody_signature") !== custodySignature.toLowerCase()) throw new Error("prepared custody signature mismatch");

  const intent = typedData(prepared.typed_data, "prepared typed data");
  if (intent.primaryType !== "ColliderIntent") throw new Error("unexpected Collider EIP-712 primary type");
  const message = intent.message;
  if (normalizeHex32(message.signer, "typed-data signer") !== signer) throw new Error("typed-data signer mismatch");
  if (String(message.action) !== prepared.action || String(message.details) !== prepared.details) throw new Error("typed-data operation mismatch");
  if (String(message.nonce) !== String(prepared.nonce)) throw new Error("typed-data nonce mismatch");
  if (String(message.issuedAtHeight) !== String(prepared.issued_at_height)) throw new Error("typed-data issued height mismatch");
  if (String(message.validUntilHeight) !== String(prepared.valid_until_height)) throw new Error("typed-data expiry mismatch");
  if (normalizeHex32(message.payloadHash, "typed-data payloadHash") !== normalizeHex32(prepared.payload_hash, "prepared payload_hash")) throw new Error("typed-data payload hash mismatch");
  if (normalizeHex32(message.networkDomain, "typed-data networkDomain") !== normalizeHex32(prepared.network_domain, "prepared network domain")) throw new Error("typed-data network domain mismatch");
  verifyNativePreparedEnvelope(prepared, context, options.expectedSigningChainId);
  if (String(message.amountBaseUnits) !== expected.amount
      || String(message.asset).toLowerCase() !== normalizeHex32(expected.asset, "asset")) {
    throw new Error("prepared withdrawal presentation amount/asset mismatch");
  }
  if (normalizeHex32(intent.domain.salt, "intent domain salt") !== normalizeHex32(options.expectedNetworkDomain, "expected network domain")) throw new Error("Collider EIP-712 salt mismatch");
  const digest = TypedDataEncoder.hash(intent.domain, { ColliderIntent: intent.types.ColliderIntent ?? [] }, intent.message);
  if (normalizeHex32(digest, "local intent digest") !== normalizeHex32(prepared.digest, "prepared intent digest")) {
    throw new Error("local EIP-712 digest does not match the VM-prepared withdrawal digest");
  }
}

function pendingResult(pending: PendingSignedWithdrawal): BridgeWithdrawalResult {
  return {
    status: "pending",
    signer: pending.prepared.signer,
    nonce: pending.prepared.nonce,
    payloadHash: pending.prepared.payload_hash,
    opId: pending.submission?.op_id ?? null,
    requestId: pending.preview.request_id,
    authenticatedAtHeight: null,
    reservedAtHeight: null,
    balanceBefore: pending.balanceBefore,
    balanceAfter: null,
    submitError: pending.submitError,
  };
}

export class PendingSignedWithdrawalError extends Error {
  constructor(readonly result: BridgeWithdrawalResult) {
    super(`signed withdrawal nonce ${result.nonce} remains pending canonical reconciliation`);
    this.name = "PendingSignedWithdrawalError";
  }
}

export class Rc1WithdrawalClient {
  private readonly collider: JsonRpcClient;
  private readonly evm: JsonRpcClient;
  private readonly store: Rc1WithdrawalStore;

  constructor(
    colliderRpcUrl: string,
    cRpcUrl: string,
    private readonly wallet: AgentWallet,
    private readonly options: Rc1WithdrawalClientOptions,
  ) {
    this.collider = new JsonRpcClient(colliderRpcUrl);
    this.evm = new JsonRpcClient(cRpcUrl);
    this.store = new Rc1WithdrawalStore(options.stateFile);
  }

  private async authContext(): Promise<Rc1AuthContext> {
    const context = await this.collider.call<Rc1AuthContext>("colliderV2.getAuthContext", [this.wallet.userId]);
    assertAuthContext(context, this.wallet, this.options);
    return context;
  }

  private async verifyContractDigest(preview: BridgeWithdrawalPreview, expected: BridgeWithdrawalArgs): Promise<void> {
    const chainIdHex = await this.evm.call<string>("eth_chainId", []);
    if (Number(BigInt(chainIdHex)) !== this.options.expectedEvmChainId) throw new Error("C-Chain RPC chain id mismatch");
    const iface = this.options.expectedNetworkDomain === "0x33b848fb090b5558d6dd420513f6c8070737faebe58f5408897a2e862d084672" ? PUBLIC_CUSTODY_INTERFACE : CUSTODY_INTERFACE;
    const data = iface.encodeFunctionData("custodyAuthorizationDigest", [
      preview.request_id,
      preview.policy_hash,
      this.options.assetPin.tokenAddress,
      this.wallet.address,
      expected.amount,
      1,
      1,
    ]);
    const raw = await this.evm.call<string>("eth_call", [{ to: this.options.custodyContract, data }, "latest"]);
    const [digest] = iface.decodeFunctionResult("custodyAuthorizationDigest", raw);
    if (normalizeHex32(digest, "Solidity custody digest") !== normalizeHex32(preview.custody_digest, "VM custody digest")) {
      throw new Error("VM/Solidity custody digest mismatch");
    }
  }

  async previewWithdrawal(args: BridgeWithdrawalArgs): Promise<VerifiedWithdrawalPreview> {
    const expected: BridgeWithdrawalArgs = {
      ...args,
      asset: normalizeHex32(args.asset, "asset"),
      user: normalizeHex32(this.wallet.userId, "wallet user"),
      amount: String(args.amount),
      originRefId: normalizeHex32(args.originRefId, "origin_ref_id"),
    };
    if (!/^\d+$/.test(expected.amount) || BigInt(expected.amount) <= 0n) throw new Error("withdrawal amount must be a positive exact base-unit decimal string");
    if (!Number.isSafeInteger(expected.withdrawalNonce) || expected.withdrawalNonce < 0) throw new Error("withdrawal nonce must be a safe non-negative integer");
    if (cleanHex(args.user) && normalizeHex32(args.user, "requested user") !== expected.user) throw new Error("withdrawal user differs from configured wallet");

    const serverUser = await this.collider.call<Hex32>("colliderV2.userIdFromEvmAddress", [this.wallet.address]);
    if (normalizeHex32(serverUser, "server wallet user") !== expected.user) throw new Error("RPC EVM address to Collider UserId derivation mismatch");
    await this.authContext();

    const policies = await this.collider.call<BridgePolicy[]>("colliderV2.getBridgeAssetPolicies", []);
    const policy = policies.find((row) => cleanHex(row.asset) === cleanHex(expected.asset));
    if (!policy) throw new Error("withdrawal asset is not in the live bridge policy catalog");
    if (normalizeAddress(policy.token_address, "live policy token") !== normalizeAddress(this.options.assetPin.tokenAddress, "pinned token")) throw new Error("live bridge token differs from the pinned token");
    if (normalizeHex32(policy.policy_hash, "live policy hash") !== normalizeHex32(this.options.assetPin.policyHash, "pinned policy hash")) throw new Error("live bridge policy hash differs from the pin");
    if (String(policy.min_withdrawal_amount) !== String(this.options.assetPin.minWithdrawalAmount)) throw new Error("live bridge withdrawal minimum differs from the pin");
    if (BigInt(expected.amount) < BigInt(policy.min_withdrawal_amount)) throw new Error("withdrawal amount is below the live policy minimum");

    const balances = await this.collider.call<Record<string, string>>("colliderV2.getBalances", [expected.user]);
    const balanceBefore = String(balances[expected.asset] ?? balances[expected.asset.toLowerCase()] ?? "0");
    if (BigInt(balanceBefore) < BigInt(expected.amount)) throw new Error("insufficient accepted Collider balance for withdrawal");

    const preview = await this.collider.call<BridgeWithdrawalPreview>("colliderV2.prepareBridgeUserWithdrawal", [
      expected.asset,
      expected.user,
      expected.amount,
      expected.withdrawalNonce,
      expected.originRefId,
    ]);
    verifyBridgeWithdrawalPreview({ preview, expected, wallet: this.wallet, options: this.options });
    await this.verifyContractDigest(preview, expected);
    return { expected, preview, balanceBefore, policy };
  }

  private validateCommand(command: unknown, pending: PendingSignedWithdrawal): number {
    if (!command || typeof command !== "object" || Array.isArray(command)) throw new Error("withdrawal command is malformed");
    const row = command as Record<string, unknown>;
    if (String(row.action) !== "Execute" || row.attestor_required !== true || String(row.authority) !== "User") throw new Error("unexpected withdrawal command authority/action");
    if (normalizeHex32(row.request_id, "command request_id") !== normalizeHex32(pending.preview.request_id, "expected request_id")) throw new Error("withdrawal command request id mismatch");
    if (normalizeHex32(row.route_id, "command route_id") !== normalizeHex32(this.options.routeId, "expected route_id")) throw new Error("withdrawal command route mismatch");
    if (normalizeHex32(row.policy_hash, "command policy_hash") !== normalizeHex32(this.options.assetPin.policyHash, "expected policy_hash")) throw new Error("withdrawal command policy mismatch");
    if (normalizeHex32(row.custody_digest, "command custody_digest") !== normalizeHex32(pending.preview.custody_digest, "preview custody_digest")) throw new Error("withdrawal command custody digest mismatch");
    if (normalizeAddress(row.expected_attestor, "command attestor") !== normalizeAddress(this.options.expectedAttestor, "expected attestor")) throw new Error("withdrawal command attestor mismatch");
    if (String(row.user_custody_signature).toLowerCase() !== pending.custodySignature.toLowerCase()) throw new Error("withdrawal command user custody signature mismatch");
    const withdrawal = row.withdrawal;
    if (!withdrawal || typeof withdrawal !== "object" || Array.isArray(withdrawal)) throw new Error("withdrawal command record is missing");
    const record = withdrawal as Record<string, unknown>;
    if (String(record.amount) !== pending.expected.amount) throw new Error("withdrawal command amount mismatch");
    if (normalizeHex32(record.asset, "command asset") !== normalizeHex32(pending.expected.asset, "expected asset")) throw new Error("withdrawal command asset mismatch");
    if (normalizeHex32(record.to, "command destination") !== normalizeHex32(pending.expected.user, "expected user")) throw new Error("withdrawal command destination mismatch");
    const source = record.source;
    if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error("withdrawal command source is missing");
    const sourceRow = source as Record<string, unknown>;
    if (String(sourceRow.kind) !== "user") throw new Error("withdrawal command source kind mismatch");
    if (normalizeHex32(sourceRow.user, "command source user") !== normalizeHex32(pending.expected.user, "expected user")) throw new Error("withdrawal command source user mismatch");
    if (Number(sourceRow.withdrawal_nonce) !== pending.expected.withdrawalNonce) throw new Error("withdrawal command source nonce mismatch");
    if (normalizeHex32(sourceRow.origin_ref_id, "command origin_ref_id") !== normalizeHex32(pending.expected.originRefId, "expected origin_ref_id")) throw new Error("withdrawal command origin reference mismatch");
    const height = Number(record.created_height);
    if (!Number.isSafeInteger(height) || height < 0) throw new Error("withdrawal command created height is invalid");
    return height;
  }

  private async reconcile(pending: PendingSignedWithdrawal, timeoutMs: number): Promise<BridgeWithdrawalResult> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    let authenticatedAtHeight: number | null = null;
    do {
      const context = await this.authContext();
      const startHeight = Math.max(pending.prepared.issued_at_height + 1, pending.lastScannedHeight + 1);
      for (let height = startHeight; height <= context.last_accepted_height; height++) {
        const events = await this.collider.call<unknown[]>("colliderV2.getBlockEventsAt", [height]);
        for (const event of events) {
          const auth = eventPayload(event, "SignedIntentAuthenticated");
          if (auth
            && cleanHex(auth.signer) === cleanHex(pending.prepared.signer)
            && Number(auth.nonce) === pending.prepared.nonce
            && String(auth.action) === pending.prepared.action
            && cleanHex(auth.payload_hash) === cleanHex(pending.prepared.payload_hash)) {
            authenticatedAtHeight = height;
          }
        }
        pending.lastScannedHeight = height;
      }

      let command: unknown = null;
      try {
        command = await this.collider.call<unknown>("colliderV2.getBridgeWithdrawalCommand", [pending.preview.request_id]);
      } catch {
        command = null;
      }
      if (command) {
        const reservedAtHeight = this.validateCommand(command, pending);
        const balances = await this.collider.call<Record<string, string>>("colliderV2.getBalances", [pending.expected.user]);
        const balanceAfter = String(balances[pending.expected.asset] ?? balances[pending.expected.asset.toLowerCase()] ?? "0");
        const expectedAfter = BigInt(pending.balanceBefore) - BigInt(pending.expected.amount);
        if (BigInt(balanceAfter) !== expectedAfter) throw new Error("withdrawal command exists but accepted Collider balance delta is not exact");
        const result: BridgeWithdrawalResult = {
          status: "withdrawal_reserved",
          signer: pending.prepared.signer,
          nonce: pending.prepared.nonce,
          payloadHash: pending.prepared.payload_hash,
          opId: pending.submission?.op_id ?? null,
          requestId: pending.preview.request_id,
          authenticatedAtHeight,
          reservedAtHeight,
          balanceBefore: pending.balanceBefore,
          balanceAfter,
          submitError: pending.submitError,
        };
        await this.store.complete(pending, result);
        return result;
      }

      const nonceConsumed = Number(context.user?.accepted_next_nonce ?? 0) > pending.prepared.nonce;
      if (authenticatedAtHeight != null || nonceConsumed) {
        const result: BridgeWithdrawalResult = {
          ...pendingResult(pending),
          status: "authenticated_business_rejected",
          authenticatedAtHeight,
        };
        await this.store.complete(pending, result);
        return result;
      }
      if (context.last_accepted_height > pending.prepared.valid_until_height) {
        const result: BridgeWithdrawalResult = { ...pendingResult(pending), status: "expired" };
        await this.store.complete(pending, result);
        return result;
      }
      await this.store.savePending(pending);
      if (Date.now() >= deadline) break;
      await sleep(Math.max(250, this.options.reconcilePollMs ?? 1_500));
    } while (Date.now() <= deadline);
    return pendingResult(pending);
  }

  async reconcilePendingWithdrawal(timeoutMs = 0): Promise<BridgeWithdrawalResult | null> {
    const pending = await this.store.loadPending();
    return pending ? this.reconcile(pending, timeoutMs) : null;
  }

  async observeWithdrawal(params: {
    requestId: Hex32;
    asset: Hex32;
    amount: string;
    evmTxHash?: Hex32 | null;
  }): Promise<BridgeWithdrawalObservation> {
    const requestId = normalizeHex32(params.requestId, "request_id");
    const asset = normalizeHex32(params.asset, "asset");
    const amount = String(params.amount);
    if (!/^\d+$/.test(amount) || BigInt(amount) <= 0n) throw new Error("observed withdrawal amount must be a positive exact integer");
    await this.authContext();
    const stats = await this.collider.call<Record<string, unknown>>("colliderV2.getClcBridgeStats", []);
    const recent = Array.isArray(stats.withdrawal_recent) ? stats.withdrawal_recent : [];
    const record = recent.find((value) => value && typeof value === "object"
      && cleanHex((value as Record<string, unknown>).request_id) === cleanHex(requestId)) as Record<string, unknown> | undefined;
    if (!record) throw new Error("withdrawal request is not retained in the current bridge status window");
    if (normalizeHex32(record.asset, "observed asset") !== asset) throw new Error("observed withdrawal asset mismatch");
    if (String(record.amount) !== amount) throw new Error("observed withdrawal amount mismatch");
    if (normalizeHex32(record.to, "observed destination") !== normalizeHex32(this.wallet.userId, "wallet user")) throw new Error("observed withdrawal destination mismatch");
    const source = record.source;
    if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error("observed withdrawal source is missing");
    if (normalizeHex32((source as Record<string, unknown>).user, "observed source user") !== normalizeHex32(this.wallet.userId, "wallet user")) {
      throw new Error("observed withdrawal source user mismatch");
    }
    const balances = await this.collider.call<Record<string, string>>("colliderV2.getBalances", [this.wallet.userId]);
    const pendingByAsset = stats.pending_liability_by_asset as Record<string, unknown> | undefined;
    const collateralByAsset = stats.observed_recognized_collateral as Record<string, unknown> | undefined;

    let evmReceipt: BridgeWithdrawalObservation["evmReceipt"] = null;
    if (params.evmTxHash) {
      const txHash = normalizeHex32(params.evmTxHash, "EVM transaction hash");
      const receipt = await this.evm.call<Record<string, unknown> | null>("eth_getTransactionReceipt", [txHash]);
      if (!receipt) throw new Error("EVM withdrawal transaction has no receipt");
      const receiptStatus = Number(BigInt(String(receipt.status ?? "0x0")));
      if (receiptStatus !== 1) throw new Error("EVM withdrawal receipt did not succeed");
      const logs = Array.isArray(receipt.logs) ? receipt.logs : [];
      let exactTransferVerified = false;
      for (const value of logs) {
        if (!value || typeof value !== "object" || Array.isArray(value)) continue;
        const log = value as Record<string, unknown>;
        if (normalizeAddress(log.address, "EVM log address") !== normalizeAddress(this.options.assetPin.tokenAddress, "pinned token")) continue;
        try {
          const decoded = new Interface(["event Transfer(address indexed from,address indexed to,uint256 value)"]).parseLog({
            topics: log.topics as string[],
            data: String(log.data ?? "0x"),
          });
          if (decoded?.name === "Transfer"
            && normalizeAddress(decoded.args.from, "transfer source") === normalizeAddress(this.options.custodyContract, "custody contract")
            && normalizeAddress(decoded.args.to, "transfer destination") === normalizeAddress(this.wallet.address, "wallet address")
            && String(decoded.args.value) === amount) {
            exactTransferVerified = true;
          }
        } catch {
          // Ignore unrelated token logs; the exact transfer is required below.
        }
      }
      if (!exactTransferVerified) throw new Error("EVM receipt lacks the exact custody-to-wallet token transfer");
      evmReceipt = {
        txHash,
        status: receiptStatus,
        blockNumber: Number(BigInt(String(receipt.blockNumber ?? "0x0"))),
        blockHash: normalizeHex32(receipt.blockHash, "EVM receipt block hash"),
        exactTransferVerified,
      };
    }

    const observation: BridgeWithdrawalObservation = {
      requestId,
      status: String(record.status ?? "Unknown"),
      asset,
      amount,
      user: this.wallet.userId,
      createdHeight: Number(record.created_height),
      terminalHeight: record.terminal_height == null ? null : Number(record.terminal_height),
      terminalTs: record.terminal_ts == null ? null : Number(record.terminal_ts),
      acceptedBalance: String(balances[asset] ?? balances[asset.toLowerCase()] ?? "0"),
      pendingLiability: String(pendingByAsset?.[asset] ?? pendingByAsset?.[asset.toLowerCase()] ?? "0"),
      recognizedCollateral: String(collateralByAsset?.[asset] ?? collateralByAsset?.[asset.toLowerCase()] ?? "0"),
      evmReceipt,
    };
    if (observation.status === "Completed" && observation.terminalHeight == null) throw new Error("completed withdrawal is missing terminal height");
    await this.store.recordObservation(observation);
    return observation;
  }

  async requestWithdrawalSigned(args: BridgeWithdrawalArgs): Promise<BridgeWithdrawalResult> {
    const existing = await this.reconcilePendingWithdrawal(0);
    if (existing) throw new PendingSignedWithdrawalError(existing);

    const verified = await this.previewWithdrawal(args);
    const context = await this.authContext();
    const custodySignature = this.wallet.signDigest(verified.preview.custody_digest);
    if (!HEX_65_RE.test(custodySignature)) throw new Error("custody signature is not 65-byte hex");
    const prepared = await this.collider.call<PreparedSignedIntent>("colliderV2.prepareSignedIntent", [{
      signer: this.wallet.userId,
      method: "colliderV2.requestWithdrawal",
      params: [
        verified.expected.asset,
        verified.expected.user,
        verified.expected.amount,
        verified.expected.withdrawalNonce,
        verified.expected.originRefId,
        custodySignature,
      ],
      ttl_blocks: this.options.intentTtlBlocks ?? 32,
    }]);
    verifyPreparedWithdrawalIntent({
      prepared,
      context,
      expected: verified.expected,
      custodySignature,
      wallet: this.wallet,
      options: this.options,
    });
    const intentSignature = await this.wallet.signPreparedIntent(prepared);
    const pending: PendingSignedWithdrawal = {
      schema: "collider.agent1.signed-withdrawal.v1",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      prepared,
      expected: verified.expected,
      preview: verified.preview,
      custodySignature,
      intentSignature,
      submission: null,
      submitError: null,
      balanceBefore: verified.balanceBefore,
      lastScannedHeight: prepared.issued_at_height,
    };
    await this.store.savePending(pending);
    try {
      pending.submission = await this.collider.call<SubmittedSignedIntent>("colliderV2.submitSignedIntent", [{
        signer: prepared.signer,
        nonce: prepared.nonce,
        issued_at_height: prepared.issued_at_height,
        valid_until_height: prepared.valid_until_height,
        op_b64: prepared.op_b64,
        signature: intentSignature,
      }], { retries: 0 });
    } catch (error) {
      pending.submitError = String(error);
    }
    await this.store.savePending(pending);
    return this.reconcile(pending, this.options.reconcileTimeoutMs ?? 90_000);
  }
}
