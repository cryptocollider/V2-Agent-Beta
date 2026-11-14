import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { TypedDataEncoder, verifyTypedData } from "ethers";
import { assertNativeSigningContext, verifyNativePreparedEnvelope } from "./native-signing.js";
import type { PreparedSignedIntent, Rc1AuthContext } from "./types.js";

const vectors = JSON.parse(await readFile(new URL("./fixtures/native-signing-vectors.json", import.meta.url), "utf8"));
for (const vector of vectors) {
  test(`published v2 vector: ${vector.action}`, () => {
    const message = vector.typed_data.message;
    const prepared: PreparedSignedIntent = {
      native_intent_signing: vector.policy, signer: message.signer, action: vector.action,
      nonce: Number(message.nonce), issued_at_height: Number(message.issuedAtHeight),
      valid_until_height: Number(message.validUntilHeight), details: message.details,
      payload_hash: message.payloadHash, network_domain: message.networkDomain,
      digest: vector.digest, op_b64: vector.op_b64, typed_data: vector.typed_data,
    };
    const context = { native_intent_signing: vector.policy, network_domain: message.networkDomain,
      eip712: { name: "Collider V2", version: "2", uses_chain_id: true,
        chain_id: "43113", domain_separator_field: "salt" } } as unknown as Rc1AuthContext;
    verifyNativePreparedEnvelope(prepared, context, 43113);
    assert.equal(verifyTypedData(vector.typed_data.domain,
      { ColliderIntent: vector.typed_data.types.ColliderIntent }, message, vector.signature).toLowerCase(), vector.signer_address.toLowerCase());
    for (const field of ["description", "amount", "amountBaseUnits", "token", "target", "recipient", "details", "signingEpoch"]) {
      const changed = structuredClone(prepared);
      const typed = changed.typed_data as typeof vector.typed_data;
      typed.message[field] = field === "signingEpoch" || field === "amountBaseUnits" ? "999"
        : field === "token" || field === "recipient" ? "0x" + "fe".repeat(20)
        : field === "target" ? "0x" + "fe".repeat(32) : String(typed.message[field]) + "!";
      assert.throws(() => verifyNativePreparedEnvelope(changed, context, 43113));
    }
    const changed = structuredClone(prepared);
    const typed = changed.typed_data as typeof vector.typed_data;
    typed.domain.chainId = "43114";
    changed.digest = TypedDataEncoder.hash(typed.domain, { ColliderIntent: typed.types.ColliderIntent }, typed.message);
    assert.throws(() => verifyNativePreparedEnvelope(changed, context, 43113), /policy mismatch/);
    assert.throws(() => assertNativeSigningContext({ ...context, eip712: { ...context.eip712, version: "1" } }), /v2/);
    assert.throws(() => verifyNativePreparedEnvelope({ ...prepared, native_intent_signing: { evm_chain_id: 43113, epoch: 1 } }, context), /policy mismatch/);
  });
}
