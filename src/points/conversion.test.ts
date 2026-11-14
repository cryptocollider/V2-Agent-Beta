import { NATIVE_DOMAIN_FIELDS, NATIVE_INTENT_FIELDS } from "../collider/native-signing.js";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { TypedDataEncoder } from "ethers";
import { PointsConversionService, pointsNeededForTarget } from "./conversion.js";
import { ColliderClient } from "../collider/client.js";
import { AgentWallet, verifyPreparedPointsRedemption } from "../collider/wallet.js";
import type { PreparedSignedIntent, Rc1AuthContext } from "../collider/types.js";

test("auto-convert target math uses exact base units and stops at the target", () => {
  assert.equal(pointsNeededForTarget("5000000000000000000", "0", "1500"), "7500");
  assert.equal(pointsNeededForTarget("5000000000000000000", "4999000000000000000", "1500"), "2");
  assert.equal(pointsNeededForTarget("5000000000000000000", "5000000000000000000", "1500"), "0");
  assert.equal(pointsNeededForTarget("5000000000000000000", "6000000000000000000", "1500"), "0");
});

test("conversion is disabled by default and config validation is fail-closed", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "agent1-points-config-"));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  const pendingHook: { check: () => Promise<boolean> } = { check: async () => false };
  const client = {
    setExternalPendingIntentCheck(check: () => Promise<boolean>) { pendingHook.check = check; },
  } as unknown as ColliderClient;
  const wallet = { userId: "0x" + "11".repeat(32) } as AgentWallet;
  const service = new PointsConversionService(client, wallet, {}, dir);
  await service.init();
  assert.equal((await pendingHook.check()), false);
  const first = await service.status();
  assert.equal(first.config.enabled, false);
  assert.equal(first.config.targetClcBase, "5000000000000000000");
  assert.deepEqual(first.history, []);

  const saved = await service.saveConfig({ enabled: true, targetClcBase: "7000000000000000000", maxPointsPerClc: "1200", minPointsPerConversion: "10" });
  assert.equal(saved.enabled, true);
  assert.equal(saved.maxPointsPerClc, "1200");
  const persisted = JSON.parse(await readFile(path.join(dir, "points-conversion-config.json"), "utf8"));
  assert.deepEqual(persisted, saved);
  await assert.rejects(service.saveConfig({ maxPointsPerClc: "0" }), /positive exact integer/);
  await assert.rejects(service.saveConfig({ enabled: "yes" as unknown as boolean }), /enabled must be boolean/);
  assert.deepEqual((await service.status()).config, saved);

  await writeFile(path.join(dir, "rc1-points-conversion-state.json"), JSON.stringify({ pending: { schema: "collider.agent1.points-conversion-pending.v1", prepared: { nonce: 8 } } }));
  assert.equal((await pendingHook.check()), true);
});

test("automatic conversion stays off by default and respects a worse live rate", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "agent1-points-rate-"));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  let quoteCalls = 0;
  const client = {
    setExternalPendingIntentCheck() {},
    async getBalances() { return {}; },
    async getLadderUser() { return { points_total: "8000", throw_count: "100" }; },
    async getClcRedemptionQuote() {
      quoteCalls++;
      return { enabled: true, points_per_clc: "1501", points_in: "1", clc_out: "666222518321119" };
    },
  } as unknown as ColliderClient;
  const wallet = { userId: "0x" + "11".repeat(32) } as AgentWallet;
  const service = new PointsConversionService(client, wallet, {}, dir);
  await service.init();
  await service.maybeAutoConvert();
  assert.equal(quoteCalls, 0);
  await service.saveConfig({ enabled: true, maxPointsPerClc: "1500" });
  await service.maybeAutoConvert();
  assert.equal(quoteCalls, 1);
  assert.equal((await service.status()).history.length, 0);
});

test("one signed redemption is journaled, reconciled, and idempotent by request id", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "agent1-points-signed-"));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  const wallet = await AgentWallet.load({ signingKeyEnv: "TEST_KEY" }, { TEST_KEY: `0x${"44".repeat(32)}` });
  assert.ok(wallet);
  const networkDomain = `0x${"dd".repeat(32)}`;
  const payloadHash = `0x${"ee".repeat(32)}`;
  const details = JSON.stringify({ RedeemPointsForClc: {
    user: [...Buffer.from(wallet.userId.slice(2), "hex")], points_in: 0,
  } }).replace('"points_in":0', '"points_in":1500');
  const types = {
    ColliderIntent: NATIVE_INTENT_FIELDS,
  };
  const domain = { name: "Collider V2", version: "2", chainId: 43113, salt: networkDomain };
  const message = {
    description: "Redeem points for CLC", amount: "No single asset amount; review details", asset: "0x" + "00".repeat(32), amountBaseUnits: "0", token: "0x" + "00".repeat(20), target: "0x" + "00".repeat(32), recipient: "0x" + "00".repeat(20), signingEpoch: "0",
    signer: wallet.userId, action: "clc.points.redeem", details,
    nonce: "7", issuedAtHeight: "100", validUntilHeight: "132", payloadHash, networkDomain,
  };
  const prepared: PreparedSignedIntent = {
    native_intent_signing: { evm_chain_id: 43113, epoch: 0 },
    signer: wallet.userId, nonce: 7, issued_at_height: 100, valid_until_height: 132,
    action: "clc.points.redeem", details, payload_hash: payloadHash,
    network_domain: networkDomain,
    digest: TypedDataEncoder.hash(domain, types, message), op_b64: "AA==",
    typed_data: { types: { EIP712Domain: NATIVE_DOMAIN_FIELDS, ...types }, primaryType: "ColliderIntent", domain, message },
  };
  let submitted = false;
  let submits = 0;
  const context = (): Rc1AuthContext => ({
    network_id: 5, l1_id: `0x${"01".repeat(32)}`, chain_id: `0x${"02".repeat(32)}`,
    network_domain: networkDomain, domain_configured: true,
    last_accepted_height: submitted ? 101 : 100, max_intent_lifetime_blocks: 128,
    native_intent_signing: { evm_chain_id: 43113, epoch: 0 },
    eip712: { name: "Collider V2", version: "2", chain_id: "43113", uses_chain_id: true, domain_separator_field: "salt" },
    user: { user_id: wallet.userId, canonical_wallet_user: true,
      accepted_next_nonce: submitted ? 8 : 7, next_available_nonce: submitted ? 8 : 7 },
  });
  assert.throws(() => verifyPreparedPointsRedemption({
    prepared: { ...prepared, details: details.replace('"points_in":1500', '"points_in":1501') },
    context: context(), user: wallet.userId, pointsIn: "1500", wallet,
    expectedNetworkDomain: networkDomain, expectedNetworkId: 5,
    expectedL1Id: `0x${"01".repeat(32)}`, expectedChainId: `0x${"02".repeat(32)}`,
  }), /payload mismatch/);
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const rpc = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    let result: unknown;
    switch (rpc.method) {
      case "colliderV2.getLadderUser": result = { points_total: "2000", throw_count: "50" }; break;
      case "colliderV2.getClcRedemptionQuote":
        assert.equal(rpc.params[1], "1500");
        result = { enabled: true, disable_reason: null, points_in: "1500", points_per_clc: "1500", clc_out: "1000000000000000000" };
        break;
      case "colliderV2.getAuthContext": result = context(); break;
      case "colliderV2.prepareSignedIntent":
        assert.equal(rpc.params[0].method, "colliderV2.redeemPointsForClc");
        assert.deepEqual(rpc.params[0].params, [wallet.userId, "1500"]);
        result = prepared;
        break;
      case "colliderV2.submitSignedIntent":
        submits++;
        assert.match(rpc.params[0].signature, /^0x[0-9a-f]{130}$/i);
        submitted = true;
        result = { accepted: true, op_id: `0x${"55".repeat(32)}`, signer: wallet.userId, nonce: 7 };
        break;
      case "colliderV2.getBlockEventsAt":
        assert.equal(rpc.params[0], 101);
        result = [
          { SignedIntentAuthenticated: { signer: wallet.userId, nonce: 7, action: "clc.points.redeem", payload_hash: payloadHash } },
          { PointsRedeemed: { user: wallet.userId, points_in: "1500", clc_out: "1000000000000000000", points_per_clc: "1500" } },
        ];
        break;
      default: throw new Error(`unexpected RPC ${rpc.method}`);
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise((resolve) => server.close(() => resolve(undefined))); });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const client = new ColliderClient(`http://127.0.0.1:${address.port}`, wallet, {
    expectedNetworkDomain: networkDomain, expectedNetworkId: 5,
    expectedL1Id: `0x${"01".repeat(32)}`, expectedChainId: `0x${"02".repeat(32)}`,
    intentStateFile: path.join(dir, "rc1-intent-state.json"),
  });
  const service = new PointsConversionService(client, wallet, {
    expectedNetworkDomain: networkDomain, expectedNetworkId: 5,
    expectedL1Id: `0x${"01".repeat(32)}`, expectedChainId: `0x${"02".repeat(32)}`,
  }, dir);
  await service.init();
  const request = { pointsIn: "1500", expectedPointsPerClc: "1500", requestId: "test-convert-1", source: "manual" as const };
  const first = await service.redeem(request);
  assert.equal(first.status, "confirmed");
  assert.equal("clcOutBase" in first ? first.clcOutBase : null, "1000000000000000000");
  assert.equal(submits, 1);
  assert.equal((await service.status()).pending, null);
  assert.equal((await service.status()).history.length, 1);
  const duplicate = await service.redeem(request);
  assert.deepEqual(duplicate, first);
  assert.equal(submits, 1);
  const auditFile = path.join(dir, "rc1-points-conversions.jsonl");
  for (let i = 0; i < 41; i++) {
    await appendFile(auditFile, JSON.stringify({ ...first, requestId: `older-test-${i}`, nonce: 100 + i }) + "\n");
  }
  assert.equal((await service.status()).history.length, 40);
  assert.deepEqual(await service.redeem(request), first);
  assert.equal(submits, 1, "a request outside the bounded monitor history must not be signed again");
});
