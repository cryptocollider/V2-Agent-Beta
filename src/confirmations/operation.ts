import type { PreparedSignedIntent, Rc1AuthContext } from "../collider/types.js";
import { verifyNativePreparedEnvelope } from "../collider/native-signing.js";
import { assertCapabilities, CLC_ASSET, exact, hex, parseExactJson, type Pins } from "./contract.js";
import type { Job } from "./service.js";
const fromBytes = (value: unknown): string => {
  if (!Array.isArray(value) || value.length !== 32 || value.some(n => !Number.isInteger(n) || n < 0 || n > 255)) throw new Error("invalid prepared confirmation ID");
  return "0x" + Buffer.from(value).toString("hex");
};
export function verifyConfirmationOperation(prepared: PreparedSignedIntent, context: Rc1AuthContext,
  pins: Pins, job: Job, kind: "commit" | "reveal", clcToken: string): void {
  assertCapabilities(context, pins); verifyNativePreparedEnvelope(prepared, context, pins.signingChainId);
  if (hex(prepared.signer) !== hex(job.user) || prepared.nonce !== context.user?.next_available_nonce
      || !context.user.canonical_wallet_user || hex(context.user.user_id) !== hex(job.user)
      || !Number.isSafeInteger(prepared.nonce) || prepared.nonce < 0
      || prepared.issued_at_height !== context.last_accepted_height || !Number.isSafeInteger(prepared.valid_until_height)
      || prepared.valid_until_height <= prepared.issued_at_height || prepared.valid_until_height > prepared.issued_at_height + 128
      || prepared.action !== "game.confirm." + kind) throw new Error("prepared confirmation signer/nonce/window/action mismatch");
  const parsed = parseExactJson(prepared.details) as Record<string, Record<string, unknown>>;
  const op = parsed[kind === "commit" ? "CommitGameConfirmation" : "RevealGameConfirmation"];
  const keys = kind === "commit" ? ["user", "game_id", "round_id", "input_hash", "policy_version", "bond_clc", "commitment"]
    : ["user", "game_id", "round_id", "result_hash", "salt"];
  if (!op || Object.keys(parsed).length !== 1 || Object.keys(op).sort().join() !== keys.sort().join()
      || fromBytes(op.user) !== job.user || fromBytes(op.game_id) !== job.round.game_id
      || fromBytes(op.round_id) !== job.round.round_id) throw new Error("prepared confirmation task/identity mismatch");
  if (kind === "commit") {
    if (fromBytes(op.input_hash) !== job.round.input_hash || exact(op.policy_version) !== exact(job.round.policy.version)
        || exact(op.bond_clc) !== job.bond || fromBytes(op.commitment) !== job.commitment) throw new Error("prepared fixed bond/commitment mismatch");
  } else if (fromBytes(op.result_hash) !== job.answer || fromBytes(op.salt) !== job.salt) throw new Error("prepared opening differs from original private answer");
  const message = (prepared.typed_data as { message: Record<string, unknown> }).message;
  const digits = job.bond.padStart(19, "0");
  const fraction = digits.slice(-18).replace(/0+$/, "");
  const displayedBond = digits.slice(0, -18) + (fraction ? "." + fraction : "");
  if (hex(message.target) !== job.round.game_id || message.recipient !== "0x" + "00".repeat(20)
      || message.amount !== (kind === "commit" ? displayedBond + " tokens (18 decimals)" : "No single asset amount; review details")
      || exact(message.amountBaseUnits) !== (kind === "commit" ? job.bond : "0")
      || hex(message.asset) !== (kind === "commit" ? CLC_ASSET : "0x" + "00".repeat(32))
      || String(message.token).toLowerCase() !== (kind === "commit" ? clcToken.toLowerCase() : "0x" + "00".repeat(20))
      || message.description !== (kind === "commit" ? "Commit game confirmation; lock CLC bond" : "Reveal committed game confirmation")) {
    throw new Error("prepared confirmation wallet presentation mismatch");
  }
}
