import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { commitment, decodeBase64, decodePolicy, nativeDomain, parseExactJson, roundId, verifyFrozen,
  mature, canCommit, canReveal, type Pins, type Round } from "./contract.js";
import { runFrozenWasm } from "./wasm.js";
import { decodeGameResult } from "../sim/decode.js";
import { pointPlan, workloadBucket } from "./audit.js";

const fixture = await readFile(path.resolve("src/confirmations/fixtures/confirmation-v2-vectors-20261020.json"));
assert.equal(createHash("sha256").update(fixture).digest("hex"), "e61733c56766ec950067951edc74a0d44d34e3390e223fc60d333a225d25780d");
export const vectors = JSON.parse(fixture.toString()).vectors;
export const wasmPath = path.resolve("assets/confirmations/v2-20261020/sim_core.wasm");
export function vectorTask(v = vectors[0]): { round: Round; frozen: any; pins: Pins } {
  const pins = { networkId: v.native_domain.network_id, l1Id: "0x" + Buffer.from(v.native_domain.l1_id).toString("hex"),
    chainId: "0x" + Buffer.from(v.native_domain.chain_id).toString("hex"), networkDomain: v.network_domain, signingChainId: 43113 };
  const round: Round = { game_id: v.game_id, round_id: v.round_id, input_hash: v.input_hash,
    policy_hash: v.policy_hash, artifact_hash: v.artifact_hash, digest_version: v.digest_version,
    closed_height: v.closed_height, closed_time: v.closed_time, policy: v.policy, phase: "Commit",
    commit_deadline: { height: "12", time: "105" }, void_deadline: { height: "10010", time: "86500" },
    reveal_deadline: null, finalized_height: null, value_e8: "400000000", throw_count: 4, frame_cap: v.frame_cap,
    global_points_allowed: true, candidates: [] };
  return { round, pins, frozen: { ...Object.fromEntries(["game_id", "round_id", "input_hash", "policy_hash", "artifact_hash", "digest_version", "codec", "input_base64", "policy_base64"].map(k => [k, v[k]])) } };
}
for (const [index, v] of vectors.entries()) {
  test("independent candidate WASM full binary/decoded result and all envelopes vector " + index, async () => {
    const { round, frozen, pins } = vectorTask(v);
    assert.equal(nativeDomain(pins), v.network_domain);
    const { input, policy } = verifyFrozen(round, frozen, pins, 1_048_576);
    assert.equal(policy.bond_clc, "10000000000000000");
    const computed = await runFrozenWasm(wasmPath, input);
    assert.deepEqual(computed.bytes, Buffer.from(v.result_base64, "base64"));
    assert.deepEqual(computed.result, decodeGameResult(Buffer.from(v.result_base64, "base64")));
    assert.equal("0x" + computed.result.final_hash, v.result_final_hash);
    assert.equal(roundId(round, pins.networkDomain), v.round_id);
    assert.equal(commitment(round, pins.networkDomain, v.user_id, "0x" + computed.result.final_hash, v.salt), v.commitment);
    for (const key of ["game_id", "round_id", "input_hash", "artifact_hash"] as const) {
      const changed = { ...round, [key]: "0x" + "ff".repeat(32) };
      assert.notEqual(commitment(changed, pins.networkDomain, v.user_id, v.result_final_hash, v.salt), v.commitment);
      assert.throws(() => verifyFrozen(changed, frozen, pins, 1_048_576));
    }
    for (const [domain, user, answer, salt] of [
      ["0x" + "ef".repeat(32), v.user_id, v.result_final_hash, v.salt],
      [pins.networkDomain, "0x" + "ef".repeat(32), v.result_final_hash, v.salt],
      [pins.networkDomain, v.user_id, "0x" + "ef".repeat(32), v.salt],
      [pins.networkDomain, v.user_id, v.result_final_hash, "0x" + "ef".repeat(32)],
    ]) assert.notEqual(commitment(round, domain, user, answer, salt), v.commitment);
    assert.throws(() => verifyFrozen({ ...round, policy: { ...round.policy, bond_clc: "1" } }, frozen, pins, 1_048_576), /policy/);
    assert.notEqual(commitment({ ...round, policy: { ...round.policy, version: "2" } }, pins.networkDomain, v.user_id, v.result_final_hash, v.salt), v.commitment);
    assert.notEqual(commitment({ ...round, digest_version: 1 }, pins.networkDomain, v.user_id, v.result_final_hash, v.salt), v.commitment);
  });
}
test("lossless scalars, exact policy decode, and AND clocks", () => {
  assert.deepEqual(parseExactJson('{"value":18446744073709551615,"inside":"12345678901234567890","small":5}'),
    { value: "18446744073709551615", inside: "12345678901234567890", small: 5 });
  assert.throws(() => parseExactJson('{"value":1.2}'));
  assert.throws(() => decodeBase64("%%%=", 100));
  assert.throws(() => decodePolicy(Buffer.from(vectors[0].policy_base64, "base64").subarray(0, 12)));
  const { round } = vectorTask();
  assert.equal(mature(round.commit_deadline, 12, 104), false);
  assert.equal(mature(round.commit_deadline, 11, 105), false);
  assert.equal(mature(round.commit_deadline, 12, 105), true);
  assert.equal(canCommit(round, 10, 101), false);
  assert.equal(canCommit(round, 11, 106), true);
  assert.equal(canCommit(round, 12, 105), false);
  const reveal = { ...round, phase: "Reveal", finalized_height: "13", reveal_deadline: { height: "15", time: "230" } };
  assert.equal(canReveal(reveal, 13, 112), false);
  assert.equal(canReveal(reveal, 15, 229), true);
  assert.equal(canReveal(reveal, 15, 230), false);
});
test("below-threshold evidence has zero reward; tied heights share fastest, shared includes fastest, dust stays unissued", () => {
  const policy = decodePolicy(Buffer.from(vectors[0].policy_base64, "base64"));
  const candidates = [{ user: "a", correct: true, accepted_height: "11" }, { user: "b", correct: true, accepted_height: "11" },
    { user: "c", correct: true, accepted_height: "12" }];
  assert.deepEqual(pointPlan(policy, "40000000", true, candidates), { a: "0", b: "0", c: "0" });
  assert.deepEqual(pointPlan(policy, "400000000", false, candidates), { a: "0", b: "0", c: "0" });
  assert.deepEqual(pointPlan(policy, "400000000", true, candidates), { a: "41", b: "41", c: "16" });
  assert.deepEqual([0, 9, 10, 200, 201, 500, 501].map(workloadBucket), [0, 0, 1, 1, 2, 2, 3]);
});
test("retired artifact cannot be run, candidate worker has a hard compute timeout", async () => {
  await assert.rejects(runFrozenWasm(path.resolve("assets/sim_core.wasm"), new Uint8Array()), /unreviewed/);
  await assert.rejects(runFrozenWasm(wasmPath, Buffer.from(vectors[0].input_base64, "base64"), 1), /timed out/);
});
