import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { TypedDataEncoder, verifyTypedData } from "ethers";
import { ColliderClient } from "../collider/client.js";
import { AgentWallet } from "../collider/wallet.js";
import { NATIVE_DOMAIN_FIELDS, NATIVE_INTENT_FIELDS } from "../collider/native-signing.js";
import type { PreparedSignedIntent, Rc1AuthContext, SubmitSignedIntentArgs } from "../collider/types.js";
import { BondedConfirmationService, CONFIRMATION_DEFAULT_BOUNDS, type ConfirmationConfig, type ConfirmationTransport, type Job } from "./service.js";
import { ConfirmationStore } from "./store.js";
import { CLC_ASSET, commitment, decodePolicy, type Round, type Pins } from "./contract.js";
import { decodeGameResult } from "../sim/decode.js";
import { verifyConfirmationOperation } from "./operation.js";

const vector = JSON.parse(await readFile(path.resolve("src/confirmations/fixtures/confirmation-v2-vectors-20261020.json"), "utf8")).vectors[0];
const bytes = (s: string) => [...Buffer.from(s.slice(2), "hex")];
const pins: Pins = { networkId: 5, l1Id: "0x" + "01".repeat(32), chainId: "0x" + "02".repeat(32),
  networkDomain: vector.network_domain, signingChainId: 43113 };
const config: ConfirmationConfig = { ...CONFIRMATION_DEFAULT_BOUNDS, enabled: true, pins,
  wasmPath: path.resolve("assets/confirmations/v2-20261020/sim_core.wasm"), clcToken: "0x" + "12".repeat(20) };
const baseRound = (): Round => ({ ...vector, policy: decodePolicy(Buffer.from(vector.policy_base64, "base64")),
  phase: "Commit", commit_deadline: { height: "12", time: "105" }, void_deadline: { height: "10010", time: "86500" },
  reveal_deadline: null, finalized_height: null, value_e8: "400000000", global_points_allowed: true,
  throw_count: 4, candidates: [], expected_hash: "0x" + "ff".repeat(32) } as Round);
class IsolatedNode extends ColliderClient implements ConfirmationTransport {
  height = 11; time = 101; nonce = 0; submissions = 0; reserved = false; queued = false; epoch = 0; policyEnabled = true;
  rejectReveal = false; deferRefund = false; mismatch = false; level = 1; mode: "accept" | "queue" = "accept";
  current: Round | null = baseRound(); calls: string[] = []; eventsByHeight = new Map<number, unknown[]>();
  preparedOps = new Map<string, { prepared: PreparedSignedIntent; op: any }>();
  mutate?: (prepared: PreparedSignedIntent, op: any) => void;
  constructor(readonly owner: AgentWallet) { super("http://127.0.0.1:1", owner); }
  context(): Rc1AuthContext {
    return { network_id: 5, l1_id: pins.l1Id, chain_id: pins.chainId, network_domain: pins.networkDomain,
      domain_configured: true, bonded_confirmations: 1, result_digest_version: 2,
      native_intent_signing: { epoch: this.epoch, evm_chain_id: 43113 }, last_accepted_height: this.height,
      max_intent_lifetime_blocks: 512, eip712: { name: "Collider V2", version: "2", chain_id: "43113",
        uses_chain_id: true, domain_separator_field: "salt" }, user: { user_id: this.owner.userId,
        canonical_wallet_user: true, accepted_next_nonce: this.nonce, next_available_nonce: this.nonce + (this.reserved ? 1 : 0) } };
  }
  async snapshot() { return { context: this.context(), height: this.height, time: this.time }; }
  async policy() { return { policy: { ...baseRound().policy, enabled: this.policyEnabled },
    artifact_hash: vector.artifact_hash, result_digest_version: 2 }; }
  async list() { this.calls.push("list"); return { rounds: this.current ? [{ game_id: vector.game_id, phase: this.current.phase }] : [] }; }
  async round() { return structuredClone(this.current); }
  async frozen() { this.calls.push("frozen"); return { ...vector }; }
  async stats() { return { committed: String(this.current?.candidates?.length ?? 0), correct: "0", points: "0", fastest_paid_wins: "0", correct_by_workload: [0, 0, 0, 0] }; }
  async ladder() { return { level: this.level, points_total: "123", throw_count: "20" }; }
  async balance() { return "1000000000000000000"; }
  async events(height: number) { return this.eventsByHeight.get(height) ?? []; }
  override async reconcilePendingSignedIntent() { return null; }
  override async getAuthContext() { return this.context(); }
  override async prepareSignedIntent(args: { signer: string; method: string; params: unknown[]; ttl_blocks?: number }): Promise<PreparedSignedIntent> {
    const p = args.params as any[];
    const commit = args.method === "colliderV2.commitGameConfirmation";
    assert.ok(commit || args.method === "colliderV2.revealGameConfirmation");
    const op = commit ? { user: bytes(args.signer), game_id: bytes(p[0]), round_id: bytes(p[1]),
      input_hash: bytes(p[2]), policy_version: p[3], bond_clc: p[4], commitment: bytes(p[5]) }
      : { user: bytes(args.signer), game_id: bytes(p[0]), round_id: bytes(p[1]), result_hash: bytes(p[2]), salt: bytes(p[3]) };
    const action = "game.confirm." + (commit ? "commit" : "reveal");
    const details = JSON.stringify({ [commit ? "CommitGameConfirmation" : "RevealGameConfirmation"]: op });
    const payloadHash = "0x" + createHash("sha256").update(details).digest("hex");
    const domain = { name: "Collider V2", version: "2", chainId: 43113, salt: pins.networkDomain };
    const message = { signer: args.signer, action, description: commit ? "Commit game confirmation; lock CLC bond" : "Reveal committed game confirmation",
      amount: commit ? "0.01 tokens (18 decimals)" : "No single asset amount; review details",
      asset: commit ? CLC_ASSET : "0x" + "00".repeat(32), amountBaseUnits: commit ? p[4] : "0",
      token: commit ? config.clcToken : "0x" + "00".repeat(20), target: p[0], recipient: "0x" + "00".repeat(20),
      details, signingEpoch: String(this.epoch), nonce: String(this.nonce), issuedAtHeight: String(this.height),
      validUntilHeight: String(this.height + 128), payloadHash, networkDomain: pins.networkDomain };
    const prepared: PreparedSignedIntent = { signer: args.signer, nonce: this.nonce, issued_at_height: this.height,
      valid_until_height: this.height + 128, action, details, payload_hash: payloadHash, network_domain: pins.networkDomain,
      native_intent_signing: { epoch: this.epoch, evm_chain_id: 43113 }, digest: TypedDataEncoder.hash(domain, { ColliderIntent: NATIVE_INTENT_FIELDS }, message),
      op_b64: Buffer.from(details).toString("base64"), typed_data: { domain, message, primaryType: "ColliderIntent",
        types: { EIP712Domain: NATIVE_DOMAIN_FIELDS, ColliderIntent: NATIVE_INTENT_FIELDS } } };
    this.mutate?.(prepared, op);
    this.preparedOps.set(prepared.op_b64, { prepared, op });
    return prepared;
  }
  override async submitSignedIntent(args: SubmitSignedIntentArgs) {
    this.submissions++;
    const stored = this.preparedOps.get(args.op_b64)!;
    assert.ok(stored); assert.equal(args.nonce, this.nonce);
    const t = stored.prepared.typed_data as any;
    assert.equal(verifyTypedData(t.domain, { ColliderIntent: t.types.ColliderIntent }, t.message, args.signature).toLowerCase(), this.owner.address.toLowerCase());
    if (this.height > args.valid_until_height) throw new Error("expired isolated intent");
    if (this.mode === "queue") { this.queued = true; this.reserved = true; }
    else this.apply(stored.prepared, stored.op);
    return { accepted: true, op_id: "0x" + "ab".repeat(32), signer: this.owner.userId, nonce: args.nonce };
  }
  apply(p: PreparedSignedIntent, op: any) {
    assert.equal(p.nonce, this.nonce, "nonce replay rejected");
    this.nonce++; this.height++; this.time++; this.reserved = false;
    const events: unknown[] = [{ SignedIntentAuthenticated: { signer: p.signer, nonce: p.nonce, action: p.action, payload_hash: p.payload_hash } }];
    const h = (v: number[]) => "0x" + Buffer.from(v).toString("hex");
    if (p.action.endsWith("commit")) {
      this.current!.candidates!.push({ user: p.signer, commitment: h(op.commitment), accepted_height: String(this.height),
        accepted_time: String(this.time), bond_clc_base: op.bond_clc, answer: null, correct: false, principal_returned: false, principal_forfeited: false });
      events.push({ type: "Confirmation", game_id: vector.game_id, round_id: vector.round_id, user: p.signer,
        stage: "Committed", amount_clc_base: op.bond_clc, answer: null });
    } else {
      if (this.rejectReveal) { this.eventsByHeight.set(this.height, events); return; }
      const c = this.current!.candidates![0];
      assert.equal(commitment(this.current!, pins.networkDomain, p.signer, h(op.result_hash), h(op.salt)), c.commitment);
      c.answer = h(op.result_hash); c.correct = !this.mismatch && c.answer === vector.result_final_hash;
      c.principal_returned = c.correct && !this.deferRefund;
      c.principal_forfeited = !c.correct;
      events.push({ type: "Confirmation", game_id: vector.game_id, round_id: vector.round_id, user: p.signer,
        stage: c.correct ? (this.deferRefund ? "Correct" : "Refunded") : "Forfeited", answer: c.answer });
    }
    this.eventsByHeight.set(this.height, events);
  }
  flush() {
    const last = [...this.preparedOps.values()].at(-1)!; this.mode = "accept"; this.apply(last.prepared, last.op); this.queued = false;
  }
  revealPhase() { this.height = 14; this.time = 110; this.current!.phase = "Reveal";
    this.current!.finalized_height = "13"; this.current!.reveal_deadline = { height: "15", time: "230" }; }
}
async function setup(t: any, options: Partial<ConfirmationConfig> = {}, fault?: (stage: string) => void) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent1-confirmation-"));
  const wallet = (await AgentWallet.load({ signingKeyEnv: "PUBLIC_TEST_KEY" }, { PUBLIC_TEST_KEY: "0x" + "19".repeat(32) }))!;
  const node = new IsolatedNode(wallet);
  let persistedEnabled: boolean | undefined;
  const published: unknown[][] = [];
  const hooks = { persistEnabled: async (enabled: boolean) => { persistedEnabled = enabled; },
    publish: async (jobs: unknown[]) => { published.push(jobs); } };
  let store = new ConfirmationStore(path.join(dir, "private"));
  let service = new BondedConfirmationService({ ...config, ...options }, store, node, wallet, node, undefined, fault, hooks);
  await service.init();
  t.after(async () => { await service.close(); await rm(dir, { recursive: true, force: true }); });
  return { node, wallet, published, get store() { return store; }, get service() { return service; },
    async restart(nextFault?: (stage: string) => void) {
      await service.close(); store = new ConfirmationStore(path.join(dir, "private"));
      service = new BondedConfirmationService({ ...config, ...options, enabled: persistedEnabled ?? options.enabled ?? config.enabled },
        store, node, wallet, node, undefined, nextFault, hooks);
      await service.init();
    } };
}
test("default disabled: no new work; admission alone is pending, native throw guard blocks reserved nonce, restart reveals original answer", async t => {
  const s = await setup(t, { enabled: false });
  assert.equal(await s.service.tick(), false); assert.equal(s.node.submissions, 0);
  s.service.config.enabled = true; s.node.mode = "queue";
  await s.service.tick();
  const first = (await s.store.jobs())[0];
  assert.equal(first.answer, vector.result_final_hash); // Poisoned public expected_hash was ignored.
  assert.equal(first.operations[0].resolved, undefined);
  await assert.rejects(s.node.placeThrowSigned({} as any), /external signed operation/);
  const publicStatus = JSON.stringify(await s.service.status());
  assert.ok(!publicStatus.includes(first.salt) && !publicStatus.includes("signature"));
  await s.restart(); await s.service.tick(); assert.equal(s.node.submissions, 1);
  s.node.flush(); await s.service.tick(false);
  assert.equal((await s.store.jobs())[0].state, "committed");
  await s.node.withSignedIntentLock(async () => { assert.equal(await s.node.hasExternalPendingIntent(), false); s.node.nonce++; });
  s.node.revealPhase(); s.service.config.enabled = false; // Existing principal obligation still reveals.
  await s.service.tick(false);
  const result = (await s.store.jobs())[0];
  assert.equal(result.state, "refunded"); assert.equal(result.salt, first.salt); assert.equal(s.node.submissions, 2);
  assert.equal(result.operations[1].prepared.nonce, 2);
});

test("enabled but level-zero waits without compute/signing; missing CLC is reported separately", async t => {
  const s = await setup(t); s.node.level = 0;
  s.node.balance = async () => "0";
  assert.equal(await s.service.tick(), false);
  assert.equal(s.node.submissions, 0); assert.ok(!s.node.calls.includes("frozen"));
  const status = await s.service.status();
  assert.equal(status.reason, "level_required"); assert.equal(status.eligibility.levelMet, false);
  assert.equal(status.eligibility.bondBalanceMet, false); assert.equal(status.stats.committed, "0");
  s.node.level = 1;
  assert.equal((await s.service.status()).reason, "clc_required");
});

test("overlapping qualification reads do not starve throws, while existing bonds retain priority", async t => {
  for (const bonded of [false, true]) {
    const s = await setup(t);
    if (bonded) await s.service.tick(); else s.node.level = 0;
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const original = s.node.snapshot.bind(s.node);
    s.node.snapshot = async () => { enter(); await gate; return original(); };
    const first = s.service.tick(false);
    await entered;
    try { assert.equal(await s.service.tick(false), bonded); }
    finally { release(); await first; }
    assert.equal(s.node.submissions, bonded ? 1 : 0);
  }
});

test("persisted switch cancels an unattempted commitment but still reveals accepted bonds", async t => {
  const unsigned = await setup(t, {}, stage => { if (stage === "signed") throw new Error("signed before toggle"); });
  await assert.rejects(unsigned.service.tick(), /signed before toggle/);
  await unsigned.service.saveEnabled(false); await unsigned.restart(); await unsigned.service.tick(false);
  assert.equal((await unsigned.store.jobs())[0].state, "cancelled"); assert.equal(unsigned.node.submissions, 0);
  assert.equal((await unsigned.service.status()).enabled, false);
  await assert.rejects(unsigned.service.saveEnabled("true"), /boolean/);
  const bonded = await setup(t);
  await bonded.service.tick(); await bonded.service.saveEnabled(false); await bonded.restart();
  bonded.node.revealPhase(); await bonded.service.tick(false);
  const job = (await bonded.store.jobs())[0];
  assert.equal(job.state, "refunded");
  const publicReceipt = JSON.stringify(bonded.published);
  assert.ok(!publicReceipt.includes(job.salt) && !publicReceipt.includes("signature") && !publicReceipt.includes("op_b64"));
  assert.ok(publicReceipt.includes("Refunded"));
});

test("the cumulative canary bound cannot be reset by toggling the enable flag", async t => {
  const s = await setup(t, { maxNewRounds: 1 }); await s.service.tick(); s.node.revealPhase(); await s.service.tick(false);
  await s.service.saveEnabled(false); await s.service.saveEnabled(true);
  const before = s.node.submissions;
  assert.equal(await s.service.tick(), false); assert.equal(s.node.submissions, before);
  assert.equal((await s.service.status()).reason, "round_limit");
});

test("reward audit continues after principal refund and preserves identical notices by canonical ordinal", async t => {
  const s = await setup(t); await s.service.tick(); s.node.revealPhase(); await s.service.tick(false);
  const before = (await s.store.jobs())[0];
  assert.equal(before.state, "refunded"); assert.equal(before.auditComplete, false);
  s.node.height++;
  const common = { type: "Confirmation", game_id: vector.game_id, round_id: vector.round_id, user: s.wallet.userId };
  s.node.eventsByHeight.set(s.node.height, [
    { ...common, stage: "PointsPaid", points: "50", amount_clc_base: "0" },
    { ...common, stage: "PointsPaid", points: "50", amount_clc_base: "0" },
    { ...common, stage: "FastestPaid", points: "0", amount_clc_base: "100000000000000000" },
  ]);
  s.node.current!.phase = "Complete";
  await s.service.tick(false);
  const job = (await s.store.jobs())[0];
  assert.equal(job.notices!.filter(n => n.stage === "PointsPaid").length, 2);
  assert.equal(job.notices!.find(n => n.stage === "FastestPaid")!.amountClcBase, "100000000000000000");
  assert.equal(job.auditComplete, true); assert.equal(job.state, "refunded"); assert.equal(s.node.submissions, 2);
});
for (const stage of ["computed", "prepared", "signed", "before_submit", "after_submit"]) {
  test("crash boundary persists original salt/answer: " + stage, async t => {
    let fired = false;
    const s = await setup(t, { maxJobs: 1 }, point => { if (!fired && point === stage) { fired = true; throw new Error("injected crash"); } });
    await assert.rejects(s.service.tick(), /injected crash/);
    const before = (await s.store.jobs())[0];
    await s.restart();
    if (stage === "before_submit") {
      await s.service.tick(); assert.equal(s.node.submissions, 0); // Attempt marker might have reached the wire: never guess/resend.
      s.node.height = 200; s.node.time = 500; await s.service.tick(); await s.service.tick();
      assert.equal((await s.store.jobs())[0].state, "expired"); assert.equal(s.node.submissions, 0);
    } else {
      await s.service.tick(stage !== "computed"); // Resume persisted stages, not a second task.
      if (stage === "computed") await s.service.tick();
      assert.equal(s.node.submissions, 1);
      s.node.revealPhase(); await s.service.tick(false);
      const after = (await s.store.jobs())[0];
      assert.equal(after.state, "refunded"); assert.equal(after.salt, before.salt); assert.equal(after.answer, before.answer);
      assert.equal(s.node.submissions, 2);
    }
  });
}
test("null/retained summary never means forfeiture; deferred correct principal remains a claim", async t => {
  const s = await setup(t); s.node.deferRefund = true; await s.service.tick(); s.node.revealPhase();
  await s.service.tick(false);
  let job = (await s.store.jobs())[0];
  assert.equal(job.state, "refund_pending");
  // Aggregate completion cannot prove this specific participant was refunded or forfeited.
  s.node.current = { game_id: job.round.game_id, round_id: job.round.round_id, phase: "Complete" } as Round;
  await s.service.tick(false);
  assert.equal((await s.store.jobs())[0].state, "retention_unresolved");
  s.node.current = null;
  await s.service.tick(false); job = (await s.store.jobs())[0];
  assert.equal(job.state, "retention_unresolved"); assert.notEqual(job.state, "forfeited");
  assert.equal(s.node.submissions, 2);
});
test("capital, job and byte bounds skip commitments without debit; concurrent ticks and signer lock are bounded", async t => {
  const s = await setup(t, { maxJobs: 1, maxCapitalBase: "10000000000000000" });
  const blocker = s.node.withSignedIntentLock(async () => { await s.service.tick(); });
  await blocker; assert.equal(s.node.submissions, 0);
  await s.service.tick(); assert.equal(s.node.submissions, 1);
  const listed = s.node.calls.length;
  await s.service.tick(); assert.equal(s.node.submissions, 1);
  assert.equal(s.node.calls.length, listed, "job bound stops discovery");
});

test("canonical rejected reveal can use a fresh nonce, never a changed salt or replayed intent", async t => {
  const s = await setup(t); await s.service.tick(); s.node.revealPhase(); s.node.rejectReveal = true;
  await s.service.tick(false);
  const first = (await s.store.jobs())[0];
  assert.equal(first.operations[1].resolved, "rejected"); assert.equal(first.state, "committed");
  s.node.rejectReveal = false; await s.service.tick(false);
  const after = (await s.store.jobs())[0];
  assert.equal(after.state, "refunded"); assert.equal(after.salt, first.salt);
  assert.equal(after.operations[2].prepared.nonce, first.operations[1].prepared.nonce + 1);
  const old = [...s.node.preparedOps.values()][1];
  assert.throws(() => s.node.apply(old.prepared, old.op), /nonce replay/);
});

test("canonical wrong and missed outcomes require individual forfeiture evidence", async t => {
  const wrong = await setup(t); await wrong.service.tick(); wrong.node.revealPhase(); wrong.node.mismatch = true;
  await wrong.service.tick(false); assert.equal((await wrong.store.jobs())[0].state, "forfeited");
  const missed = await setup(t); await missed.service.tick();
  missed.node.height = 20; missed.node.time = 500;
  missed.node.current!.phase = "Complete";
  missed.node.current!.candidates![0].principal_forfeited = true;
  await missed.service.tick(false);
  assert.equal((await missed.store.jobs())[0].state, "forfeited"); assert.equal(missed.node.submissions, 1);
});

test("reveal crash recovery persists the original opening without a duplicate broadcast", async t => {
  const s = await setup(t); await s.service.tick(); s.node.revealPhase(); s.node.mode = "queue";
  await s.service.tick(false); const before = (await s.store.jobs())[0]; assert.equal(s.node.submissions, 2);
  await s.restart(); await s.service.tick(false); assert.equal(s.node.submissions, 2);
  s.node.flush(); await s.service.tick(false);
  const after = (await s.store.jobs())[0];
  assert.equal(after.state, "refunded"); assert.equal(after.answer, before.answer); assert.equal(after.salt, before.salt);
});

test("accepted commit still reconciles after round eviction from canonical per-user evidence", async t => {
  const s = await setup(t); s.node.mode = "queue"; await s.service.tick();
  s.node.flush(); s.node.current = null;
  await s.service.tick(false); await s.service.tick(false);
  const job = (await s.store.jobs())[0];
  assert.equal(job.operations[0].resolved, "accepted");
  assert.equal(job.state, "retention_unresolved"); assert.equal(s.node.submissions, 1);
});

test("epoch change after signing fails before broadcasting; current disablement skips new bonds", async t => {
  let node: IsolatedNode | undefined;
  const s = await setup(t, {}, stage => { if (stage === "signed") node!.epoch++; }); node = s.node;
  await assert.rejects(s.service.tick(), /policy differs/); assert.equal(s.node.submissions, 0);
  const disabled = await setup(t); disabled.node.policyEnabled = false;
  assert.equal(await disabled.service.tick(), false); assert.equal(disabled.node.submissions, 0);
});

test("workload/input/frame/candidate/bond admission bounds avoid compute and signing", async t => {
  for (const mutate of [
    (node: IsolatedNode) => { node.current!.throw_count = 501; },
    (node: IsolatedNode) => { node.current!.frame_cap = 10001; },
    (node: IsolatedNode) => { node.current!.policy.max_candidates = "0"; },
    (node: IsolatedNode) => { node.current!.policy.bond_clc = "10000000000000001"; },
  ]) {
    const s = await setup(t); mutate(s.node);
    assert.equal(await s.service.tick(), false); assert.equal(s.node.submissions, 0);
    assert.ok(!s.node.calls.includes("frozen"));
  }
});
test("tampered fixed bond, task, identity, salt and EVM/native policy fail before signing", async t => {
  const s = await setup(t, {}, stage => { if (stage === "computed") throw new Error("capture computed job"); });
  await assert.rejects(s.service.tick());
  const job = (await s.store.jobs())[0];
  const prepared = await s.node.prepareSignedIntent({ signer: job.user, method: "colliderV2.commitGameConfirmation",
    params: [job.round.game_id, job.round.round_id, job.round.input_hash, 1, job.bond, job.commitment] });
  verifyConfirmationOperation(prepared, s.node.context(), pins, job, "commit", config.clcToken);
  const presentation = structuredClone(prepared);
  const typedPresentation = presentation.typed_data as any;
  typedPresentation.message.amount = "100 tokens (18 decimals)";
  presentation.digest = TypedDataEncoder.hash(typedPresentation.domain, { ColliderIntent: NATIVE_INTENT_FIELDS }, typedPresentation.message);
  assert.throws(() => verifyConfirmationOperation(presentation, s.node.context(), pins, job, "commit", config.clcToken), /presentation mismatch/);
  const reveal = await s.node.prepareSignedIntent({ signer: job.user, method: "colliderV2.revealGameConfirmation",
    params: [job.round.game_id, job.round.round_id, job.answer, "0x" + "fe".repeat(32)] });
  assert.throws(() => verifyConfirmationOperation(reveal, s.node.context(), pins, job, "reveal", config.clcToken), /original private answer/);
  for (const field of ["user", "round_id", "input_hash", "bond_clc", "commitment"]) {
    const changed = structuredClone(prepared);
    const op = JSON.parse(changed.details).CommitGameConfirmation;
    op[field] = field === "bond_clc" ? "1" : Array(32).fill(255);
    changed.details = JSON.stringify({ CommitGameConfirmation: op });
    const typed = changed.typed_data as any; typed.message.details = changed.details;
    changed.digest = TypedDataEncoder.hash(typed.domain, { ColliderIntent: NATIVE_INTENT_FIELDS }, typed.message);
    assert.throws(() => verifyConfirmationOperation(changed, s.node.context(), pins, job, "commit", config.clcToken));
  }
  await assert.rejects(new BondedConfirmationService({ ...config, pins: { ...pins, chainId: "0x" + "ff".repeat(32) } },
    s.store, s.node, s.wallet, s.node).init(), /capability/);
  const changedJob = { ...job, salt: "0x" + "ff".repeat(32) };
  await s.store.save(changedJob); await assert.rejects(s.service.tick(), /binding mismatch/);
  assert.equal(s.node.submissions, 0);
});
