import type { Hex32, SimRunInput, ThrowRecord } from "../collider/types.js";

export type HoleRule = {
  return_pct: number;
  prize_pct: number;
  losers_pct: number;
  fee_pct: number;
  creator_fee_pct: number;
  name: string;
};

export type ThrowOutcomeLike = {
  throw_id: Hex32;
  hole_type: number;
  endFrame: number;
  hole_i?: number;
};

export type PriceLookup = {
  source: "sim_input" | "report_prices_at_close";
  byAssetEpoch: Map<string, Map<number, number>>;
};

export type SettledThrowView = {
  throwId: Hex32;
  user: Hex32;
  asset: Hex32;
  amountBase: string;
  priceEpoch: number;
  amountDisplay: number;
  submissionValueUsd: number;
  weightedUsdValue: number;
  massUsd: number;
  enterFrame: number;
  holeType: number | null;
  holeIndex: number | null;
  endFrame: number | null;
  returnedByAssetBase: Record<string, string>;
  returnedUsd: number;
  pnlUsd: number;
  payoutKindsBase: Record<string, Record<string, string>>;
  payoutKindsUsd: Record<string, number>;
};

export type UserSettlementView = {
  user: Hex32;
  throwIds: Hex32[];
  stakeUsd: number;
  returnedUsd: number;
  pnlUsd: number;
  returnedByAssetBase: Record<string, string>;
  winnerWeightUsd: number;
};

export type ScenarioSettlementView = {
  throwsById: Map<string, SettledThrowView>;
  usersById: Map<string, UserSettlementView>;
  finalFrame: number;
  hasWinner: boolean;
  noWinnerPolicy: "Refund" | "BiggestLoser" | "BiggestBalls" | "MostPlayed";
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

function bigintOrZero(v: unknown): bigint {
  try {
    return BigInt(String(v ?? "0"));
  } catch {
    return 0n;
  }
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
    const key = Object.keys(v as Record<string, unknown>)[0];
    if (key === "Refund" || key === "BiggestLoser" || key === "BiggestBalls" || key === "MostPlayed") {
      return key;
    }
  }
  return "BiggestLoser";
}

function amountDisplay(amountBase: bigint, decimals: number): number {
  return Number(amountBase) / Math.pow(10, decimals);
}

function mergeBaseAmount(target: Record<string, string>, asset: string, amount: bigint): void {
  if (amount === 0n) return;
  target[asset] = (bigintOrZero(target[asset]) + amount).toString();
}

function mergeKindBaseAmount(
  target: Record<string, Record<string, string>>,
  kind: string,
  asset: string,
  amount: bigint,
): void {
  if (amount === 0n) return;
  target[kind] = target[kind] ?? {};
  mergeBaseAmount(target[kind], asset, amount);
}

function assetDecimals(input: SimRunInput, asset: Hex32): number {
  return input.assets.find((entry) => bytesToHex(entry.asset) === cleanHex(asset))?.decimals ?? 8;
}

function lookupPriceUsd(
  priceLookup: PriceLookup | null | undefined,
  asset: Hex32,
  epoch: number,
): number | null {
  const byEpoch = priceLookup?.byAssetEpoch.get(cleanHex(asset));
  if (!byEpoch) return null;
  return byEpoch.get(epoch) ?? null;
}

function throwUsdValue(
  input: SimRunInput,
  priceLookup: PriceLookup | null | undefined,
  throwRecord: ThrowRecord,
): number {
  const amountBase = bigintOrZero(throwRecord.amount);
  const asset = bytesToHex(throwRecord.asset);
  const epoch = Number(throwRecord.price_epoch ?? 0);
  const direct = Number(String(throwRecord.value_usd_e8 ?? "0")) / 1e8;
  const decimals = assetDecimals(input, asset);
  const px = lookupPriceUsd(priceLookup, asset, epoch);
  if (px != null) {
    return amountDisplay(amountBase, decimals) * px;
  }
  if (Number.isFinite(direct) && direct > 0) return direct;
  return Number(throwRecord.mass_usd ?? 0);
}

function baseToUsd(
  input: SimRunInput,
  priceLookup: PriceLookup | null | undefined,
  asset: Hex32,
  epoch: number,
  amountBase: bigint,
): number {
  const decimals = assetDecimals(input, asset);
  const px = lookupPriceUsd(priceLookup, asset, epoch);
  if (px != null) {
    return amountDisplay(amountBase, decimals) * px;
  }
  return 0;
}

function resolveHoleRules(input: SimRunInput): Map<number, HoleRule> {
  const rules = new Map<number, HoleRule>();
  for (const [key, value] of Object.entries(DEFAULT_HOLE_RULES)) {
    rules.set(Number(key), { ...value });
  }

  const payoutRules = (input.map as any)?.tournament?.payout_rules;
  if (!Array.isArray(payoutRules)) return rules;

  for (const record of payoutRules) {
    const id = Number(record?.id);
    const composite = record?.rule?.CompositeFull ?? record?.CompositeFull ?? null;
    if (!Number.isFinite(id) || !composite) continue;
    rules.set(id, {
      return_pct: Number(composite.return_pct ?? 0),
      prize_pct: Number(composite.prize_pct ?? 0),
      losers_pct: Number(composite.losers_pct ?? 0),
      fee_pct: Number(composite.fee_pct ?? 0),
      creator_fee_pct: Number(composite.creator_fee_pct ?? 0),
      name: String(composite.name ?? record?.name ?? `Hole ${id}`),
    });
  }

  return rules;
}

export function buildPriceLookupFromSimInput(input: SimRunInput): PriceLookup {
  const byAssetEpoch = new Map<string, Map<number, number>>();

  for (const throwRecord of input.throws) {
    const asset = bytesToHex(throwRecord.asset);
    const epoch = Number(throwRecord.price_epoch ?? 0);
    const amountBase = bigintOrZero(throwRecord.amount);
    const valueUsd = Number(String(throwRecord.value_usd_e8 ?? "0")) / 1e8;
    const decimals = assetDecimals(input, asset);
    const display = amountDisplay(amountBase, decimals);
    if (!(display > 0) || !Number.isFinite(valueUsd) || valueUsd <= 0) continue;

    const byEpoch = byAssetEpoch.get(asset) ?? new Map<number, number>();
    byEpoch.set(epoch, valueUsd / display);
    byAssetEpoch.set(asset, byEpoch);
  }

  return {
    source: "sim_input",
    byAssetEpoch,
  };
}

export function buildPriceLookupFromGameReport(report: unknown): PriceLookup {
  const root = report as Record<string, unknown>;
  const pricesAtClose = (root?.prices_at_close ?? {}) as Record<string, Record<string, string>>;
  const byAssetEpoch = new Map<string, Map<number, number>>();

  for (const [assetKey, perEpoch] of Object.entries(pricesAtClose)) {
    const asset = cleanHex(assetKey);
    const byEpoch = new Map<number, number>();
    for (const [epochKey, priceRaw] of Object.entries(perEpoch ?? {})) {
      const epoch = Number(epochKey);
      const price = Number(String(priceRaw ?? "0")) / 1e8;
      if (!Number.isFinite(epoch) || !Number.isFinite(price)) continue;
      byEpoch.set(epoch, price);
    }
    if (byEpoch.size > 0) {
      byAssetEpoch.set(asset, byEpoch);
    }
  }

  return {
    source: "report_prices_at_close",
    byAssetEpoch,
  };
}

function makeThrowView(
  input: SimRunInput,
  priceLookup: PriceLookup | null | undefined,
  throwRecord: ThrowRecord,
): SettledThrowView {
  const asset = bytesToHex(throwRecord.asset);
  const amountBase = bigintOrZero(throwRecord.amount);
  const decimals = assetDecimals(input, asset);
  const submissionValueUsd = Number(String(throwRecord.value_usd_e8 ?? "0")) / 1e8;

  return {
    throwId: bytesToHex(throwRecord.id),
    user: bytesToHex(throwRecord.user),
    asset,
    amountBase: amountBase.toString(),
    priceEpoch: Number(throwRecord.price_epoch ?? 0),
    amountDisplay: amountDisplay(amountBase, decimals),
    submissionValueUsd,
    weightedUsdValue: throwUsdValue(input, priceLookup, throwRecord),
    massUsd: Number(throwRecord.mass_usd ?? 0),
    enterFrame: Number(throwRecord.enter_frame ?? 0),
    holeType: null,
    holeIndex: null,
    endFrame: null,
    returnedByAssetBase: {},
    returnedUsd: 0,
    pnlUsd: 0,
    payoutKindsBase: {},
    payoutKindsUsd: {},
  };
}

function beneficiaryUserByPolicy(
  throwsById: Map<string, ThrowRecord>,
  noWinnerPolicy: "Refund" | "BiggestLoser" | "BiggestBalls" | "MostPlayed",
  throwViews: Map<string, SettledThrowView>,
): string | null {
  if (noWinnerPolicy === "Refund") return null;

  if (noWinnerPolicy === "BiggestBalls") {
    let best: { user: string; massUsd: number } | null = null;
    for (const [throwId, throwView] of throwViews.entries()) {
      if (!best || throwView.massUsd > best.massUsd) {
        best = { user: throwView.user, massUsd: throwView.massUsd };
      }
    }
    return best?.user ?? null;
  }

  const totals = new Map<string, number>();
  for (const [throwId, throwRecord] of throwsById.entries()) {
    const throwView = throwViews.get(throwId);
    if (!throwView) continue;
    const key = bytesToHex(throwRecord.user);
    const weight = noWinnerPolicy === "MostPlayed"
      ? Number(throwRecord.mass_usd ?? 0)
      : throwView.weightedUsdValue;
    totals.set(key, (totals.get(key) ?? 0) + weight);
  }

  return [...totals.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

function allocateAcrossThrows(
  throwIds: string[],
  throwViews: Map<string, SettledThrowView>,
  totalAmount: bigint,
  kind: string,
  asset: string,
  weightOf: (throwView: SettledThrowView) => number,
): void {
  if (totalAmount <= 0n || throwIds.length === 0) return;

  const weighted = throwIds
    .map((throwId) => throwViews.get(throwId))
    .filter((throwView): throwView is SettledThrowView => !!throwView)
    .map((throwView) => ({
      throwView,
      weight: Math.max(0, weightOf(throwView)),
    }));

  if (weighted.length === 0) return;

  const totalWeight = weighted.reduce((sum, entry) => sum + entry.weight, 0);
  if (!(totalWeight > 0)) {
    const target = weighted[0]?.throwView;
    if (!target) return;
    mergeBaseAmount(target.returnedByAssetBase, asset, totalAmount);
    mergeKindBaseAmount(target.payoutKindsBase, kind, asset, totalAmount);
    return;
  }

  let remaining = totalAmount;
  weighted.forEach((entry, index) => {
    const isLast = index === weighted.length - 1;
    const share = isLast
      ? remaining
      : BigInt(Math.floor(Number(totalAmount) * (entry.weight / totalWeight)));
    remaining -= share;
    mergeBaseAmount(entry.throwView.returnedByAssetBase, asset, share);
    mergeKindBaseAmount(entry.throwView.payoutKindsBase, kind, asset, share);
  });
}

export function buildScenarioSettlementView(params: {
  input: SimRunInput;
  outcomes: ThrowOutcomeLike[];
  priceLookup?: PriceLookup | null;
}): ScenarioSettlementView {
  const { input, outcomes, priceLookup = null } = params;
  const rules = resolveHoleRules(input);
  const noWinnerPolicy = parseNoWinnerPolicy((input.game as any)?.no_winner_policy);

  const throwsById = new Map<string, ThrowRecord>();
  const throwViews = new Map<string, SettledThrowView>();
  const usersById = new Map<string, UserSettlementView>();
  const winnersByUser = new Map<string, string[]>();
  const winnersWeightByUser = new Map<string, number>();
  const losersPoolByAsset = new Map<string, bigint>();
  let hasWinner = false;
  let finalFrame = 0;

  for (const throwRecord of input.throws) {
    const throwId = bytesToHex(throwRecord.id);
    throwsById.set(throwId, throwRecord);
    const throwView = makeThrowView(input, priceLookup, throwRecord);
    throwViews.set(throwId, throwView);
    usersById.set(throwView.user, {
      user: throwView.user,
      throwIds: [...(usersById.get(throwView.user)?.throwIds ?? []), throwId],
      stakeUsd: (usersById.get(throwView.user)?.stakeUsd ?? 0) + throwView.submissionValueUsd,
      returnedUsd: usersById.get(throwView.user)?.returnedUsd ?? 0,
      pnlUsd: 0,
      returnedByAssetBase: usersById.get(throwView.user)?.returnedByAssetBase ?? {},
      winnerWeightUsd: 0,
    });
  }

  for (const outcome of outcomes) {
    const throwId = bytesToHex(outcome.throw_id);
    const throwRecord = throwsById.get(throwId);
    const throwView = throwViews.get(throwId);
    if (!throwRecord || !throwView) continue;

    const holeType = Number(outcome.hole_type ?? 0);
    const rule = rules.get(holeType);
    if (!rule) continue;

    const amount = bigintOrZero(throwRecord.amount);
    const asset = throwView.asset;
    const user = throwView.user;

    let refund = roundPctAmount(amount, rule.return_pct);
    let prize = roundPctAmount(amount, rule.prize_pct);
    let lose = roundPctAmount(amount, rule.losers_pct);
    let fee = roundPctAmount(amount, rule.fee_pct);
    let creatorFee = roundPctAmount(amount, rule.creator_fee_pct);
    const sum = refund + prize + lose + fee + creatorFee;
    if (sum < amount) {
      fee += amount - sum;
    }

    throwView.holeType = holeType;
    throwView.holeIndex = Number.isFinite(Number(outcome.hole_i)) ? Number(outcome.hole_i) : null;
    throwView.endFrame = Number.isFinite(Number(outcome.endFrame)) ? Number(outcome.endFrame) : null;
    finalFrame = Math.max(finalFrame, throwView.endFrame ?? 0);

    mergeBaseAmount(throwView.returnedByAssetBase, asset, refund);
    mergeKindBaseAmount(throwView.payoutKindsBase, "Return", asset, refund);
    losersPoolByAsset.set(asset, (losersPoolByAsset.get(asset) ?? 0n) + lose);
    void prize;
    void fee;
    void creatorFee;

    if (holeType === 3) {
      winnersByUser.set(user, [...(winnersByUser.get(user) ?? []), throwId]);
      winnersWeightByUser.set(user, (winnersWeightByUser.get(user) ?? 0) + throwView.weightedUsdValue);
      const userView = usersById.get(user);
      if (userView) userView.winnerWeightUsd = winnersWeightByUser.get(user) ?? 0;
      hasWinner = true;
    }
  }

  if (hasWinner) {
    const totalWinnerWeight = [...winnersWeightByUser.values()].reduce((sum, value) => sum + value, 0);
    if (totalWinnerWeight > 0) {
      for (const [asset, pool] of losersPoolByAsset.entries()) {
        if (pool <= 0n) continue;
        for (const [user, winnerWeight] of winnersWeightByUser.entries()) {
          const userShare = BigInt(Math.floor(Number(pool) * (winnerWeight / totalWinnerWeight)));
          if (userShare <= 0n) continue;
          allocateAcrossThrows(
            winnersByUser.get(user) ?? [],
            throwViews,
            userShare,
            "WinnerShare",
            asset,
            (throwView) => throwView.weightedUsdValue,
          );
        }
      }
    }
  } else if (noWinnerPolicy === "Refund") {
    for (const throwView of throwViews.values()) {
      const amount = bigintOrZero(throwView.amountBase);
      throwView.returnedByAssetBase = {};
      throwView.payoutKindsBase = {};
      mergeBaseAmount(throwView.returnedByAssetBase, throwView.asset, amount);
      mergeKindBaseAmount(throwView.payoutKindsBase, "Return", throwView.asset, amount);
    }
  } else {
    const beneficiary = beneficiaryUserByPolicy(throwsById, noWinnerPolicy, throwViews);
    if (beneficiary) {
      const beneficiaryThrowIds = usersById.get(beneficiary)?.throwIds ?? [];
      const weightOf = noWinnerPolicy === "BiggestBalls"
        ? (throwView: SettledThrowView) => throwView.massUsd
        : (throwView: SettledThrowView) => (noWinnerPolicy === "MostPlayed" ? throwView.massUsd : throwView.weightedUsdValue);
      for (const [asset, pool] of losersPoolByAsset.entries()) {
        if (pool <= 0n) continue;
        allocateAcrossThrows(beneficiaryThrowIds, throwViews, pool, "Return", asset, weightOf);
      }
    }
  }

  for (const throwView of throwViews.values()) {
    let returnedUsd = 0;
    for (const [asset, amountRaw] of Object.entries(throwView.returnedByAssetBase)) {
      returnedUsd += baseToUsd(input, priceLookup, asset, throwView.priceEpoch, bigintOrZero(amountRaw));
    }
    throwView.returnedUsd = returnedUsd;
    throwView.pnlUsd = returnedUsd - throwView.submissionValueUsd;

    const payoutKindsUsd: Record<string, number> = {};
    for (const [kind, perAsset] of Object.entries(throwView.payoutKindsBase)) {
      payoutKindsUsd[kind] = Object.entries(perAsset).reduce((sum, [asset, amountRaw]) => {
        return sum + baseToUsd(input, priceLookup, asset, throwView.priceEpoch, bigintOrZero(amountRaw));
      }, 0);
    }
    throwView.payoutKindsUsd = payoutKindsUsd;
  }

  for (const userView of usersById.values()) {
    userView.returnedByAssetBase = {};
    userView.returnedUsd = 0;
    for (const throwId of userView.throwIds) {
      const throwView = throwViews.get(throwId);
      if (!throwView) continue;
      for (const [asset, amountRaw] of Object.entries(throwView.returnedByAssetBase)) {
        mergeBaseAmount(userView.returnedByAssetBase, asset, bigintOrZero(amountRaw));
      }
      userView.returnedUsd += throwView.returnedUsd;
    }
    userView.pnlUsd = userView.returnedUsd - userView.stakeUsd;
  }

  return {
    throwsById: throwViews,
    usersById,
    finalFrame,
    hasWinner,
    noWinnerPolicy,
  };
}

