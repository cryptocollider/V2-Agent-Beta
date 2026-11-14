import assert from "node:assert/strict";
import test from "node:test";
import { Interface } from "ethers";
import { BONDED_TOPUP, assertBondedTopupLocal, assertBondedTopupOrigin, bondedAttemptReceipt } from "./bonded-topup.js";
import { buildFujiBondedSettings } from "./fuji-bonded.js";
import { DEFAULT_SETTINGS } from "./settings.js";

test("additional bonded-chain deposit requires the exact owner and clean separate journal state", () => {
  const settings = buildFujiBondedSettings({ ...DEFAULT_SETTINGS, expectedEvmAddress: BONDED_TOPUP.wallet, signingKeyFile: "unused-test-key" });
  const clean = { originalFundingStage: "COMPLETE", nativePending: false, conversionPending: false, jobs: 0 };
  assert.doesNotThrow(() => assertBondedTopupLocal(settings, clean));
  for (const changed of [{ nativePending: true }, { conversionPending: true }, { jobs: 1 }, { originalFundingStage: "CHECKING" }]) {
    assert.throws(() => assertBondedTopupLocal(settings, { ...clean, ...changed }));
  }
  assert.throws(() => assertBondedTopupLocal({ ...settings, expectedEvmAddress: "0x" + "11".repeat(20) }, clean));
  assert.throws(() => assertBondedTopupLocal({ ...settings, expectedNetworkDomain: "0x" + "11".repeat(32) }, clean));
});
test("attempted top-ups require exact confirmed canonical receipts and never infer permission to replay", () => {
  const stored = { txHash: "0x" + "11".repeat(32), to: BONDED_TOPUP.custody };
  const receipt = { transactionHash: stored.txHash, to: stored.to, from: BONDED_TOPUP.wallet,
    status: "0x1", blockNumber: "0x5", blockHash: "0x" + "22".repeat(32) };
  assert.equal(bondedAttemptReceipt(stored, receipt, 6n).blockNumber, 5);
  assert.throws(() => bondedAttemptReceipt(stored, null, 6n), /no replay/);
  assert.throws(() => bondedAttemptReceipt(stored, receipt, 5n), /no replay/);
  for (const changed of [{ transactionHash: "0x" + "ff".repeat(32) }, { status: "0x0" },
    { to: BONDED_TOPUP.token }, { blockHash: "invalid" }, { from: BONDED_TOPUP.source }]) {
    assert.throws(() => bondedAttemptReceipt(stored, { ...receipt, ...changed }, 6n), /no replay/);
  }
});
test("additional origin proof binds the exact token, source, wallet, transaction and one DIEM", () => {
  const iface = new Interface(["event Transfer(address indexed from,address indexed to,uint256 value)"]);
  const event = iface.encodeEventLog(iface.getEvent("Transfer")!, [BONDED_TOPUP.source, BONDED_TOPUP.wallet, BONDED_TOPUP.amount]);
  const receipt = { status: "0x1", transactionHash: BONDED_TOPUP.origin,
    logs: [{ address: BONDED_TOPUP.token, ...event }] };
  assert.doesNotThrow(() => assertBondedTopupOrigin(receipt));
  for (const changed of [{ status: "0x0" }, { transactionHash: "0x" + "ff".repeat(32) }, { logs: [] },
    { logs: [...receipt.logs, ...receipt.logs] }, { logs: [{ ...receipt.logs[0], address: "0x" + "11".repeat(20) }] }]) {
    assert.throws(() => assertBondedTopupOrigin({ ...receipt, ...changed }));
  }
});
