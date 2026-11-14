import { TypedDataEncoder, type TypedDataDomain, type TypedDataField } from "ethers";
import type { PreparedSignedIntent, Rc1AuthContext } from "./types.js";

export const NATIVE_DOMAIN_FIELDS: TypedDataField[] = [
  { name: "name", type: "string" }, { name: "version", type: "string" },
  { name: "chainId", type: "uint256" }, { name: "salt", type: "bytes32" },
];
export const NATIVE_INTENT_FIELDS: TypedDataField[] = [
  { name: "signer", type: "bytes32" }, { name: "action", type: "string" },
  { name: "description", type: "string" }, { name: "amount", type: "string" },
  { name: "asset", type: "bytes32" }, { name: "amountBaseUnits", type: "uint256" },
  { name: "token", type: "address" }, { name: "target", type: "bytes32" },
  { name: "recipient", type: "address" }, { name: "details", type: "string" },
  { name: "signingEpoch", type: "uint256" }, { name: "nonce", type: "uint256" },
  { name: "issuedAtHeight", type: "uint256" }, { name: "validUntilHeight", type: "uint256" },
  { name: "payloadHash", type: "bytes32" }, { name: "networkDomain", type: "bytes32" },
];
type SigningPolicy = { evm_chain_id: number; epoch: number };

export function assertNativeSigningContext(context: Rc1AuthContext, expectedChainId?: number | null): SigningPolicy {
  const policy = context.native_intent_signing as SigningPolicy | undefined;
  if (!policy || !Number.isSafeInteger(policy.evm_chain_id) || policy.evm_chain_id <= 0
      || !Number.isSafeInteger(policy.epoch) || policy.epoch < 0
      || context.eip712?.name !== "Collider V2" || context.eip712.version !== "2"
      || context.eip712.uses_chain_id !== true || context.eip712.domain_separator_field !== "salt"
      || context.eip712.chain_id !== String(policy.evm_chain_id)
      || (expectedChainId != null && policy.evm_chain_id !== expectedChainId)) {
    throw new Error("RPC native signing v2 policy or EVM chain context mismatch");
  }
  return policy;
}

/** Validate exactly the v2 schema, policy and envelope; never synthesize/fallback fields. */
export function verifyNativePreparedEnvelope(prepared: PreparedSignedIntent, context?: Rc1AuthContext,
  expectedChainId?: number | null): void {
  const typed = prepared.typed_data as { primaryType?: string; types?: Record<string, TypedDataField[]>;
    domain?: TypedDataDomain; message?: Record<string, unknown> } | null;
  const policy = prepared.native_intent_signing;
  const domain = typed?.domain;
  const message = typed?.message;
  const fieldsEqual = (actual: TypedDataField[] | undefined, expected: TypedDataField[]) =>
    Array.isArray(actual) && actual.length === expected.length
      && actual.every((field, index) => field.name === expected[index].name && field.type === expected[index].type);
  if (!policy || !Number.isSafeInteger(policy.evm_chain_id) || policy.evm_chain_id <= 0
      || !Number.isSafeInteger(policy.epoch) || policy.epoch < 0
      || typed?.primaryType !== "ColliderIntent" || !domain || !message
      || !fieldsEqual(typed.types?.EIP712Domain, NATIVE_DOMAIN_FIELDS)
      || !fieldsEqual(typed.types?.ColliderIntent, NATIVE_INTENT_FIELDS)
      || Object.keys(typed.types ?? {}).some(key => !["EIP712Domain", "ColliderIntent"].includes(key))
      || Object.keys(domain).some(key => !["name", "version", "chainId", "salt"].includes(key))
      || Object.keys(message).length !== NATIVE_INTENT_FIELDS.length
      || domain.name !== "Collider V2" || domain.version !== "2"
      || String(domain.chainId) !== String(policy.evm_chain_id)
      || String(message.signingEpoch) !== String(policy.epoch)
      || String(domain.salt).toLowerCase() !== prepared.network_domain.toLowerCase()
      || (expectedChainId != null && policy.evm_chain_id !== expectedChainId)) {
    throw new Error("prepared native signing v2 schema/domain/policy mismatch");
  }
  if (context) {
    const discovered = assertNativeSigningContext(context, expectedChainId);
    if (policy.epoch !== discovered.epoch || policy.evm_chain_id !== discovered.evm_chain_id
        || prepared.network_domain.toLowerCase() !== context.network_domain.toLowerCase()) {
      throw new Error("prepared signing policy differs from live discovery");
    }
  }
  const expected: Record<string, unknown> = { signer: prepared.signer, action: prepared.action,
    details: prepared.details, nonce: prepared.nonce, issuedAtHeight: prepared.issued_at_height,
    validUntilHeight: prepared.valid_until_height, payloadHash: prepared.payload_hash,
    networkDomain: prepared.network_domain };
  for (const [key, value] of Object.entries(expected)) {
    if (String(message[key]) !== String(value)) throw new Error(`native typed-data ${key} mismatch`);
  }
  const digest = TypedDataEncoder.hash(domain, { ColliderIntent: NATIVE_INTENT_FIELDS }, message);
  if (digest.toLowerCase() !== prepared.digest.toLowerCase()) throw new Error("local native v2 digest mismatch");
}
