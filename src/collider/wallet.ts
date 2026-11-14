import { protectLocalSecret } from '../core/os-wallet.js';
import { readFile } from "node:fs/promises";
import {
  recoverAddress,
  TypedDataEncoder,
  verifyMessage,
  verifyTypedData,
  Wallet,
  type BaseWallet,
  type TransactionRequest,
  type TypedDataDomain,
  type TypedDataField,
} from "ethers";

import type { PlaceThrowArgs, PreparedSignedIntent, Rc1AuthContext } from "./types.js";
import { verifyNativePreparedEnvelope } from "./native-signing.js";

const HEX_20_RE = /^0x[0-9a-f]{40}$/i;
const HEX_32_RE = /^0x[0-9a-f]{64}$/i;
const RAW_PRIVATE_KEY_RE = /^(?:0x)?[0-9a-f]{64}$/i;

export type WalletSourceSettings = {
  signingKeyFile?: string | null;
  signingKeyEnv?: string | null;
  signingKeyPasswordEnv?: string | null;
  expectedEvmAddress?: string | null;
};

export type Rc1TypedData = {
  types: Record<string, TypedDataField[]>;
  primaryType: string;
  domain: TypedDataDomain;
  message: Record<string, unknown>;
};

export class AgentWallet {
  private constructor(private wallet: BaseWallet | null, readonly source: "environment" | "file", private lockedAddress?: string, private lockedFile?: string) {}
  private get activeWallet(): BaseWallet { if (!this.wallet) throw Error("Wallet locked; unlock it in Bank / Wallet security"); return this.wallet; }
  get isLocked(): boolean { return !this.wallet; }
  async unlock(password: string): Promise<void> {
    if (!this.lockedFile) return;
    let wallet: BaseWallet;
    try { wallet = await Wallet.fromEncryptedJson(await readFile(this.lockedFile, "utf8"), password); }
    catch { throw Error("Wallet password is incorrect"); }
    if (wallet.address.toLowerCase() !== this.address.toLowerCase()) throw Error("Wallet identity differs");
    this.wallet = wallet;
  }

  static async load(
    settings: WalletSourceSettings,
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<AgentWallet | null> {
    const keyFile = String(settings.signingKeyFile ?? "").trim();
    const keyEnv = String(settings.signingKeyEnv ?? "COLLIDER_AGENT_PRIVATE_KEY").trim();
    const passwordEnv = String(settings.signingKeyPasswordEnv ?? "COLLIDER_AGENT_KEY_PASSWORD").trim();

    let source: "environment" | "file";
    let material: string;
    if (keyFile) {
      source = "file";
      material = (await readFile(keyFile, "utf8")).trim();
    } else if (keyEnv && String(env[keyEnv] ?? "").trim()) {
      source = "environment";
      material = String(env[keyEnv]).trim();
    } else {
      return null;
    }

    let wallet: BaseWallet;
    if (material.startsWith("{")) {
      const stored = JSON.parse(material);
      let password = passwordEnv ? String(env[passwordEnv] ?? "") : "";
      if (stored.schema === "agent1.os-protected-wallet.v1") {
        password = (await protectLocalSecret(Buffer.from(stored.protectedPassword, "base64"), true)).toString("utf8");
        material = stored.keystore;
      }
      if (!password) {
        const address = normalizeEvmAddress(stored.address);
        if (!address || !keyFile || (settings.expectedEvmAddress && normalizeEvmAddress(settings.expectedEvmAddress) !== address)) throw Error("Encrypted wallet address differs from its profile");
        return new AgentWallet(null, "file", address, keyFile);
      }
      wallet = await Wallet.fromEncryptedJson(material, password);
    } else {
      if (!RAW_PRIVATE_KEY_RE.test(material)) {
        throw new Error("signing key must be a 32-byte hex private key or an encrypted JSON keystore");
      }
      wallet = new Wallet(material.startsWith("0x") ? material : `0x${material}`);
    }

    const expectedAddress = normalizeEvmAddress(settings.expectedEvmAddress);
    if (expectedAddress && wallet.address.toLowerCase() !== expectedAddress.toLowerCase()) {
      throw new Error(`signing key address ${wallet.address} does not match expectedEvmAddress ${expectedAddress}`);
    }
    return new AgentWallet(wallet, source);
  }

  async encrypt(password: string): Promise<string> {
    return await new Wallet(this.activeWallet.privateKey).encrypt(password);
  }

  get address(): string {
    return this.wallet?.address ?? this.lockedAddress!;
  }

  get userId(): string {
    return colliderUserIdFromEvmAddress(this.address);
  }

  async signPreparedIntent(prepared: PreparedSignedIntent): Promise<string> {
    verifyNativePreparedEnvelope(prepared);
    const typedData = normalizeTypedData(prepared.typed_data);
    const intentTypes = { ColliderIntent: typedData.types.ColliderIntent ?? [] };
    const signature = await this.activeWallet.signTypedData(typedData.domain, intentTypes, typedData.message);
    const recovered = verifyTypedData(typedData.domain, intentTypes, typedData.message, signature);
    if (recovered.toLowerCase() !== this.address.toLowerCase()) {
      throw new Error("locally produced signed intent did not recover to the configured wallet");
    }
    return signature;
  }

  signDigest(digest: string): string {
    const normalized = normalizeHex32(digest, "digest");
    const signature = this.activeWallet.signingKey.sign(normalized).serialized;
    if (recoverAddress(normalized, signature).toLowerCase() !== this.address.toLowerCase()) {
      throw new Error("locally produced digest signature did not recover to the configured wallet");
    }
    return signature;
  }

  async signPersonalMessage(message: string): Promise<string> {
    const signature = await this.activeWallet.signMessage(message);
    if (verifyMessage(message, signature).toLowerCase() !== this.address.toLowerCase()) {
      throw new Error("locally produced personal signature did not recover to the configured wallet");
    }
    return signature;
  }

  async signEvmTransaction(transaction: TransactionRequest): Promise<string> {
    return await this.activeWallet.signTransaction(transaction);
  }
}

export function normalizeEvmAddress(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const prefixed = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (!HEX_20_RE.test(prefixed)) throw new Error("expected EVM address must be 20-byte hex");
  return prefixed.toLowerCase();
}

export function colliderUserIdFromEvmAddress(address: string): string {
  const normalized = normalizeEvmAddress(address);
  if (!normalized) throw new Error("missing EVM address");
  return `0x${"00".repeat(12)}${normalized.slice(2)}`;
}

export function evmAddressFromColliderUserId(userId: string): string {
  const normalized = normalizeHex32(userId, "Collider UserId");
  if (!/^0x0{24}[0-9a-f]{40}$/i.test(normalized) || /^0x0{64}$/i.test(normalized)) {
    throw new Error("Collider UserId is not canonical wallet-backed form");
  }
  return `0x${normalized.slice(-40)}`;
}

function normalizeHex32(value: unknown, label: string): string {
  const raw = String(value ?? "").trim();
  const prefixed = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (!HEX_32_RE.test(prefixed)) throw new Error(`${label} must be 32-byte hex`);
  return prefixed.toLowerCase();
}

function normalizeTypedData(value: unknown): Rc1TypedData {
  if (!value || typeof value !== "object") throw new Error("prepared intent is missing typed_data");
  const raw = value as Record<string, unknown>;
  if (!raw.types || typeof raw.types !== "object") throw new Error("prepared typed_data is missing types");
  if (!raw.domain || typeof raw.domain !== "object") throw new Error("prepared typed_data is missing domain");
  if (!raw.message || typeof raw.message !== "object") throw new Error("prepared typed_data is missing message");
  return {
    types: raw.types as Record<string, TypedDataField[]>,
    primaryType: String(raw.primaryType ?? ""),
    domain: raw.domain as TypedDataDomain,
    message: raw.message as Record<string, unknown>,
  };
}

function arrayHex(value: unknown, label: string): string {
  if (!Array.isArray(value) || value.length !== 32) throw new Error(`${label} must be a 32-byte array`);
  const bytes = value.map((entry) => Number(entry));
  if (bytes.some((entry) => !Number.isInteger(entry) || entry < 0 || entry > 255)) {
    throw new Error(`${label} contains invalid bytes`);
  }
  return `0x${Buffer.from(bytes).toString("hex")}`;
}

function parsePlaceThrowDetails(details: string): Record<string, unknown> {
  // serde_json emits u128 as an unquoted JSON integer. Quote only the amount
  // before parsing so JavaScript never rounds the canonical base-unit value.
  const exactJson = details.replace(/"amount"\s*:\s*(\d+)/, '"amount":"$1"');
  const parsed = JSON.parse(exactJson) as Record<string, unknown>;
  const op = parsed.PlaceThrow;
  if (!op || typeof op !== "object" || Array.isArray(op)) {
    throw new Error("prepared intent details are not a PlaceThrow operation");
  }
  return op as Record<string, unknown>;
}

function canonicalF32(value: unknown, label: string): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) throw new Error(`${label} is not finite`);
  return Math.fround(numeric);
}

function assertCanonicalF32(actual: unknown, expected: number, label: string): void {
  if (canonicalF32(actual, label) !== canonicalF32(expected, label)) throw new Error(`${label} does not match requested throw`);
}

function assertVec2(actual: unknown, expected: { x: number; y: number }, label: string): void {
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) throw new Error(`${label} is missing`);
  const row = actual as Record<string, unknown>;
  assertCanonicalF32(row.x, expected.x, `${label}.x`);
  assertCanonicalF32(row.y, expected.y, `${label}.y`);
}

function assertPreparedThrowDetails(details: string, expected: PlaceThrowArgs): void {
  const op = parsePlaceThrowDetails(details);
  const expectedCommit = expected.data_commit ? normalizeHex32(expected.data_commit, "data_commit") : null;
  const actualCommit = op.data_commit == null ? null : arrayHex(op.data_commit, "details.data_commit");
  if (arrayHex(op.game_id, "details.game_id") !== normalizeHex32(expected.game_id, "game_id")) throw new Error("prepared game_id mismatch");
  if (arrayHex(op.user, "details.user") !== normalizeHex32(expected.user, "user")) throw new Error("prepared user mismatch");
  if (arrayHex(op.asset, "details.asset") !== normalizeHex32(expected.asset, "asset")) throw new Error("prepared asset mismatch");
  if (String(op.amount ?? "") !== String(expected.amount)) throw new Error("prepared exact amount mismatch");
  if (actualCommit !== expectedCommit) throw new Error("prepared data_commit mismatch");
  if (!op.init_pose || typeof op.init_pose !== "object" || Array.isArray(op.init_pose)) throw new Error("prepared init_pose is missing");
  const pose = op.init_pose as Record<string, unknown>;
  assertVec2(pose.pos, expected.init_pose.pos, "prepared init_pose.pos");
  assertCanonicalF32(pose.angle_rad, expected.init_pose.angle_rad, "prepared init_pose.angle_rad");
  assertVec2(op.init_linvel, expected.init_linvel, "prepared init_linvel");
  assertCanonicalF32(op.init_angvel, expected.init_angvel, "prepared init_angvel");
}

export function verifyPreparedPlaceThrow(params: {
  prepared: PreparedSignedIntent;
  context: Rc1AuthContext;
  expected: PlaceThrowArgs;
  wallet: AgentWallet;
  expectedNetworkDomain?: string | null;
  expectedNetworkId?: number | null;
  expectedL1Id?: string | null;
  expectedChainId?: string | null;
  expectedSigningChainId?: number | null;
}): void {
  const { prepared, context, expected, wallet } = params;
  const signer = normalizeHex32(prepared.signer, "prepared signer");
  if (signer !== wallet.userId.toLowerCase() || signer !== normalizeHex32(expected.user, "throw user")) {
    throw new Error("prepared intent signer does not match the configured Agent1 wallet");
  }
  if (prepared.action !== "game.throw.place") throw new Error(`unexpected prepared action ${prepared.action}`);
  if (!Number.isSafeInteger(prepared.nonce) || prepared.nonce < 0) throw new Error("prepared nonce is not a safe non-negative integer");
  if (!Number.isSafeInteger(prepared.issued_at_height) || !Number.isSafeInteger(prepared.valid_until_height)) {
    throw new Error("prepared height exceeds JavaScript safe-integer range");
  }
  if (prepared.valid_until_height <= prepared.issued_at_height) throw new Error("prepared intent has invalid expiry window");
  if (context.user && prepared.nonce !== context.user.next_available_nonce) throw new Error("prepared nonce does not match current auth context");

  const networkDomain = normalizeHex32(prepared.network_domain, "prepared network_domain");
  if (networkDomain !== normalizeHex32(context.network_domain, "auth network_domain")) throw new Error("prepared network domain differs from auth context");
  if (params.expectedNetworkDomain && networkDomain !== normalizeHex32(params.expectedNetworkDomain, "expected network domain")) {
    throw new Error("RPC network domain does not match the configured production-testnet domain");
  }
  if (params.expectedNetworkId != null && context.network_id !== params.expectedNetworkId) throw new Error("RPC Avalanche network id mismatch");
  if (params.expectedL1Id && normalizeHex32(context.l1_id, "auth l1_id") !== normalizeHex32(params.expectedL1Id, "expected l1_id")) throw new Error("RPC L1 id mismatch");
  if (params.expectedChainId && normalizeHex32(context.chain_id, "auth chain_id") !== normalizeHex32(params.expectedChainId, "expected chain_id")) throw new Error("RPC chain id mismatch");
  if (!context.domain_configured) throw new Error("RPC reports an unconfigured RC1 auth domain");

  assertPreparedThrowDetails(prepared.details, expected);
  const typedData = normalizeTypedData(prepared.typed_data);
  if (typedData.primaryType !== "ColliderIntent") throw new Error("unexpected EIP-712 primary type");
  const message = typedData.message;
  if (String(message.signer).toLowerCase() !== signer) throw new Error("typed-data signer mismatch");
  if (String(message.action) !== prepared.action) throw new Error("typed-data action mismatch");
  if (String(message.details) !== prepared.details) throw new Error("typed-data details mismatch");
  if (String(message.nonce) !== String(prepared.nonce)) throw new Error("typed-data nonce mismatch");
  if (String(message.issuedAtHeight) !== String(prepared.issued_at_height)) throw new Error("typed-data issued height mismatch");
  if (String(message.validUntilHeight) !== String(prepared.valid_until_height)) throw new Error("typed-data expiry mismatch");
  if (normalizeHex32(message.payloadHash, "typed-data payloadHash") !== normalizeHex32(prepared.payload_hash, "prepared payload_hash")) throw new Error("typed-data payload hash mismatch");
  if (normalizeHex32(message.networkDomain, "typed-data networkDomain") !== networkDomain) throw new Error("typed-data network domain mismatch");
  verifyNativePreparedEnvelope(prepared, context, params.expectedSigningChainId);
  if (String(message.amountBaseUnits) !== expected.amount
      || String(message.asset).toLowerCase() !== normalizeHex32(expected.asset, "asset")
      || String(message.target).toLowerCase() !== normalizeHex32(expected.game_id, "game_id")) {
    throw new Error("prepared throw presentation amount/asset/target mismatch");
  }
  if (normalizeHex32(typedData.domain.salt, "typed-data domain salt") !== networkDomain) throw new Error("typed-data domain salt mismatch");

  const digest = TypedDataEncoder.hash(
    typedData.domain,
    { ColliderIntent: typedData.types.ColliderIntent ?? [] },
    typedData.message,
  ).toLowerCase();
  if (digest !== normalizeHex32(prepared.digest, "prepared digest")) throw new Error("local EIP-712 digest does not match the VM-prepared digest");
}

/** Verify the exact operation and EIP-712 envelope before signing a points redemption. */
export function verifyPreparedPointsRedemption(params: {
  prepared: PreparedSignedIntent;
  context: Rc1AuthContext;
  user: string;
  pointsIn: string;
  wallet: AgentWallet;
  expectedNetworkDomain?: string | null;
  expectedNetworkId?: number | null;
  expectedL1Id?: string | null;
  expectedChainId?: string | null;
  expectedSigningChainId?: number | null;
}): void {
  const { prepared, context, wallet } = params;
  const signer = normalizeHex32(prepared.signer, "prepared signer");
  if (signer !== wallet.userId.toLowerCase() || signer !== normalizeHex32(params.user, "redemption user")) {
    throw new Error("prepared redemption signer does not match the configured Agent1 wallet");
  }
  if (prepared.action !== "clc.points.redeem") throw new Error(`unexpected redemption action ${prepared.action}`);
  if (!/^\d+$/.test(params.pointsIn) || BigInt(params.pointsIn) <= 0n) throw new Error("redemption points must be a positive exact integer");
  if (!Number.isSafeInteger(prepared.nonce) || prepared.nonce < 0) throw new Error("prepared nonce is invalid");
  if (!Number.isSafeInteger(prepared.issued_at_height) || !Number.isSafeInteger(prepared.valid_until_height)
      || prepared.valid_until_height <= prepared.issued_at_height) throw new Error("prepared redemption expiry is invalid");
  if (!context.user || prepared.nonce !== context.user.next_available_nonce) throw new Error("prepared redemption nonce does not match auth context");
  const networkDomain = normalizeHex32(prepared.network_domain, "prepared network_domain");
  if (!context.domain_configured || networkDomain !== normalizeHex32(context.network_domain, "auth network_domain")) throw new Error("redemption auth domain mismatch");
  if (params.expectedNetworkDomain && networkDomain !== normalizeHex32(params.expectedNetworkDomain, "expected network domain")) throw new Error("redemption network domain pin mismatch");
  if (params.expectedNetworkId != null && context.network_id !== params.expectedNetworkId) throw new Error("redemption Avalanche network id mismatch");
  if (params.expectedL1Id && normalizeHex32(context.l1_id, "auth l1_id") !== normalizeHex32(params.expectedL1Id, "expected l1_id")) throw new Error("redemption L1 id mismatch");
  if (params.expectedChainId && normalizeHex32(context.chain_id, "auth chain_id") !== normalizeHex32(params.expectedChainId, "expected chain_id")) throw new Error("redemption chain id mismatch");

  // Quote the u128 value before JSON parsing so JavaScript cannot round it.
  const exactDetails = prepared.details.replace(/"points_in"\s*:\s*(\d+)/, '"points_in":"$1"');
  const operation = (JSON.parse(exactDetails) as { RedeemPointsForClc?: Record<string, unknown> }).RedeemPointsForClc;
  if (!operation || arrayHex(operation.user, "redemption details.user") !== signer
      || String(operation.points_in ?? "") !== params.pointsIn) throw new Error("prepared redemption payload mismatch");

  const typedData = normalizeTypedData(prepared.typed_data);
  if (typedData.primaryType !== "ColliderIntent") throw new Error("unexpected redemption EIP-712 primary type");
  const message = typedData.message;
  if (normalizeHex32(message.signer, "typed signer") !== signer
      || String(message.action) !== prepared.action
      || String(message.details) !== prepared.details
      || String(message.nonce) !== String(prepared.nonce)
      || String(message.issuedAtHeight) !== String(prepared.issued_at_height)
      || String(message.validUntilHeight) !== String(prepared.valid_until_height)
      || normalizeHex32(message.payloadHash, "typed payloadHash") !== normalizeHex32(prepared.payload_hash, "prepared payloadHash")
      || normalizeHex32(message.networkDomain, "typed networkDomain") !== networkDomain) {
    throw new Error("prepared redemption typed-data mismatch");
  }
  verifyNativePreparedEnvelope(prepared, context, params.expectedSigningChainId);
  const digest = TypedDataEncoder.hash(
    typedData.domain,
    { ColliderIntent: typedData.types.ColliderIntent ?? [] },
    message,
  ).toLowerCase();
  if (digest !== normalizeHex32(prepared.digest, "prepared digest")) throw new Error("local redemption EIP-712 digest mismatch");
}
