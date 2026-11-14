import { createHash } from "node:crypto";
import { keccak256 } from "ethers";
import type { Rc1AuthContext } from "../collider/types.js";
import { assertNativeSigningContext } from "../collider/native-signing.js";
export const CANDIDATE_WASM_SHA256 = "92241dc64762f1db4bc82c364a46e4ead6d484348430fbe823f05809c62898ce";
export const CLC_ASSET = "0x3e0e0f0eedd306b23b0f386df33a36fac07cbd9e45a7ad02d1c40adedbee2e16";
export const RETIRED_FUJI_DOMAIN = "0x7373a33eb682031eaab71b2f17204cc58e14726b1a15f281718e3c4ac9265db7";
export type Exact = string | number;
export type Pins = { networkId: number; l1Id: string; chainId: string; networkDomain: string; signingChainId: number };
export type Deadline = { height: Exact; time: Exact };
export type Policy = {
  enabled: boolean; version: string; tiers: { minimum_value_e8: string; commit_blocks: string; commit_secs: string }[];
  reveal_blocks: string; reveal_secs: string; void_blocks: string; void_secs: string; bond_clc: string;
  confirm_fastest_bonus_points: string; confirm_correct_shared_points: string; hard_points_cap: string | null;
  confirm_min_game_value_usd_e8: string; max_rounds: string; max_candidates: string; max_pending_per_user: string;
  max_pending_bonds: string; work_per_block: string; ops_per_block: string; summary_cap: string;
};
export type Candidate = { user: string; commitment: string; accepted_height: Exact; accepted_time: Exact;
  bond_clc_base: string; answer: string | null; correct: boolean; principal_returned: boolean; principal_forfeited: boolean };
export type Round = {
  game_id: string; round_id: string; phase: string; policy: Policy; input_hash: string; policy_hash: string;
  artifact_hash: string; digest_version: number; closed_height: Exact; closed_time: Exact;
  commit_deadline: Deadline; void_deadline: Deadline; reveal_deadline: Deadline | null;
  finalized_height: Exact | null; value_e8: string; throw_count: number; frame_cap: number;
  global_points_allowed: boolean; candidates?: Candidate[];
};
export type Frozen = { game_id: string; round_id: string; codec: string; input_hash: string;
  policy_hash: string; artifact_hash: string; digest_version: number; input_base64: string; policy_base64: string };
export function exact(value: unknown): string {
  if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0)) throw new Error("unsafe confirmation integer");
  const s = String(value);
  if (!/^(0|[1-9]\d*)$/.test(s)) throw new Error("invalid confirmation integer");
  return s;
}
export function hex(value: unknown): string {
  const s = String(value).toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(s)) throw new Error("invalid confirmation hash");
  return s;
}
export function be(value: unknown, width = 8): Buffer {
  let n = BigInt(exact(value)); const out = Buffer.alloc(width);
  for (let i = width - 1; i >= 0; i--) { out[i] = Number(n & 255n); n >>= 8n; }
  if (n) throw new Error("confirmation integer overflow");
  return out;
}
const h = (s: string) => Buffer.from(hex(s).slice(2), "hex");
export const sha = (tag: string, ...parts: Uint8Array[]): string =>
  "0x" + createHash("sha256").update(Buffer.concat([Buffer.from(tag), ...parts])).digest("hex");
export function nativeDomain(pins: Pick<Pins, "networkId" | "l1Id" | "chainId">): string {
  return keccak256(Buffer.concat([Buffer.from("ColliderV2/AuthDomain/V1"), be(pins.networkId, 4), h(pins.l1Id), h(pins.chainId)]));
}
export function assertCapabilities(context: Rc1AuthContext, pins: Pins): void {
  assertNativeSigningContext(context, pins.signingChainId);
  if (context.bonded_confirmations !== 1 || context.result_digest_version !== 2 || !context.domain_configured
      || context.network_id !== pins.networkId || hex(context.l1_id) !== hex(pins.l1Id)
      || hex(context.chain_id) !== hex(pins.chainId) || hex(context.network_domain) !== hex(pins.networkDomain)
      || nativeDomain(pins) !== hex(pins.networkDomain) || hex(pins.networkDomain) === RETIRED_FUJI_DOMAIN) {
    throw new Error("bonded confirmation capability or reviewed fresh-route pins unavailable");
  }
}
export function decodeBase64(value: string, maxBytes: number): Buffer {
  if (typeof value !== "string" || value.length > Math.ceil(maxBytes / 3) * 4
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error("invalid/bounded frozen bytes");
  const out = Buffer.from(value, "base64");
  if (out.length > maxBytes || out.toString("base64") !== value) throw new Error("noncanonical frozen bytes");
  return out;
}
class Reader {
  offset = 0;
  constructor(readonly bytes: Buffer) {}
  take(n: number) { if (n < 0 || this.offset + n > this.bytes.length) throw new Error("truncated frozen policy");
    const out = this.bytes.subarray(this.offset, this.offset + n); this.offset += n; return out; }
  integer(n: number) { const b = this.take(n); let v = 0n; for (let i = n - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[i]); return v.toString(); }
  tag() { const v = this.take(1)[0]; if (v > 1) throw new Error("invalid frozen policy tag"); return v; }
  string() { const n = Number(this.integer(8)); if (!Number.isSafeInteger(n) || n > 128) throw new Error("oversized policy scalar");
    return exact(this.take(n).toString("utf8")); }
}
export function decodePolicy(raw: Buffer): Policy {
  const r = new Reader(raw);
  const enabled = !!r.tag(), version = r.integer(8), count = Number(r.integer(8));
  if (count < 1 || count > 4) throw new Error("invalid confirmation tier count");
  const tiers = Array.from({ length: count }, () => ({ minimum_value_e8: r.string(), commit_blocks: r.integer(8), commit_secs: r.integer(8) }));
  const result: Policy = { enabled, version, tiers, reveal_blocks: r.integer(8), reveal_secs: r.integer(8),
    void_blocks: r.integer(8), void_secs: r.integer(8), bond_clc: r.string(),
    confirm_fastest_bonus_points: r.integer(8), confirm_correct_shared_points: r.integer(8),
    hard_points_cap: r.tag() ? r.integer(8) : null, confirm_min_game_value_usd_e8: r.string(),
    max_rounds: r.integer(2), max_candidates: r.integer(2), max_pending_per_user: r.integer(2),
    max_pending_bonds: r.integer(4), work_per_block: r.integer(2), ops_per_block: r.integer(2), summary_cap: r.integer(2) };
  if (r.offset !== raw.length) throw new Error("trailing frozen policy bytes");
  return result;
}
function normalized(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalized);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, normalized(v)]));
  return typeof value === "number" ? exact(value) : value;
}
export function roundId(round: Round, networkDomain: string): string {
  return sha("Collider/ConfirmationRound/V1", h(networkDomain), h(round.game_id), h(round.input_hash), h(round.artifact_hash),
    be(round.digest_version, 2), h(round.policy_hash), be(round.closed_height), be(round.closed_time), be(round.policy.version));
}
export function commitment(round: Round, networkDomain: string, user: string, answer: string, salt: string): string {
  return sha("Collider/ConfirmationCommit/V1", h(networkDomain), h(round.game_id), h(round.round_id), h(round.input_hash),
    h(round.artifact_hash), be(round.digest_version, 2), be(round.policy.version), h(user), h(answer), h(salt));
}
export function verifyFrozen(round: Round, frozen: Frozen, pins: Pins, maxInputBytes: number): { input: Buffer; policy: Policy } {
  if (frozen.codec !== "bincode-1.3-fixint-le" || round.digest_version !== 2 || frozen.digest_version !== 2
      || hex(round.artifact_hash) !== "0x" + CANDIDATE_WASM_SHA256) throw new Error("unsupported frozen codec/artifact");
  for (const key of ["game_id", "round_id", "input_hash", "policy_hash", "artifact_hash"] as const) {
    if (hex(round[key]) !== hex(frozen[key])) throw new Error("frozen task identity mismatch");
  }
  const input = decodeBase64(frozen.input_base64, maxInputBytes);
  const policyBytes = decodeBase64(frozen.policy_base64, 4096);
  if (sha("Collider/SimRunInput/V1", input) !== hex(round.input_hash)
      || sha("Collider/ConfirmationPolicy/V1", policyBytes) !== hex(round.policy_hash)
      || roundId(round, pins.networkDomain) !== hex(round.round_id)) throw new Error("frozen envelope hash mismatch");
  const policy = decodePolicy(policyBytes);
  if (JSON.stringify(normalized(policy)) !== JSON.stringify(normalized(round.policy))) throw new Error("round policy differs from frozen binary");
  return { input, policy };
}
export const mature = (deadline: Deadline, height: Exact, time: Exact): boolean =>
  BigInt(exact(height)) >= BigInt(exact(deadline.height)) && BigInt(exact(time)) >= BigInt(exact(deadline.time));
export function canCommit(round: Round, height: Exact, time: Exact): boolean {
  return round.phase === "Commit" && BigInt(exact(height)) > BigInt(exact(round.closed_height))
    && !mature(round.commit_deadline, height, time) && !mature(round.void_deadline, height, time);
}
export function canReveal(round: Round, height: Exact, time: Exact): boolean {
  return round.phase === "Reveal" && round.finalized_height != null && round.reveal_deadline != null
    && BigInt(exact(height)) > BigInt(exact(round.finalized_height)) && !mature(round.reveal_deadline, height, time);
}
/** Preserve u64/u128 JSON integers before JSON.parse can round them. */
export function parseExactJson(text: string): unknown {
  return JSON.parse(text.replace(/"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g, token => {
    if (token.startsWith('"')) return token;
    if (!/^-?\d+$/.test(token)) throw new Error("noninteger confirmation JSON number");
    const n = BigInt(token); return n > BigInt(Number.MAX_SAFE_INTEGER) || n < BigInt(Number.MIN_SAFE_INTEGER) ? JSON.stringify(token) : token;
  }));
}
