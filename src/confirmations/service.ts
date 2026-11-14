import { randomBytes } from "node:crypto";
import type { ColliderClient } from "../collider/client.js";
import type { AgentWallet } from "../collider/wallet.js";
import type { PreparedSignedIntent, Rc1AuthContext, SubmittedSignedIntent } from "../collider/types.js";
import { assertCapabilities, canCommit, canReveal, CANDIDATE_WASM_SHA256, commitment, exact, hex, verifyFrozen,
  type Exact, type Frozen, type Pins, type Policy, type Round } from "./contract.js";
import { ConfirmationStore } from "./store.js";
import { runFrozenWasm, type ConfirmationResult } from "./wasm.js";
import { verifyConfirmationOperation } from "./operation.js";

export type Snapshot = { context: Rc1AuthContext; height: Exact; time: Exact };
export interface ConfirmationTransport {
  snapshot(user: string): Promise<Snapshot>;
  policy(): Promise<{ policy: Policy; artifact_hash: string; result_digest_version: number }>;
  list(): Promise<{ rounds: { game_id: string; phase: string }[] }>;
  round(game: string): Promise<Round | null>;
  frozen(game: string): Promise<Frozen | null>;
  stats(user: string): Promise<unknown>;
  ladder(user: string): Promise<{ level: number; points_total: string; throw_count: string } | null>;
  balance(user: string): Promise<string>;
  events(height: number): Promise<unknown[]>;
}
export type Operation = { kind: "commit" | "reveal"; prepared: PreparedSignedIntent; signature?: string;
  attempted: boolean; submission?: SubmittedSignedIntent; scanned: number; authenticated?: boolean;
  resolved?: "accepted" | "rejected" | "expired" | "cancelled"; outcomeUnknown?: boolean; businessAccepted?: boolean };
export type Job = { schema: "agent1.bonded-confirmation.v1"; user: string; pins: Pins; round: Round;
  frozen: Frozen; answer: string; resultBase64: string; salt: string; commitment: string; bond: string;
  state: string; operations: Operation[]; noticesFrom: number; auditComplete?: boolean;
  notices?: { stage: string; height: string; ordinal: number; amountClcBase: string; points: string }[] };
export type ConfirmationConfig = {
  enabled: boolean; pins: Pins; wasmPath: string; clcToken: string; maxJobs: number;
  maxBondBase: string; maxCapitalBase: string; maxInputBytes: number; maxFrozenBytes: number;
  maxFrameCap: number; maxThrowCount: number; maxNewRounds: number; computeTimeoutMs: number; maxScanBlocks: number; maxRevealAttempts: number;
};
export const CONFIRMATION_DEFAULT_BOUNDS = {
  enabled: false, maxJobs: 8, maxBondBase: "10000000000000000", maxCapitalBase: "80000000000000000",
  maxInputBytes: 1_048_576, maxFrozenBytes: 16 * 1024 * 1024, maxFrameCap: 10000, maxThrowCount: 500, maxNewRounds: 4,
  computeTimeoutMs: 10000, maxScanBlocks: 128, maxRevealAttempts: 2,
};
const terminal = (job: Job) => ["refunded", "forfeited", "expired", "rejected", "cancelled"].includes(job.state);
const pending = (job: Job) => job.operations.find(op => !op.resolved);
function notices(events: unknown[], job: Job): Record<string, unknown>[] {
  return events.flatMap((value, ordinal) => {
    const e = value as Record<string, any>;
    const n = e?.type === "Confirmation" ? e : e?.Confirmation?.notice ?? e?.Confirmation;
    return n && n.user === job.user && n.game_id === job.round.game_id && n.round_id === job.round.round_id ? [{ ...n, canonicalOrdinal: ordinal }] : [];
  });
}
export class BondedConfirmationService {
  private busy = false;
  private busyBlocksThrows = true;
  private initialized = false;
  private saving = false;
  private unregister?: () => void;
  constructor(readonly config: ConfirmationConfig, private readonly store: ConfirmationStore,
    private readonly client: ColliderClient, private readonly wallet: AgentWallet,
    private readonly rpc: ConfirmationTransport,
    private readonly compute: (path: string, input: Uint8Array, timeout: number) => Promise<ConfirmationResult> = runFrozenWasm,
    private readonly fault?: (stage: string) => void,
    private readonly hooks?: { persistEnabled?: (enabled: boolean) => Promise<void>; publish?: (jobs: unknown[]) => Promise<void> }) {}

  async init(): Promise<void> {
    const c = this.config;
    if (typeof c.enabled !== "boolean" || !Number.isInteger(c.maxJobs) || c.maxJobs < 1 || c.maxJobs > 8
        || ![c.maxInputBytes, c.maxFrozenBytes, c.maxFrameCap, c.computeTimeoutMs, c.maxScanBlocks].every(Number.isSafeInteger)
        || BigInt(exact(c.maxBondBase)) <= 0n || BigInt(exact(c.maxCapitalBase)) < BigInt(c.maxBondBase)
        || c.maxInputBytes < 1 || c.maxInputBytes > 1_048_576 || c.maxFrozenBytes > 16 * 1024 * 1024
        || c.maxFrozenBytes < c.maxInputBytes || !Number.isInteger(c.maxFrameCap) || c.maxFrameCap < 1 || c.maxFrameCap > 10000
        || !Number.isSafeInteger(c.maxThrowCount) || c.maxThrowCount < 1 || c.maxThrowCount > 1024
        || !Number.isSafeInteger(c.maxNewRounds) || c.maxNewRounds < 1 || c.maxNewRounds > 4
        || c.computeTimeoutMs < 1 || c.computeTimeoutMs > 10000 || c.maxScanBlocks < 1 || c.maxScanBlocks > 128
        || !Number.isInteger(c.maxRevealAttempts) || c.maxRevealAttempts < 1 || c.maxRevealAttempts > 3
        || !/^0x[0-9a-f]{40}$/i.test(c.clcToken)) throw new Error("invalid explicit confirmation bounds");
    const { context } = await this.rpc.snapshot(this.wallet.userId);
    assertCapabilities(context, c.pins); // Before private state or any financial operation.
    await this.currentPolicy();
    await this.store.init();
    try {
      const jobs = await this.store.jobs();
      for (const job of jobs) this.validateJob(job);
      this.busyBlocksThrows = jobs.some(job => !terminal(job) || !job.auditComplete);
      this.unregister = this.client.registerPendingIntentCheck("confirmations", async () =>
        (await this.store.jobs()).some(job => !!pending(job)));
      this.initialized = true;
    } catch (error) { await this.store.close(); throw error; }
  }
  async close(): Promise<void> { this.unregister?.(); this.initialized = false; await this.store.close(); }
  async saveEnabled(enabled: unknown): Promise<{ enabled: boolean }> {
    if (typeof enabled !== "boolean") throw new Error("confirmation enabled must be boolean");
    if (!this.initialized || !this.hooks?.persistEnabled || this.saving) throw new Error("reviewed confirmation config is unavailable or busy");
    this.saving = true;
    try {
      await this.hooks.persistEnabled(enabled);
      this.config.enabled = enabled;
      return { enabled };
    } finally { this.saving = false; }
  }
  private validateJob(job: Job): void {
    if (job.user !== hex(this.wallet.userId) || JSON.stringify(job.pins) !== JSON.stringify(this.config.pins)
        || job.bond !== exact(job.round.policy.bond_clc) || hex(job.answer) !== job.answer
        || commitment(job.round, job.pins.networkDomain, job.user, job.answer, job.salt) !== job.commitment) {
      throw new Error("private confirmation job binding mismatch");
    }
    verifyFrozen(job.round, job.frozen, job.pins, this.config.maxInputBytes);
  }
  /** Public status never includes salts, signatures, prepared reveal details or frozen private job bytes. */
  private publicJob(job: Job) {
    return { gameId: job.round.game_id, roundId: job.round.round_id, state: job.state, bondBase: job.bond,
      inputHash: job.round.input_hash, artifactHash: job.round.artifact_hash, policyHash: job.round.policy_hash,
      pendingNonce: pending(job)?.prepared.nonce ?? null,
      operations: job.operations.map(op => ({ action: op.prepared.action, nonce: op.prepared.nonce,
        payloadHash: op.prepared.payload_hash, issuedHeight: op.prepared.issued_at_height,
        expiryHeight: op.prepared.valid_until_height, attempted: op.attempted, outcome: op.resolved ?? "unresolved" })),
      notices: job.notices ?? [], auditComplete: !!job.auditComplete };
  }
  async status() {
    const [current, ladder, balance, jobs] = await Promise.all([this.currentPolicy(), this.rpc.ladder(this.wallet.userId),
      this.rpc.balance(this.wallet.userId), this.store.jobs()]);
    const level = ladder?.level ?? 0;
    if (!Number.isSafeInteger(level) || level < 0 || level > 255) throw new Error("invalid canonical confirmation level");
    const used = jobs.length, capital = jobs.filter(j => !terminal(j)).reduce((n, j) => n + BigInt(j.bond), 0n);
    const reason = !this.config.enabled ? "disabled" : !current.enabled ? "policy_disabled" : level < 1 ? "level_required"
      : used >= this.config.maxNewRounds ? "round_limit" : BigInt(exact(balance)) < BigInt(exact(current.bond_clc)) ? "clc_required"
      : BigInt(exact(current.bond_clc)) > BigInt(this.config.maxBondBase) ? "bond_limit"
      : jobs.some(j => !terminal(j) && j.state.endsWith("unresolved")) ? "reconciliation_required"
      : jobs.filter(j => !terminal(j)).length >= this.config.maxJobs ? "job_limit"
      : capital + BigInt(exact(current.bond_clc)) > BigInt(this.config.maxCapitalBase) ? "capital_limit" : "ready";
    const raw = await this.rpc.stats(this.wallet.userId) as Record<string, unknown>;
    const stats: Record<string, unknown> = Object.fromEntries(["committed", "correct", "mismatched", "missed", "voided", "points",
      "fastest_paid_wins", "earliest_correct_commit_rounds", "commit_height_latency_sum",
      "commit_time_latency_sum", "correct_gross_value_e8", "pending_bonds"]
      .filter(key => raw[key] != null).map(key => [key, exact(raw[key])]));
    if (Array.isArray(raw.correct_by_workload) && raw.correct_by_workload.length === 4) {
      stats.correct_by_workload = raw.correct_by_workload.map(exact);
    }
    return { available: true, enabled: this.config.enabled, user: hex(this.wallet.userId), reason,
      eligibility: { level, requiredLevel: 1, points: String(ladder?.points_total ?? "0"), clcBalanceBase: exact(balance),
        levelMet: level >= 1, bondBalanceMet: BigInt(exact(balance)) >= BigInt(exact(current.bond_clc)) },
      limits: { maxJobs: this.config.maxJobs, maxNewRounds: this.config.maxNewRounds, roundsUsed: used,
        maxBondBase: this.config.maxBondBase, maxCapitalBase: this.config.maxCapitalBase, pendingCapitalBase: capital.toString(),
        maxInputBytes: this.config.maxInputBytes, maxFrozenBytes: this.config.maxFrozenBytes,
        maxThrowCount: this.config.maxThrowCount, maxFrameCap: this.config.maxFrameCap, computeTimeoutMs: this.config.computeTimeoutMs },
      policy: { enabled: current.enabled, version: exact(current.version), bondBase: exact(current.bond_clc),
        minGameValueUsdE8: exact(current.confirm_min_game_value_usd_e8), fastestPoints: exact(current.confirm_fastest_bonus_points),
        sharedPoints: exact(current.confirm_correct_shared_points), hardPointsCap: current.hard_points_cap },
      jobs: jobs.map(job => this.publicJob(job)), stats, measurementsOnly: true };
  }
  private async currentPolicy(): Promise<Policy> {
    const current = await this.rpc.policy();
    if (current.result_digest_version !== 2 || hex(current.artifact_hash) !== "0x" + CANDIDATE_WASM_SHA256
        || typeof current.policy?.enabled !== "boolean") throw new Error("unreviewed current confirmation policy/artifact");
    return current.policy;
  }
  private async snapshot(): Promise<Snapshot> {
    const result = await this.rpc.snapshot(this.wallet.userId);
    assertCapabilities(result.context, this.config.pins);
    if (exact(result.height) !== exact(result.context.last_accepted_height)) throw new Error("confirmation clock/context height differs");
    exact(result.time);
    if (!Number.isSafeInteger(Number(exact(result.height)))) throw new Error("confirmation height exceeds client scan range");
    return result;
  }
  private async reconcile(job: Job, snapshot: Snapshot): Promise<void> {
    this.validateJob(job);
    const live = await this.rpc.round(job.round.game_id);
    if (live && (hex(live.round_id) !== job.round.round_id || hex(live.game_id) !== job.round.game_id)) {
      throw new Error("round replaced; preserve old principal claim");
    }
    if (live?.policy) verifyFrozen(live, job.frozen, job.pins, this.config.maxInputBytes);
    const candidate = live?.candidates?.find(c => hex(c.user) === job.user);
    if (candidate && (hex(candidate.commitment) !== job.commitment || exact(candidate.bond_clc_base) !== job.bond)) throw new Error("accepted commitment conflicts with private job");
    if (candidate?.answer && hex(candidate.answer) !== job.answer) throw new Error("accepted opening differs from private job");
    const op = pending(job);
    const end = Math.min(Number(exact(snapshot.height)), job.noticesFrom + this.config.maxScanBlocks);
    for (let height = job.noticesFrom + 1; height <= end; height++) {
      const events = await this.rpc.events(height);
      if (op && events.some(value => {
        const auth = (value as any)?.SignedIntentAuthenticated;
        return auth && auth.signer === job.user && Number(auth.nonce) === op.prepared.nonce
          && auth.action === op.prepared.action && auth.payload_hash === op.prepared.payload_hash;
      })) op.authenticated = true;
      for (const n of notices(events, job)) {
        const receipt = { stage: String(n.stage), height: exact(n.height ?? height), ordinal: Number(n.canonicalOrdinal),
          amountClcBase: exact(n.amount_clc_base ?? "0"), points: exact(n.points ?? "0") };
        job.notices ??= [];
        if (!job.notices.some(old => JSON.stringify(old) === JSON.stringify(receipt))) {
          if (job.notices.length >= 64) throw new Error("confirmation public notice bound reached");
          job.notices.push(receipt);
        }
        if (n.stage === "Committed" && op?.kind === "commit" && op.authenticated
            && exact(n.amount_clc_base) === job.bond) {
          op.businessAccepted = true;
          if (!terminal(job)) job.state = "committed";
        }
        if (n.stage === "Refunded") job.state = "refunded";
        else if (n.stage === "Forfeited") job.state = "forfeited";
        else if (n.answer === job.answer && !terminal(job)) {
          if (n.stage === "Correct") job.state = "refund_pending";
          if (n.stage === "Mismatch") job.state = "resolution_pending";
        }
      }
      job.noticesFrom = height;
    }
    if (candidate?.principal_returned) job.state = "refunded";
    else if (candidate?.principal_forfeited) job.state = "forfeited";
    else if (candidate?.answer && !terminal(job)) job.state = candidate.correct ? "refund_pending" : "resolution_pending";
    else if (candidate && !terminal(job)) job.state = "committed";
    if (op) {
      const accepted = op.kind === "commit" ? !!candidate || op.businessAccepted || terminal(job)
        || ["refund_pending", "resolution_pending"].includes(job.state) : !!candidate?.answer || terminal(job)
        || ["refund_pending", "resolution_pending"].includes(job.state);
      if (accepted) { op.resolved = "accepted"; }
      else if (op.authenticated && job.noticesFrom >= Number(exact(snapshot.height))) {
        op.resolved = "rejected";
        if (op.kind === "commit") job.state = "rejected"; else job.state = "committed";
      } else if (job.noticesFrom >= Number(exact(snapshot.height))
          && Number(snapshot.context.user?.accepted_next_nonce) > op.prepared.nonce) {
        job.state = "ambiguous"; // A consumed nonce without the matching canonical payload is never replayed.
      } else if (job.noticesFrom >= Number(exact(snapshot.height))
          && BigInt(exact(snapshot.height)) > BigInt(op.prepared.valid_until_height)) {
        op.resolved = "expired";
        job.state = op.kind === "commit" && !candidate ? "expired" : "reveal_unresolved";
      }
    } else if ((!live || ["Complete", "Voided"].includes(live.phase)) && !terminal(job)) job.state = "retention_unresolved";
    // Principal can return before cleanup issues points/fastest CLC; keep auditing beyond the refund.
    job.auditComplete = ["cancelled", "expired", "rejected"].includes(job.state)
      || ((!live || ["Complete", "Voided"].includes(live.phase)) && job.noticesFrom >= Number(exact(snapshot.height)));
    await this.store.save(job);
    if (this.hooks?.publish) await this.hooks.publish((await this.store.jobs()).map(j => this.publicJob(j)));
  }
  private async send(job: Job, kind: "commit" | "reveal"): Promise<void> {
    if (this.client.isSignedIntentBusy()) return; // Same owner signer; defer rather than compete with an in-flight throw/redemption.
    await this.client.withSignedIntentLock(async () => {
      if (await this.client.hasExternalPendingIntent("confirmations")) return;
      const throwPending = await this.client.reconcilePendingSignedIntent(0);
      if (throwPending) return; // Let the session record/reconcile it first.
      const snapshot = await this.snapshot();
      await this.reconcile(job, snapshot);
      if (terminal(job) || job.state === "ambiguous" || job.state === "reveal_unresolved") return;
      const live = await this.rpc.round(job.round.game_id);
      if (!live || live.round_id !== job.round.round_id) return;
      if (!(kind === "commit" ? canCommit(live, snapshot.height, snapshot.time) : canReveal(live, snapshot.height, snapshot.time))) return;
      if (kind === "commit") {
        const ladder = await this.rpc.ladder(this.wallet.userId);
        if (!ladder || !Number.isSafeInteger(ladder.level) || ladder.level < 1) return;
      }
      let op = pending(job);
      if (op && (op.kind !== kind || op.attempted)) return; // Uncertain submissions only reconcile.
      if (snapshot.context.user?.accepted_next_nonce !== snapshot.context.user?.next_available_nonce) return;
      if (!op) {
        if (kind === "reveal" && job.operations.filter(o => o.kind === "reveal").length >= this.config.maxRevealAttempts) return;
        const params = kind === "commit" ? [job.round.game_id, job.round.round_id, job.round.input_hash,
          Number(exact(job.round.policy.version)), job.bond, job.commitment]
          : [job.round.game_id, job.round.round_id, job.answer, job.salt];
        if (!Number.isSafeInteger(params[3]) && kind === "commit") throw new Error("unsupported unsafe policy-version RPC integer");
        const prepared = await this.client.prepareSignedIntent({ signer: job.user,
          method: kind === "commit" ? "colliderV2.commitGameConfirmation" : "colliderV2.revealGameConfirmation", params, ttl_blocks: 128 });
        verifyConfirmationOperation(prepared, snapshot.context, this.config.pins, job, kind, this.config.clcToken);
        op = { kind, prepared, attempted: false, scanned: prepared.issued_at_height };
        job.operations.push(op); await this.store.save(job); this.fault?.("prepared");
      } else {
        verifyConfirmationOperation(op.prepared, { ...snapshot.context, last_accepted_height: op.prepared.issued_at_height },
          this.config.pins, job, kind, this.config.clcToken);
      }
      if (!op.signature) {
        op.signature = await this.wallet.signPreparedIntent(op.prepared);
        await this.store.save(job); this.fault?.("signed");
      }
      const beforeSend = await this.snapshot();
      verifyConfirmationOperation(op.prepared, { ...beforeSend.context, last_accepted_height: op.prepared.issued_at_height },
        this.config.pins, job, kind, this.config.clcToken);
      const latest = await this.rpc.round(job.round.game_id);
      if (latest?.policy) verifyFrozen(latest, job.frozen, job.pins, this.config.maxInputBytes);
      if (kind === "commit" && !this.config.enabled) return;
      if (!latest || beforeSend.context.user?.accepted_next_nonce !== op.prepared.nonce
          || beforeSend.context.user?.next_available_nonce !== op.prepared.nonce
          || BigInt(exact(beforeSend.height)) > BigInt(op.prepared.valid_until_height)
          || !(kind === "commit" ? canCommit(latest, beforeSend.height, beforeSend.time) : canReveal(latest, beforeSend.height, beforeSend.time))) return;
      op.attempted = true; await this.store.save(job); this.fault?.("before_submit");
      try {
        const p = op.prepared;
        op.submission = await this.client.submitSignedIntent({ signer: p.signer, nonce: p.nonce,
          issued_at_height: p.issued_at_height, valid_until_height: p.valid_until_height,
          op_b64: p.op_b64, signature: op.signature }, true);
        op.outcomeUnknown = !op.submission.accepted;
      } catch { op.outcomeUnknown = true; }
      this.fault?.("after_submit"); await this.store.save(job);
      await this.reconcile(job, await this.snapshot());
    });
  }
  /** One bounded serial tick; existing bonds are serviced before optional new work. */
  async tick(allowNewCommitments = true): Promise<boolean> {
    if (!this.initialized) throw new Error("confirmation service not initialized");
    // A concurrent eligibility read with no obligations must not starve the throw loop
    // when the one-second pump and session wakeups align. Bond/compute work still wins.
    if (this.busy) return this.busyBlocksThrows;
    this.busy = true;
    try {
      let jobs = await this.store.jobs();
      this.busyBlocksThrows = jobs.some(job => !terminal(job) || !job.auditComplete);
      if (!jobs.length && !this.config.enabled) return false;
      const snapshot = await this.snapshot();
      for (const job of jobs.filter(j => !terminal(j) || !j.auditComplete)) await this.reconcile(job, snapshot);
      jobs = await this.store.jobs();
      const unfinished = jobs.find(j => pending(j));
      if (unfinished) {
        const op = pending(unfinished)!;
        if (op.kind === "commit" && !op.attempted && (!this.config.enabled || !allowNewCommitments)) {
          op.resolved = "cancelled"; unfinished.state = "cancelled"; await this.store.save(unfinished);
          return true; // A locally signed but never attempted commit must not start a new bond after disablement.
        }
        if (!op.attempted) await this.send(unfinished, op.kind);
        return true;
      }
      const bonded = jobs.filter(j => ["committed", "refund_pending", "retention_unresolved", "resolution_pending", "reveal_unresolved"].includes(j.state));
      for (const job of bonded) {
        const live = await this.rpc.round(job.round.game_id);
        if (job.state === "committed" && live && canReveal(live, snapshot.height, snapshot.time)) {
          await this.send(job, "reveal"); return true;
        }
      }
      if (!this.config.enabled || !allowNewCommitments || bonded.some(j => j.state.endsWith("unresolved"))) return false;
      if (!(await this.currentPolicy()).enabled) return false;
      const ladder = await this.rpc.ladder(this.wallet.userId);
      if (!ladder || !Number.isSafeInteger(ladder.level) || ladder.level < 1) return false;
      const active = jobs.filter(j => !terminal(j));
      const reusable = active.find(j => j.state === "computed");
      if (reusable) { await this.send(reusable, "commit"); return true; }
      if (active.length >= this.config.maxJobs || jobs.length >= this.store.maxStoredJobs || jobs.length >= this.config.maxNewRounds) return false;
      const capital = active.reduce((n, j) => n + BigInt(j.bond), 0n);
      const bytes = active.reduce((n, j) => n + Buffer.byteLength(j.frozen.input_base64, "base64"), 0);
      const tasks = await this.rpc.list();
      for (const task of tasks.rounds.slice(0, 128)) {
        if (task.phase !== "Commit" || jobs.some(j => j.round.game_id === task.game_id)) continue;
        const round = await this.rpc.round(task.game_id);
        if (!round || !canCommit(round, snapshot.height, snapshot.time) || !round.policy.enabled
            || !Number.isSafeInteger(round.frame_cap) || round.frame_cap < 1 || round.frame_cap > this.config.maxFrameCap
            || !Number.isSafeInteger(round.throw_count) || round.throw_count < 0 || round.throw_count > this.config.maxThrowCount
            || (round.candidates?.length ?? 0) >= Number(exact(round.policy.max_candidates))) continue;
        const bond = BigInt(exact(round.policy.bond_clc));
        if (bond <= 0n || bond > BigInt(this.config.maxBondBase) || capital + bond > BigInt(this.config.maxCapitalBase)
            || BigInt(exact(await this.rpc.balance(this.wallet.userId))) < bond) continue;
        const frozen = await this.rpc.frozen(task.game_id);
        if (!frozen) continue;
        const { input, policy } = verifyFrozen(round, frozen, this.config.pins, this.config.maxInputBytes);
        if (bytes + input.length > this.config.maxFrozenBytes) continue;
        this.busyBlocksThrows = true;
        const computed = await this.compute(this.config.wasmPath, input, this.config.computeTimeoutMs);
        const answer = hex("0x" + computed.result.final_hash.replace(/^0x/, ""));
        const salt = "0x" + randomBytes(32).toString("hex");
        const job: Job = { schema: "agent1.bonded-confirmation.v1", user: hex(this.wallet.userId),
          pins: this.config.pins, round: { ...round, policy, candidates: undefined }, frozen, answer,
          resultBase64: computed.bytes.toString("base64"), salt, bond: bond.toString(),
          commitment: commitment(round, this.config.pins.networkDomain, this.wallet.userId, answer, salt),
          state: "computed", operations: [], noticesFrom: Number(exact(round.closed_height)) };
        await this.store.save(job); this.fault?.("computed");
        // Computation may have consumed time; never commit ahead of a now-due bonded reveal.
        const now = await this.snapshot();
        for (const old of bonded) {
          const live = await this.rpc.round(old.round.game_id);
          if (live && canReveal(live, now.height, now.time)) return true;
        }
        await this.send(job, "commit"); return true;
      }
      return false;
    } finally { this.busy = false; }
  }
}
