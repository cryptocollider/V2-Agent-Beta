import { exact, type Policy } from "./contract.js";
/** Read-only audit of frozen fixed-point terms; never issues points or admission weights. */
export function pointPlan(policy: Policy, valueE8: string, globalAllowed: boolean,
  candidates: { user: string; correct: boolean; accepted_height: string }[]): Record<string, string> {
  const result = Object.fromEntries(candidates.map(c => [c.user, "0"]));
  if (!globalAllowed || BigInt(exact(valueE8)) < BigInt(exact(policy.confirm_min_game_value_usd_e8))) return result;
  const correct = candidates.filter(c => c.correct);
  if (!correct.length) return result;
  const fastest = BigInt(exact(policy.confirm_fastest_bonus_points)), shared = BigInt(exact(policy.confirm_correct_shared_points));
  const requested = fastest + shared;
  if (!requested) return result;
  const cap = policy.hard_points_cap == null ? requested : BigInt(exact(policy.hard_points_cap));
  const budget = requested < cap ? requested : cap;
  const earliest = correct.reduce((h, c) => BigInt(exact(c.accepted_height)) < h ? BigInt(c.accepted_height) : h, BigInt(correct[0].accepted_height));
  const ties = correct.filter(c => BigInt(c.accepted_height) === earliest).length;
  for (const c of correct) result[c.user] = ((budget * shared / requested) / BigInt(correct.length)
    + (BigInt(c.accepted_height) === earliest ? (budget * fastest / requested) / BigInt(ties) : 0n)).toString();
  return result;
}
export function workloadBucket(acceptedThrows: number): number {
  if (!Number.isSafeInteger(acceptedThrows) || acceptedThrows < 0) throw new Error("invalid workload count");
  return acceptedThrows < 10 ? 0 : acceptedThrows <= 200 ? 1 : acceptedThrows <= 500 ? 2 : 3;
}
