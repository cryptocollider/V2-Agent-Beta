import type { Hex32, SimRunInput, ThrowRecord } from "../collider/types.js";
import type { CandidatePlanRun, CandidateScenarioRun } from "../sim/planner.js";

export type PredictionSummary = {
  scenarioCount: number;
  winnerScenarioCount: number;
  pnlUsd: number | null;
  bestPnlUsd: number | null;
  worstPnlUsd: number | null;
  holeType: number | null;
  holeTypeCounts: Record<string, number>;
  valueUsd: number | null;
  valueUsdE8: string | null;
  massUsd: number | null;
  winnerValuePct: number | null;
};

type HoleRule = {
  return_pct: number;
  prize_pct: number;
  losers_pct: number;
  fee_pct: number;
  creator_fee_pct: number;
  name: string;
};

type ScenarioComputed = {
  weight: number;
  pnlUsd: number | null;
  holeType: number | null;
  valueUsd: number | null;
  valueUsdE8: string | null;
  massUsd: number | null;
  winnerValuePct: number | null;
};

const DEFAULT_HOLE_RULES: Record<number, HoleRule> = {
  1: { return_pct: 1.0, prize_pct: 0.0, losers_pct: 0.0, fee_pct: 0.0, creator_fee_pct: 0.0, name: "DRAW" },
  2: { return_pct: 0.0, prize_pct: 0.0, losers_pct: 0.99, fee_pct: 0.01, creator_fee_pct: 0.0, name: "-100%" },
  3: { return_pct: 1.0, prize_pct: 0.0, losers_pct: 0.0, fee_pct: 0.0, creator_fee_pct: 0.0, name: "WIN" },
  4: { return_pct: 0.5, prize_pct: 0.0, losers_pct: 0.495, fee_pct: 0.005, creator_fee_pct: 0.0, name: "-50%" },
  5: { return_pct: 0.99, prize_pct: 0.0, losers_pct: 0.0, fee_pct: 0.005, creator_fee_pct: 0.005, name: "-1%" },
};

function cleanHex(v: unknown): string {
  return String(v ?? "").toLowerCase().replace(/^0x/, "");
}

function bytesToHex(arr: unknown): string {
  if (!Array.isArray(arr)) return cleanHex(arr);
  return arr.map((b) => Number(b).toString(16).padStart(2, "0")).join("");
}

function sameHexish(a: unknown, b: unknown): boolean {
  return bytesToHex(a) === bytesToHex(b);
}

function bigintOrZero(v: unknown): bigint {
  try { return BigInt(String(v ?? "0")); } catch { return 0n; }
}

function roundPctAmount(amount: bigint, pct: number): bigint {
  const scale = 1_000_000n;
  const scaledPct = BigInt(Math.round(pct * Number(scale)));
  return (amount * scaledPct + scale / 2n) / scale;
}

function parseNoWinnerPolicy(v: unknown): "Refund" | "BiggestLoser" | "BiggestBalls" | "MostPlayed" {
  if (typeof v === "string") {
    if (v === "Refund" || v === "BiggestLoser" || v === "BiggestBalls" || v === "MostPlayed") return v;
  }
  if (v && typeof v === "object") {
    const k = Object.keys(v as Record<string, unknown>)[0];
    if (k === "Refund" || k === "BiggestLoser" || k === "BiggestBalls" || k === "MostPlayed") return k;
  }
  return "BiggestLoser";
}

function assetDecimals(input: SimRunInput, asset: Hex32): number {
  return input.assets.find((a) => sameHexish(a.asset, asset))?.decimals ?? 8;
}

function assetPriceUsdPerBaseFromThrow(input: SimRunInput, asset: Hex32): number {
  let bestEpoch = -1;
  let bestPrice = 0;
  for (const t of input.throws) {
    if (!sameHexish(t.asset, asset)) continue;
    const epoch = Number(t.price_epoch ?? 0);
    const amount = Number(String(t.amount ?? "0"));
    const dec = assetDecimals(input, asset);
    const display = amount / Math.pow(10, dec);
    const valueUsd = Number(String(t.value_usd_e8 ?? "0")) / 1e8;
    if (display > 0 && epoch >= bestEpoch) {
      bestEpoch = epoch;
      bestPrice = valueUsd / display;
    }
  }
  return bestPrice;
}

function baseToUsd(input: SimRunInput, asset: Hex32, amountBase: bigint): number {
  const dec = assetDecimals(input, asset);
  const price = assetPriceUsdPerBaseFromThrow(input, asset);
  return (Number(amountBase) / Math.pow(10, dec)) * price;
}

function stakeUsdOfThrow(t: ThrowRecord): number {
  return Number(String(t.value_usd_e8 ?? "0")) / 1e8;
}

function tUsdValue(t: ThrowRecord): number {
  const direct = Number(String(t.value_usd_e8 ?? "0")) / 1e8;
  if (Number.isFinite(direct) && direct > 0) return direct;
  return Number(t.mass_usd ?? 0);
}

function resolveHoleRules(input: SimRunInput): Map<number, HoleRule> {
  const m = new Map<number, HoleRule>();
  for (const [k, v] of Object.entries(DEFAULT_HOLE_RULES)) m.set(Number(k), { ...v });

  const rules = (input.map as any)?.tournament?.payout_rules;
  if (Array.isArray(rules)) {
    for (const rec of rules) {
      const id = Number((rec as any)?.id);
      const cf = (rec as any)?.rule?.CompositeFull ?? (rec as any)?.CompositeFull ?? null;
      if (!Number.isFinite(id) || !cf) continue;
      m.set(id, {
        return_pct: Number(cf.return_pct ?? 0),
        prize_pct: Number(cf.prize_pct ?? 0),
        losers_pct: Number(cf.losers_pct ?? 0),
        fee_pct: Number(cf.fee_pct ?? 0),
        creator_fee_pct: Number(cf.creator_fee_pct ?? 0),
        name: String(cf.name ?? (rec as any)?.name ?? `Hole ${id}`),
      });
    }
  }
  return m;
}

function computeScenario(run: CandidateScenarioRun, botUser: string): ScenarioComputed | null {
  const input = run.syntheticInput;
  const rules = resolveHoleRules(input);
  const noWinnerPolicy = parseNoWinnerPolicy((input.game as any)?.no_winner_policy);

  const throwsById = new Map<string, ThrowRecord>();
  for (const t of input.throws) throwsById.set(bytesToHex(t.id), t);

  const outcomes = Array.isArray(run.decoded?.per_throw) ? run.decoded.per_throw : [];
  const syntheticThrow = throwsById.get(cleanHex(run.syntheticThrowId));
  const syntheticOutcome = outcomes.find((o: any) => sameHexish(o.throw_id, run.syntheticThrowId)) ?? null;
  if (!syntheticThrow) return null;

  const userReturns = new Map<string, bigint>();
  const winnerReturns = new Map<string, bigint>();
  const losersPool = new Map<string, bigint>();
  const prizeAmounts = new Map<string, bigint>();
  const feeAmounts = new Map<string, bigint>();
  const creatorFeeAmounts = new Map<string, bigint>();
  const winnersWeightByUser = new Map<string, number>();

  let hasWinner = false;

  for (const outcome of outcomes) {
    const throwId = cleanHex((outcome as any).throw_id);
    const t = throwsById.get(throwId);
    if (!t) continue;
    const holeType = Number((outcome as any).hole_type ?? 0);
    const rule = rules.get(holeType);
    if (!rule) {
      throw new Error(`missing hole rule for hole_type=${holeType}`);
    }

    const asset = bytesToHex(t.asset);
    const user = bytesToHex(t.user);
    const amount = bigintOrZero(t.amount);

    let refund = roundPctAmount(amount, rule.return_pct);
    let prize = roundPctAmount(amount, rule.prize_pct);
    let lose = roundPctAmount(amount, rule.losers_pct);
    let fee = roundPctAmount(amount, rule.fee_pct);
    let creator = roundPctAmount(amount, rule.creator_fee_pct);
    const sum = refund + prize + lose + fee + creator;
    if (sum < amount) fee += amount - sum;

    userReturns.set(`${user}:${asset}`, (userReturns.get(`${user}:${asset}`) ?? 0n) + refund);
    prizeAmounts.set(asset, (prizeAmounts.get(asset) ?? 0n) + prize);
    feeAmounts.set(asset, (feeAmounts.get(asset) ?? 0n) + fee);
    creatorFeeAmounts.set(asset, (creatorFeeAmounts.get(asset) ?? 0n) + creator);
    losersPool.set(asset, (losersPool.get(asset) ?? 0n) + lose);

    if (holeType === 3) {
      winnersWeightByUser.set(user, (winnersWeightByUser.get(user) ?? 0) + tUsdValue(t));
      hasWinner = true;
    }
  }

  if (hasWinner) {
    const totalW = [...winnersWeightByUser.values()].reduce((a, b) => a + b, 0);
    if (totalW > 0) {
      for (const [asset, pool] of losersPool.entries()) {
        if (pool <= 0n) continue;
        const poolN = Number(pool);
        for (const [user, w] of winnersWeightByUser.entries()) {
          const share = BigInt(Math.floor(poolN * (w / totalW)));
          if (share > 0n) {
            winnerReturns.set(`${user}:${asset}`, (winnerReturns.get(`${user}:${asset}`) ?? 0n) + share);
          }
        }
      }
    }
  } else {
    let beneficiary: string | null = null;
    if (noWinnerPolicy === "Refund") {
      userReturns.clear();
      prizeAmounts.clear();
      feeAmounts.clear();
      creatorFeeAmounts.clear();
      losersPool.clear();
      winnerReturns.clear();
      for (const t of input.throws) {
        const user = bytesToHex(t.user);
        const asset = bytesToHex(t.asset);
        const amount = bigintOrZero(t.amount);
        userReturns.set(`${user}:${asset}`, (userReturns.get(`${user}:${asset}`) ?? 0n) + amount);
      }
    } else if (noWinnerPolicy === "BiggestLoser") {
      const lossByUser = new Map<string, number>();
      for (const t of input.throws) {
        const user = bytesToHex(t.user);
        lossByUser.set(user, (lossByUser.get(user) ?? 0) + tUsdValue(t));
      }
      beneficiary = [...lossByUser.entries()].sort((a,b)=>b[1]-a[1])[0]?.[0] ?? null;
    } else if (noWinnerPolicy === "BiggestBalls") {
      let best: { user: string; val: number } | null = null;
      for (const t of input.throws) {
        const v = Number(t.mass_usd ?? 0);
        const user = bytesToHex(t.user);
        if (!best || v > best.val) best = { user, val: v };
      }
      beneficiary = best?.user ?? null;
    } else if (noWinnerPolicy === "MostPlayed") {
      const byUser = new Map<string, number>();
      for (const t of input.throws) {
        const user = bytesToHex(t.user);
        byUser.set(user, (byUser.get(user) ?? 0) + tUsdValue(t));
      }
      beneficiary = [...byUser.entries()].sort((a,b)=>b[1]-a[1])[0]?.[0] ?? null;
    }

    if (beneficiary) {
      for (const [asset, pool] of losersPool.entries()) {
        if (pool <= 0n) continue;
        userReturns.set(`${beneficiary}:${asset}`, (userReturns.get(`${beneficiary}:${asset}`) ?? 0n) + pool);
      }
    }
  }

  const bankByAsset = new Map<string, bigint>();
  for (const t of input.throws) {
    const asset = bytesToHex(t.asset);
    bankByAsset.set(asset, (bankByAsset.get(asset) ?? 0n) + bigintOrZero(t.amount));
  }

  for (const [asset, bank] of bankByAsset.entries()) {
    let usersTotal = 0n;
    for (const [key, delta] of userReturns.entries()) if (key.endsWith(`:${asset}`)) usersTotal += delta;
    for (const [key, delta] of winnerReturns.entries()) if (key.endsWith(`:${asset}`)) usersTotal += delta;
    const prize = prizeAmounts.get(asset) ?? 0n;
    const fee = feeAmounts.get(asset) ?? 0n;
    const creator = creatorFeeAmounts.get(asset) ?? 0n;
    const needed = usersTotal + prize + fee + creator;
    if (needed > bank && needed > 0n) {
      const scale = Number(bank) / Number(needed);
      for (const [key, delta] of [...userReturns.entries()]) {
        if (!key.endsWith(`:${asset}`) || delta <= 0n) continue;
        userReturns.set(key, BigInt(Math.floor(Number(delta) * scale)));
      }
      for (const [key, delta] of [...winnerReturns.entries()]) {
        if (!key.endsWith(`:${asset}`) || delta <= 0n) continue;
        winnerReturns.set(key, BigInt(Math.floor(Number(delta) * scale)));
      }
    }
  }

  const targetUser = cleanHex(botUser);
  let stakeUsd = 0;
  let returnedUsd = 0;
  for (const t of input.throws) {
    if (bytesToHex(t.user) === targetUser) stakeUsd += stakeUsdOfThrow(t);
  }
  for (const [key, delta] of userReturns.entries()) {
    const [user, asset] = key.split(":");
    if (user === targetUser && delta > 0n) returnedUsd += baseToUsd(input, asset, delta);
  }
  for (const [key, delta] of winnerReturns.entries()) {
    const [user, asset] = key.split(":");
    if (user === targetUser && delta > 0n) returnedUsd += baseToUsd(input, asset, delta);
  }

  const holeType = syntheticOutcome ? Number((syntheticOutcome as any).hole_type ?? 0) : null;
  const winnerValuePct = holeType === 3 ? 100 : 0;

  return {
    weight: Number(run.scenario?.weight ?? 1),
    pnlUsd: returnedUsd - stakeUsd,
    holeType,
    valueUsd: stakeUsdOfThrow(syntheticThrow),
    valueUsdE8: String(syntheticThrow.value_usd_e8 ?? "0"),
    massUsd: Number(syntheticThrow.mass_usd ?? 0),
    winnerValuePct,
  };
}

function weightedMode(entries: Array<{ value: number | null; weight: number }>): number | null {
  const m = new Map<number, number>();
  for (const e of entries) {
    if (e.value == null) continue;
    m.set(e.value, (m.get(e.value) ?? 0) + e.weight);
  }
  let best: number | null = null;
  let bestWeight = -Infinity;
  for (const [k, w] of m.entries()) {
    if (w > bestWeight) {
      best = k;
      bestWeight = w;
    }
  }
  return best;
}

export function summarizePredictionFromPlan(plan: CandidatePlanRun, botUser: string): PredictionSummary | null {
  const computed = plan.perScenario
    .map((s) => computeScenario(s, botUser))
    .filter((v): v is ScenarioComputed => !!v);

  if (!computed.length) return null;

  const totalWeight = computed.reduce((a, b) => a + (b.weight || 1), 0) || 1;
  const weighted = (pick: (s: ScenarioComputed) => number | null) => {
    let num = 0;
    let den = 0;
    for (const s of computed) {
      const v = pick(s);
      if (v == null || !Number.isFinite(v)) continue;
      num += v * s.weight;
      den += s.weight;
    }
    return den > 0 ? num / den : null;
  };

  const pnlValues = computed.map((s) => s.pnlUsd).filter((v): v is number => v != null);
  const holeTypeCounts: Record<string, number> = {};
  for (const s of computed) {
    if (s.holeType == null) continue;
    const key = String(s.holeType);
    holeTypeCounts[key] = (holeTypeCounts[key] ?? 0) + 1;
  }

  const winnerScenarioCount = computed.filter((s) => s.holeType === 3).length;

  return {
    scenarioCount: computed.length,
    winnerScenarioCount,
    pnlUsd: weighted((s) => s.pnlUsd),
    bestPnlUsd: pnlValues.length ? Math.max(...pnlValues) : null,
    worstPnlUsd: pnlValues.length ? Math.min(...pnlValues) : null,
    holeType: weightedMode(computed.map((s) => ({ value: s.holeType, weight: s.weight }))),
    holeTypeCounts,
    valueUsd: weighted((s) => s.valueUsd),
    valueUsdE8: computed[0]?.valueUsdE8 ?? null,
    massUsd: weighted((s) => s.massUsd),
    winnerValuePct: weighted((s) => s.winnerValuePct),
  };
}
