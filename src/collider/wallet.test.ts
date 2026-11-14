import { NATIVE_DOMAIN_FIELDS, NATIVE_INTENT_FIELDS } from "./native-signing.js";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { encryptKeystoreJson, TypedDataEncoder, Wallet } from "ethers";

import type { PlaceThrowArgs, PreparedSignedIntent, Rc1AuthContext } from "./types.js";
import {
  AgentWallet,
  colliderUserIdFromEvmAddress,
  evmAddressFromColliderUserId,
  verifyPreparedPlaceThrow,
} from "./wallet.js";

function bytes(hexByte: string): number[] {
  return Array.from(Buffer.from(hexByte.repeat(32), "hex"));
}

test("wallet address maps to canonical Collider UserId and round-trips", async () => {
  const wallet = await AgentWallet.load(
    { signingKeyEnv: "TEST_KEY" },
    { TEST_KEY: `0x${"11".repeat(32)}` },
  );
  assert.ok(wallet);
  assert.equal(wallet.userId, colliderUserIdFromEvmAddress(wallet.address));
  assert.equal(evmAddressFromColliderUserId(wallet.userId), wallet.address.toLowerCase());
});

test("wallet loads a user-owned encrypted JSON keystore without exposing the password in settings", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent1-keystore-"));
  const keyFile = path.join(root, "agent1.json");
  const privateKey = `0x${"33".repeat(32)}`;
  const expected = new Wallet(privateKey);
  const password = "test-only-password";
  try {
    const json = await encryptKeystoreJson(
      { address: expected.address, privateKey },
      password,
      { scrypt: { N: 1024, r: 8, p: 1 } },
    );
    await writeFile(keyFile, json, { encoding: "utf8", mode: 0o600 });
    const wallet = await AgentWallet.load(
      { signingKeyFile: keyFile, signingKeyPasswordEnv: "TEST_KEY_PASSWORD" },
      { TEST_KEY_PASSWORD: password },
    );
    assert.ok(wallet);
    assert.equal(wallet.address, expected.address);
    assert.equal(wallet.source, "file");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("prepared RC1 throw is verified and signed without rounding its u128 amount", async () => {
  const wallet = await AgentWallet.load(
    { signingKeyEnv: "TEST_KEY" },
    { TEST_KEY: `0x${"22".repeat(32)}` },
  );
  assert.ok(wallet);
  const game = `0x${"aa".repeat(32)}`;
  const asset = `0x${"bb".repeat(32)}`;
  const commit = `0x${"cc".repeat(32)}`;
  const expected: PlaceThrowArgs = {
    game_id: game,
    user: wallet.userId,
    asset,
    amount: "340282366920938463463374607431768211455",
    init_pose: { pos: { x: 1.25, y: -2.5 }, angle_rad: 0.75 },
    init_linvel: { x: 3.5, y: 4.25 },
    init_angvel: -1.5,
    data_commit: commit,
  };
  const details = JSON.stringify({
    PlaceThrow: {
      game_id: bytes("aa"),
      user: Array.from(Buffer.from(wallet.userId.slice(2), "hex")),
      asset: bytes("bb"),
      amount: 0,
      init_pose: expected.init_pose,
      init_linvel: expected.init_linvel,
      init_angvel: expected.init_angvel,
      data_commit: bytes("cc"),
    },
  }).replace('"amount":0', `"amount":${expected.amount}`);
  const networkDomain = `0x${"dd".repeat(32)}`;
  const payloadHash = `0x${"ee".repeat(32)}`;
  const types = {
    EIP712Domain: NATIVE_DOMAIN_FIELDS,
    ColliderIntent: NATIVE_INTENT_FIELDS,
  };
  const domain = { name: "Collider V2", version: "2", chainId: 43113, salt: networkDomain };
  const message = {
    description: "Place throw on Collider L1", amount: expected.amount + " base units", asset, amountBaseUnits: expected.amount, token: "0x" + "00".repeat(20), target: game, recipient: "0x" + "00".repeat(20), signingEpoch: "0",
    signer: wallet.userId,
    action: "game.throw.place",
    details,
    nonce: "7",
    issuedAtHeight: "100",
    validUntilHeight: "132",
    payloadHash,
    networkDomain,
  };
  const prepared: PreparedSignedIntent = {
    native_intent_signing: { evm_chain_id: 43113, epoch: 0 },
    signer: wallet.userId,
    nonce: 7,
    issued_at_height: 100,
    valid_until_height: 132,
    action: "game.throw.place",
    details,
    payload_hash: payloadHash,
    network_domain: networkDomain,
    digest: TypedDataEncoder.hash(domain, { ColliderIntent: types.ColliderIntent }, message),
    op_b64: "AA==",
    typed_data: { types, primaryType: "ColliderIntent", domain, message },
  };
  const context: Rc1AuthContext = {
    network_id: 5,
    l1_id: `0x${"01".repeat(32)}`,
    chain_id: `0x${"02".repeat(32)}`,
    network_domain: networkDomain,
    domain_configured: true,
    last_accepted_height: 100,
    max_intent_lifetime_blocks: 128,
    native_intent_signing: { evm_chain_id: 43113, epoch: 0 },
    eip712: { name: "Collider V2", version: "2", chain_id: "43113", uses_chain_id: true, domain_separator_field: "salt" },
    user: {
      user_id: wallet.userId,
      canonical_wallet_user: true,
      accepted_next_nonce: 7,
      next_available_nonce: 7,
    },
  };

  verifyPreparedPlaceThrow({ prepared, context, expected, wallet, expectedNetworkDomain: networkDomain });
  const signature = await wallet.signPreparedIntent(prepared);
  assert.match(signature, /^0x[0-9a-f]{130}$/i);

  assert.throws(
    () => verifyPreparedPlaceThrow({
      prepared,
      context,
      expected: { ...expected, amount: "340282366920938463463374607431768211454" },
      wallet,
    }),
    /amount mismatch/,
  );
});
