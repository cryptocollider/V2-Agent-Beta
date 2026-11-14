import { NATIVE_DOMAIN_FIELDS, NATIVE_INTENT_FIELDS } from "./native-signing.js";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Interface, recoverAddress, TypedDataEncoder } from "ethers";

import type { BridgeWithdrawalArgs, BridgeWithdrawalPreview, PreparedSignedIntent, Rc1AuthContext } from "./types.js";
import { AgentWallet } from "./wallet.js";
import {
  type Rc1WithdrawalClientOptions,
  verifyBridgeWithdrawalPreview,
  verifyPreparedWithdrawalIntent,
} from "./withdrawal.js";

function bytes(hex: string): number[] {
  return Array.from(Buffer.from(hex.replace(/^0x/, ""), "hex"));
}

test("RC1 withdrawal verifies both custody and Collider EIP-712 payloads field by field", async () => {
  const wallet = await AgentWallet.load(
    { signingKeyEnv: "TEST_KEY" },
    { TEST_KEY: `0x${"44".repeat(32)}` },
  );
  assert.ok(wallet);

  const asset = `0x${"01".repeat(32)}`;
  const originRefId = `0x${"e3".repeat(32)}`;
  const requestId = `0x${"b4".repeat(32)}`;
  const policyHash = `0x${"e2".repeat(32)}`;
  const routeId = `0x${"3a".repeat(32)}`;
  const networkDomain = `0x${"dd".repeat(32)}`;
  const l1Id = `0x${"11".repeat(32)}`;
  const chainId = `0x${"22".repeat(32)}`;
  const tokenAddress = "0x5425890298aed601595a70ab815c96711a31bc65";
  const custodyContract = "0xc73a331cd4d49856e95321deffabad33d5088f05";
  const expectedAttestor = "0xaad8b1f57773375abd8482a159f33901c8f6b9f4";
  const expected: BridgeWithdrawalArgs = {
    asset,
    user: wallet.userId,
    amount: "340282366920938463463374607431768211455",
    withdrawalNonce: 4,
    originRefId,
  };
  const options: Rc1WithdrawalClientOptions = {
    expectedNetworkDomain: networkDomain,
    expectedNetworkId: 5,
    expectedL1Id: l1Id,
    expectedChainId: chainId,
    expectedEvmChainId: 43113,
    custodyContract,
    routeId,
    expectedAttestor,
    assetPin: { tokenAddress, policyHash, minWithdrawalAmount: "100000" },
    stateFile: "unused.json",
  };

  const custodyTypes = {
    EIP712Domain: [
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
      { name: "salt", type: "bytes32" },
    ],
    CustodyWithdrawal: [
      { name: "requestId", type: "bytes32" },
      { name: "policyHash", type: "bytes32" },
      { name: "token", type: "address" },
      { name: "beneficiary", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "action", type: "uint8" },
      { name: "authorityKind", type: "uint8" },
    ],
  };
  const custodyDomain = {
    name: "Collider V2 Custody",
    version: "1",
    chainId: "43113",
    verifyingContract: custodyContract,
    salt: routeId,
  };
  const custodyMessage = {
    requestId,
    policyHash,
    token: tokenAddress,
    beneficiary: wallet.address,
    amount: expected.amount,
    action: "1",
    authorityKind: "1",
  };
  const custodyDigest = TypedDataEncoder.hash(
    custodyDomain,
    { CustodyWithdrawal: custodyTypes.CustodyWithdrawal },
    custodyMessage,
  );
  const preview: BridgeWithdrawalPreview = {
    attestor_required_after_acceptance: true,
    custody_digest: custodyDigest,
    custody_typed_data: {
      types: custodyTypes,
      primaryType: "CustodyWithdrawal",
      domain: custodyDomain,
      message: custodyMessage,
    },
    expected_attestor_after_acceptance: expectedAttestor,
    expected_user_signer: wallet.address,
    origin_ref_id: originRefId,
    policy_hash: policyHash,
    request_id: requestId,
    route_id: routeId,
    user_custody_signature_required: true,
    withdrawal_nonce: 4,
  };
  verifyBridgeWithdrawalPreview({ preview, expected, wallet, options });

  const custodySignature = wallet.signDigest(custodyDigest);
  assert.equal(recoverAddress(custodyDigest, custodySignature).toLowerCase(), wallet.address.toLowerCase());
  const details = JSON.stringify({
    RequestWithdrawal: {
      token: bytes(asset),
      user: bytes(wallet.userId),
      amount: 0,
      withdrawal_nonce: 4,
      origin_ref_id: bytes(originRefId),
      custody_signature: bytes(custodySignature),
    },
  }).replace('"amount":0', `"amount":${expected.amount}`);
  const intentTypes = {
    EIP712Domain: NATIVE_DOMAIN_FIELDS,
    ColliderIntent: NATIVE_INTENT_FIELDS,
  };
  const payloadHash = `0x${"ee".repeat(32)}`;
  const intentDomain = { name: "Collider V2", version: "2", chainId: 43113, salt: networkDomain };
  const intentMessage = {
    description: "Withdraw to your custody-chain wallet", amount: expected.amount + " base units", asset, amountBaseUnits: expected.amount, token: tokenAddress, target: originRefId, recipient: wallet.address, signingEpoch: "0",
    signer: wallet.userId,
    action: "bridge.withdraw.request",
    details,
    nonce: "14",
    issuedAtHeight: "7907",
    validUntilHeight: "7939",
    payloadHash,
    networkDomain,
  };
  const prepared: PreparedSignedIntent = {
    native_intent_signing: { evm_chain_id: 43113, epoch: 0 },
    signer: wallet.userId,
    nonce: 14,
    issued_at_height: 7907,
    valid_until_height: 7939,
    action: "bridge.withdraw.request",
    details,
    payload_hash: payloadHash,
    network_domain: networkDomain,
    digest: TypedDataEncoder.hash(intentDomain, { ColliderIntent: intentTypes.ColliderIntent }, intentMessage),
    op_b64: "AA==",
    typed_data: { types: intentTypes, primaryType: "ColliderIntent", domain: intentDomain, message: intentMessage },
  };
  const context: Rc1AuthContext = {
    network_id: 5,
    l1_id: l1Id,
    chain_id: chainId,
    network_domain: networkDomain,
    domain_configured: true,
    last_accepted_height: 7907,
    max_intent_lifetime_blocks: 512,
    native_intent_signing: { evm_chain_id: 43113, epoch: 0 },
    eip712: { name: "Collider V2", version: "2", chain_id: "43113", uses_chain_id: true, domain_separator_field: "salt" },
    user: {
      user_id: wallet.userId,
      canonical_wallet_user: true,
      accepted_next_nonce: 14,
      next_available_nonce: 14,
    },
  };
  verifyPreparedWithdrawalIntent({ prepared, context, expected, custodySignature, wallet, options });

  assert.throws(
    () => verifyBridgeWithdrawalPreview({
      preview: {
        ...preview,
        custody_typed_data: {
          types: custodyTypes,
          primaryType: "CustodyWithdrawal",
          domain: custodyDomain,
          message: { ...custodyMessage, amount: "100000" },
        },
      },
      expected,
      wallet,
      options,
    }),
    /amount mismatch/,
  );
  assert.throws(
    () => verifyPreparedWithdrawalIntent({
      prepared: { ...prepared, action: "game.throw.place" },
      context,
      expected,
      custodySignature,
      wallet,
      options,
    }),
    /unexpected prepared action/,
  );
});

test("terminal withdrawal observation verifies the exact EVM transfer and appends an audit", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent1-withdrawal-observation-"));
  const wallet = await AgentWallet.load(
    { signingKeyEnv: "TEST_KEY" },
    { TEST_KEY: `0x${"55".repeat(32)}` },
  );
  assert.ok(wallet);
  const asset = `0x${"01".repeat(32)}`;
  const requestId = `0x${"b4".repeat(32)}`;
  const txHash = `0x${"34".repeat(32)}`;
  const blockHash = `0x${"ee".repeat(32)}`;
  const networkDomain = `0x${"dd".repeat(32)}`;
  const l1Id = `0x${"11".repeat(32)}`;
  const chainId = `0x${"22".repeat(32)}`;
  const tokenAddress = "0x5425890298aed601595a70ab815c96711a31bc65";
  const custodyContract = "0xc73a331cd4d49856e95321deffabad33d5088f05";
  const transfer = new Interface(["event Transfer(address indexed from,address indexed to,uint256 value)"])
    .encodeEventLog("Transfer", [custodyContract, wallet.address, 100000n]);

  const colliderServer = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const rpc = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    let result: unknown;
    if (rpc.method === "colliderV2.getAuthContext") {
      result = {
        network_id: 5,
        l1_id: l1Id,
        chain_id: chainId,
        network_domain: networkDomain,
        domain_configured: true,
        last_accepted_height: 8288,
        max_intent_lifetime_blocks: 512,
        native_intent_signing: { evm_chain_id: 43113, epoch: 0 },
    eip712: { name: "Collider V2", version: "2", chain_id: "43113", uses_chain_id: true, domain_separator_field: "salt" },
        user: { user_id: wallet.userId, canonical_wallet_user: true, accepted_next_nonce: 15, next_available_nonce: 15 },
      };
    } else if (rpc.method === "colliderV2.getClcBridgeStats") {
      result = {
        withdrawal_recent: [{
          request_id: requestId,
          asset,
          amount: "100000",
          to: wallet.userId,
          status: "Completed",
          created_height: 7933,
          terminal_height: 8288,
          terminal_ts: 1791137626,
          source: { kind: "user", user: wallet.userId },
        }],
        pending_liability_by_asset: { [asset]: "0" },
        observed_recognized_collateral: { [asset]: "2600000" },
      };
    } else if (rpc.method === "colliderV2.getBalances") {
      result = { [asset]: "595850" };
    } else {
      throw new Error(`unexpected Collider RPC ${rpc.method}`);
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
  });
  const evmServer = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const rpc = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    assert.equal(rpc.method, "eth_getTransactionReceipt");
    const result = {
      transactionHash: txHash,
      status: "0x1",
      blockNumber: "0x170",
      blockHash,
      logs: [{ address: tokenAddress, topics: transfer.topics, data: transfer.data }],
    };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
  });
  await new Promise<void>((resolve) => colliderServer.listen(0, "127.0.0.1", resolve));
  await new Promise<void>((resolve) => evmServer.listen(0, "127.0.0.1", resolve));

  try {
    const colliderAddress = colliderServer.address();
    const evmAddress = evmServer.address();
    assert.ok(colliderAddress && typeof colliderAddress === "object");
    assert.ok(evmAddress && typeof evmAddress === "object");
    const options: Rc1WithdrawalClientOptions = {
      expectedNetworkDomain: networkDomain,
      expectedNetworkId: 5,
      expectedL1Id: l1Id,
      expectedChainId: chainId,
      expectedEvmChainId: 43113,
      custodyContract,
      routeId: `0x${"3a".repeat(32)}`,
      expectedAttestor: "0xaad8b1f57773375abd8482a159f33901c8f6b9f4",
      assetPin: { tokenAddress, policyHash: `0x${"e2".repeat(32)}`, minWithdrawalAmount: "100000" },
      stateFile: path.join(tempDir, "rc1-withdrawal-state.json"),
    };
    const client = new (await import("./withdrawal.js")).Rc1WithdrawalClient(
      `http://127.0.0.1:${colliderAddress.port}`,
      `http://127.0.0.1:${evmAddress.port}`,
      wallet,
      options,
    );
    const observation = await client.observeWithdrawal({ requestId, asset, amount: "100000", evmTxHash: txHash });
    assert.equal(observation.status, "Completed");
    assert.equal(observation.terminalHeight, 8288);
    assert.equal(observation.evmReceipt?.exactTransferVerified, true);
    const audit = await readFile(path.join(tempDir, "rc1-withdrawal-observations.jsonl"), "utf8");
    assert.match(audit, /"status":"Completed"/);
    assert.match(audit, /"exactTransferVerified":true/);
  } finally {
    await new Promise<void>((resolve) => colliderServer.close(() => resolve()));
    await new Promise<void>((resolve) => evmServer.close(() => resolve()));
    await rm(tempDir, { recursive: true, force: true });
  }
});
