import { NATIVE_DOMAIN_FIELDS, NATIVE_INTENT_FIELDS } from "./native-signing.js";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TypedDataEncoder } from "ethers";

import { ColliderClient } from "./client.js";
import type { PlaceThrowArgs, PreparedSignedIntent, Rc1AuthContext } from "./types.js";
import { AgentWallet } from "./wallet.js";

function bytes(hexByte: string): number[] {
  return Array.from(Buffer.from(hexByte.repeat(32), "hex"));
}

test("RC1 client prepares, signs, submits once, and distinguishes business outcome", async () => {
  for (const throwAccepted of [true, false]) {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent1-rc1-client-"));
    const wallet = await AgentWallet.load(
      { signingKeyEnv: "TEST_KEY" },
      { TEST_KEY: `0x${"33".repeat(32)}` },
    );
    assert.ok(wallet);

    const networkDomain = `0x${"dd".repeat(32)}`;
    const payloadHash = `0x${"ee".repeat(32)}`;
    const game = `0x${"aa".repeat(32)}`;
    const asset = `0x${"bb".repeat(32)}`;
    const commit = `0x${"cc".repeat(32)}`;
    const throwId = `0x${"44".repeat(32)}`;
    const opId = `0x${"55".repeat(32)}`;
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

    let submitted = false;
    let submitCalls = 0;
    const context = (): Rc1AuthContext => ({
      network_id: 5,
      l1_id: `0x${"01".repeat(32)}`,
      chain_id: `0x${"02".repeat(32)}`,
      network_domain: networkDomain,
      domain_configured: true,
      last_accepted_height: submitted ? 101 : 100,
      max_intent_lifetime_blocks: 128,
      native_intent_signing: { evm_chain_id: 43113, epoch: 0 },
    eip712: { name: "Collider V2", version: "2", chain_id: "43113", uses_chain_id: true, domain_separator_field: "salt" },
      user: {
        user_id: wallet.userId,
        canonical_wallet_user: true,
        accepted_next_nonce: submitted ? 8 : 7,
        next_available_nonce: submitted ? 8 : 7,
      },
    });

    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const rpc = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      let result: unknown;
      switch (rpc.method) {
        case "colliderV2.userIdFromEvmAddress":
          assert.equal(String(rpc.params[0]).toLowerCase(), wallet.address.toLowerCase());
          result = wallet.userId;
          break;
        case "colliderV2.getAuthContext":
          result = context();
          break;
        case "colliderV2.prepareSignedIntent":
          assert.equal(rpc.params[0].method, "colliderV2.placeThrow");
          assert.equal(rpc.params[0].params[0].amount, expected.amount);
          result = prepared;
          break;
        case "colliderV2.submitSignedIntent":
          submitCalls += 1;
          assert.match(rpc.params[0].signature, /^0x[0-9a-f]{130}$/i);
          submitted = true;
          result = { accepted: true, op_id: opId, signer: wallet.userId, nonce: 7 };
          break;
        case "colliderV2.getBlockEventsAt":
          assert.equal(rpc.params[0], 101);
          result = [{
            SignedIntentAuthenticated: {
              signer: wallet.userId,
              nonce: 7,
              action: "game.throw.place",
              payload_hash: payloadHash,
            },
          }];
          break;
        case "colliderV2.getSimInput":
          result = {
            throws: throwAccepted
              ? [{ id: throwId, user: wallet.userId, asset, amount: expected.amount, data_commit: bytes("cc"), accepted_at_height: 101 }]
              : [],
          };
          break;
        default:
          throw new Error(`unexpected RPC method ${rpc.method}`);
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const client = new ColliderClient(`http://127.0.0.1:${address.port}`, wallet, {
        expectedNetworkDomain: networkDomain,
        expectedNetworkId: 5,
        expectedL1Id: `0x${"01".repeat(32)}`,
        expectedChainId: `0x${"02".repeat(32)}`,
        intentStateFile: path.join(tempDir, "rc1-intent-state.json"),
        reconcilePollMs: 1,
        reconcileTimeoutMs: 2_000,
      });
      const result = await client.placeThrowSigned(expected, { decisionId: "decision-1" });
      assert.equal(result.status, throwAccepted ? "throw_accepted" : "authenticated_business_rejected");
      assert.equal(result.throwId, throwAccepted ? throwId : null);
      assert.equal(submitCalls, 1);

      const state = JSON.parse(await readFile(path.join(tempDir, "rc1-intent-state.json"), "utf8"));
      assert.equal(state.pending, null);
      const audit = await readFile(path.join(tempDir, "rc1-signed-intents.jsonl"), "utf8");
      assert.match(audit, throwAccepted ? /"status":"throw_accepted"/ : /"status":"authenticated_business_rejected"/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(tempDir, { recursive: true, force: true });
    }
  }
});
