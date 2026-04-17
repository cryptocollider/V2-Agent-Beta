import type { GameListItem, SimRunInput } from "../collider/types.js";
import type { AgentPolicy } from "../policy/schema.js";

export type EligibilityReasonCode =
  | "cooldown"
  | "per_game_cap"
  | "session_cap"
  | "target_profit"
  | "target_balance"
  | "asset_not_allowed"
  | "asset_blocked"
  | "reserve_balance"
  | "no_balance_for_amounts"
  | "missing_price_basis"
  | "below_game_min_throw"
  | "below_min_throw_usd"
  | "above_max_throw_usd"
  | "above_max_single_throw_usd"
  | "above_game_exposure"
  | "no_candidates_after_filter"
  | "search_budget_stop"
  | "below_min_game_stake"
  | "no_game";

export type SessionEligibilityContext = {
  now: number;
  cooldownMsPerGame: number;
  recentGameTouches?: Record<string, number>;
  sessionThrowCounts?: Record<string, number>;
  maxThrowsPerGame?: number;
};

export type GameEligibilityEntry = {
  gameId: string;
  eligible: boolean;
  reasons: EligibilityReasonCode[];
  throws: number;
  stake: string;
  stakeUsd: number;
  minThrowValue: string;
  status: number;
};

export type AssetPlanningEntry = {
  asset: string;
  allowed: boolean;
  blocked: boolean;
  reasons: EligibilityReasonCode[];
  balanceBase: string;
  reserveBase: string;
  usableBalanceBase: string;
  priceBasisUsdPerBase: number | null;
  requestedUsdTargets: number[];
  generatedAmounts: string[];
  usableAmounts: string[];
  keepPriority: number;
  disposePriority: number;
};

export type AssetAmountPair = {
  asset: string;
  amount: string;
};

export type AssetPlanningResult = {
  entries: AssetPlanningEntry[];
  assetAmountPairs: AssetAmountPair[];
  requestedUsdTargets: number[];
  globalReasons: EligibilityReasonCode[];
};

export type CandidateFilterSummary = {
  reasonCounts: Partial<Record<EligibilityReasonCode, number>>;
  totalRawCandidates: number;
  totalEligibleCandidates: number;
  limitedCandidates: number;
  plannedCandidates: number;
};

export type LatestEligibilitySnapshot = {
  ts: string;
  globalReasons: EligibilityReasonCode[];
  selectedGameId: string | null;
  perGame: GameEligibilityEntry[];
  assetPlanning: AssetPlanningEntry[];
  candidateFilterSummary: CandidateFilterSummary;
  notes: string[];
};

type CandidateLike = {
  amount: string;
  asset: string;
};

function parseBaseAmount(value: unknown): bigint {
  try {
    return BigInt(String(value ?? "0"));
  } catch {
    return 0n;
  }
}

export function cleanHex(value: unknown): string {
  return String(value ?? "").replace(/^0x/i, "").toLowerCase();
}

export function normalizeAssetList(input: string[] | undefined): string[] {
  return (input ?? []).map((x) => cleanHex(x)).filter(Boolean);
}

export function parseStakeUsdLike(raw: string | number | null | undefined): number {
  const n = Number(raw ?? 0);
  if (!Number.isFinite(n)) return 0;
  return Math.abs(n) >= 100000 ? n / 1e8 : n;
}

function findBalanceBase(balances: Record<string, string> | undefined, assetHex: string): bigint {
  if (!balances) return 0n;
  const normalized = cleanHex(assetHex);
  const raw = balances[normalized] ?? balances[`0x${normalized}`] ?? "0";
  return parseBaseAmount(raw);
}

function normalizeAssetHex(value: unknown): string {
  return Array.isArray(value)
    ? value.map((b) => Number(b).toString(16).padStart(2, "0")).join("")
    : cleanHex(String(value || ""));
}

function hintedUsdPerBase(priceHintsUsdPerBase: Record<string, number> | undefined, assetHex: string): number | null {
  const hinted = Number(priceHintsUsdPerBase?.[cleanHex(assetHex)]);
  return Number.isFinite(hinted) && hinted > 0 ? hinted : null;
}

export function estimateAssetUsdPerBaseUnit(
  simInput: SimRunInput,
  assetHex: string,
  priceHintsUsdPerBase?: Record<string, number>,
): number | null {
  const target = cleanHex(assetHex);
  let bestEpoch = -1;
  let bestPerBase: number | null = null;

  for (const throwRecord of simInput.throws || []) {
    if (normalizeAssetHex((throwRecord as { asset?: unknown }).asset) !== target) continue;
    const epoch = Number((throwRecord as { price_epoch?: unknown }).price_epoch ?? 0);
    const amountBase = Number((throwRecord as { amount?: unknown }).amount ?? 0);
    const valueUsd = Number((throwRecord as { value_usd_e8?: unknown }).value_usd_e8 ?? 0) / 1e8;
    if (!(amountBase > 0) || !Number.isFinite(valueUsd) || valueUsd <= 0) continue;
    if (epoch >= bestEpoch) {
      bestEpoch = epoch;
      bestPerBase = valueUsd / amountBase;
    }
  }

  if (bestPerBase != null && Number.isFinite(bestPerBase) && bestPerBase > 0) {
    return bestPerBase;
  }

  return hintedUsdPerBase(priceHintsUsdPerBase, target);
}

export function estimateCandidateUsd(
  amountBase: string,
  assetHex: string,
  simInput: SimRunInput,
  priceHintsUsdPerBase?: Record<string, number>,
): number | null {
  const perBase = estimateAssetUsdPerBaseUnit(simInput, assetHex, priceHintsUsdPerBase);
  const amount = Number(amountBase || 0);
  if (perBase == null || !Number.isFinite(amount)) return null;
  return amount * perBase;
}

export function estimateBaseAmountForUsd(
  simInput: SimRunInput,
  assetHex: string,
  usd: number,
  priceHintsUsdPerBase?: Record<string, number>,
): string | null {
  const perBase = estimateAssetUsdPerBaseUnit(simInput, assetHex, priceHintsUsdPerBase);
  if (perBase == null || perBase <= 0 || !Number.isFinite(usd) || usd <= 0) return null;
  const out = Math.max(1, Math.round(usd / perBase));
  return String(out);
}

export function buildUsdTargets(
  policy: AgentPolicy,
  fallbackUsd: number | null,
): { targets: number[]; reasons: EligibilityReasonCode[] } {
  const explicitMin = Number.isFinite(Number(policy.minThrowUsd)) ? Number(policy.minThrowUsd) : null;
  const explicitMax = Number.isFinite(Number(policy.maxThrowUsd)) ? Number(policy.maxThrowUsd) : null;
  const minUsd = explicitMin ?? fallbackUsd;
  const maxUsd = explicitMax ?? minUsd;

  if (minUsd == null || maxUsd == null || !Number.isFinite(minUsd) || !Number.isFinite(maxUsd)) {
    return { targets: [], reasons: ["missing_price_basis"] };
  }

  const lo = Math.max(0.000001, Math.min(minUsd, maxUsd));
  const hi = Math.max(lo, Math.max(minUsd, maxUsd));
  const mid = lo + (hi - lo) * 0.5;
  const baseTargets =
    policy.riskMode === "defensive"
      ? [lo, mid]
      : policy.riskMode === "aggressive"
        ? [mid, hi]
        : [lo, mid, hi];

  return {
    targets: baseTargets.filter((value, index, arr) => arr.indexOf(value) === index),
    reasons: [],
  };
}

export function evaluateGamesForEligibility(
  games: GameListItem[],
  policy: AgentPolicy,
  sessionContext?: SessionEligibilityContext,
): { entries: GameEligibilityEntry[]; selectedGame: GameListItem | null } {
  const entries: GameEligibilityEntry[] = games.map((game) => {
    const reasons: EligibilityReasonCode[] = [];
    const stakeUsd = parseStakeUsdLike(game.stake);

    if (sessionContext) {
      const lastTouch = sessionContext.recentGameTouches?.[game.game_id] ?? 0;
      const perGameCount = sessionContext.sessionThrowCounts?.[game.game_id] ?? 0;
      if (sessionContext.now - lastTouch < sessionContext.cooldownMsPerGame) reasons.push("cooldown");
      if (
        sessionContext.maxThrowsPerGame != null &&
        perGameCount >= sessionContext.maxThrowsPerGame
      ) {
        reasons.push("per_game_cap");
      }
    }

    if (policy.minGameStakeUsd != null && stakeUsd < policy.minGameStakeUsd) {
      reasons.push("below_min_game_stake");
    }
    if (policy.maxGameExposureUsd != null && stakeUsd > policy.maxGameExposureUsd) {
      reasons.push("above_game_exposure");
    }

    return {
      gameId: game.game_id,
      eligible: reasons.length === 0,
      reasons,
      throws: game.throws,
      stake: game.stake,
      stakeUsd,
      minThrowValue: game.throw_min_value,
      status: game.status,
    };
  });

  const eligibleGames = games.filter((game) => {
    const entry = entries.find((item) => item.gameId === game.game_id);
    return !!entry?.eligible;
  });

  const selectedGame = eligibleGames.sort((a, b) => {
    const aTouch = sessionContext?.recentGameTouches?.[a.game_id] ?? 0;
    const bTouch = sessionContext?.recentGameTouches?.[b.game_id] ?? 0;
    if (aTouch !== bTouch) return aTouch - bTouch;

    const aCount = sessionContext?.sessionThrowCounts?.[a.game_id] ?? 0;
    const bCount = sessionContext?.sessionThrowCounts?.[b.game_id] ?? 0;
    if (aCount !== bCount) return aCount - bCount;

    const aStake = parseStakeUsdLike(a.stake);
    const bStake = parseStakeUsdLike(b.stake);
    if (aStake !== bStake) return bStake - aStake;

    return String(a.game_id).localeCompare(String(b.game_id));
  })[0] ?? null;

  return { entries, selectedGame };
}

export function buildAssetPlanningResult(params: {
  policy: AgentPolicy;
  balances: Record<string, string>;
  simInput: SimRunInput;
  defaultAsset: string;
  defaultAmount: string;
  priceHintsUsdPerBase?: Record<string, number>;
}): AssetPlanningResult {
  const { policy, balances, simInput, defaultAsset, defaultAmount, priceHintsUsdPerBase } = params;
  const allowedAssets = normalizeAssetList(policy.allowedAssets);
  const blockedAssets = new Set(normalizeAssetList(policy.blockedAssets));
  const keepAssets = new Set(normalizeAssetList(policy.keepAssets));
  const disposeAssets = new Set(normalizeAssetList(policy.disposeAssets));

  const reserveBase = parseBaseAmount(policy.reserveBalanceBase || "0");
  const fallbackUsd = estimateCandidateUsd(defaultAmount, defaultAsset, simInput, priceHintsUsdPerBase);
  const { targets: requestedUsdTargets, reasons: targetReasons } = buildUsdTargets(policy, fallbackUsd);

  const candidateUniverse = new Set<string>([cleanHex(defaultAsset)]);
  for (const asset of allowedAssets) candidateUniverse.add(asset);

  const entries: AssetPlanningEntry[] = [];
  const assetAmountPairs: AssetAmountPair[] = [];

  for (const asset of candidateUniverse) {
    const reasons: EligibilityReasonCode[] = [];
    const allowed = allowedAssets.length === 0 || allowedAssets.includes(asset);
    const blocked = blockedAssets.has(asset);
    if (!allowed) reasons.push("asset_not_allowed");
    if (blocked) reasons.push("asset_blocked");

    const balanceBase = findBalanceBase(balances, asset);
    if (balanceBase <= reserveBase) reasons.push("reserve_balance");
    const usableBalanceBase = balanceBase > reserveBase ? balanceBase - reserveBase : 0n;

    const priceBasisUsdPerBase = estimateAssetUsdPerBaseUnit(simInput, asset, priceHintsUsdPerBase);
    if (requestedUsdTargets.length > 0 && priceBasisUsdPerBase == null) {
      reasons.push("missing_price_basis");
    }
    for (const reason of targetReasons) {
      if (!reasons.includes(reason)) reasons.push(reason);
    }

    const generatedAmounts = requestedUsdTargets
      .map((usd) => estimateBaseAmountForUsd(simInput, asset, usd, priceHintsUsdPerBase))
      .filter((value): value is string => !!value)
      .filter((value, index, arr) => arr.indexOf(value) === index);

    const usableAmounts: string[] = [];
    for (const amount of generatedAmounts) {
      const amountBase = parseBaseAmount(amount);
      if (balanceBase - amountBase >= reserveBase) {
        usableAmounts.push(amount);
        if (allowed && !blocked) {
          assetAmountPairs.push({ asset, amount });
        }
      }
    }

    if (allowed && !blocked && generatedAmounts.length > 0 && usableAmounts.length === 0) {
      reasons.push("no_balance_for_amounts");
    }

    entries.push({
      asset,
      allowed,
      blocked,
      reasons: reasons.filter((value, index, arr) => arr.indexOf(value) === index),
      balanceBase: balanceBase.toString(),
      reserveBase: reserveBase.toString(),
      usableBalanceBase: usableBalanceBase.toString(),
      priceBasisUsdPerBase,
      requestedUsdTargets,
      generatedAmounts,
      usableAmounts,
      keepPriority: keepAssets.has(asset) ? 1 : 0,
      disposePriority: disposeAssets.has(asset) ? 1 : 0,
    });
  }

  assetAmountPairs.sort((a, b) => {
    const aScore = (keepAssets.has(a.asset) ? 1 : 0) - (disposeAssets.has(a.asset) ? 1 : 0);
    const bScore = (keepAssets.has(b.asset) ? 1 : 0) - (disposeAssets.has(b.asset) ? 1 : 0);
    if (aScore !== bScore) return bScore - aScore;
    const aUsd = estimateCandidateUsd(a.amount, a.asset, simInput, priceHintsUsdPerBase) ?? -1;
    const bUsd = estimateCandidateUsd(b.amount, b.asset, simInput, priceHintsUsdPerBase) ?? -1;
    return bUsd - aUsd;
  });

  const globalReasons: EligibilityReasonCode[] = [];
  if (assetAmountPairs.length === 0 && entries.some((entry) => entry.reasons.includes("missing_price_basis"))) {
    globalReasons.push("missing_price_basis");
  }
  if (assetAmountPairs.length === 0 && entries.some((entry) => entry.reasons.includes("no_balance_for_amounts"))) {
    globalReasons.push("no_balance_for_amounts");
  }
  if (assetAmountPairs.length === 0 && entries.some((entry) => entry.reasons.includes("reserve_balance"))) {
    globalReasons.push("reserve_balance");
  }
  if (assetAmountPairs.length === 0 && entries.some((entry) => entry.reasons.includes("asset_blocked"))) {
    globalReasons.push("asset_blocked");
  }
  if (assetAmountPairs.length === 0 && entries.some((entry) => entry.reasons.includes("asset_not_allowed"))) {
    globalReasons.push("asset_not_allowed");
  }

  return {
    entries,
    assetAmountPairs,
    requestedUsdTargets,
    globalReasons,
  };
}

export function getCandidateFilterReasons(params: {
  candidate: CandidateLike;
  chosenGame: GameListItem;
  policy: AgentPolicy;
  simInput: SimRunInput;
  balances?: Record<string, string>;
  priceHintsUsdPerBase?: Record<string, number>;
}): EligibilityReasonCode[] {
  const { candidate, chosenGame, policy, simInput, balances, priceHintsUsdPerBase } = params;
  const reasons: EligibilityReasonCode[] = [];
  const allowedAssets = normalizeAssetList(policy.allowedAssets);
  const blockedAssets = new Set(normalizeAssetList(policy.blockedAssets));
  const candidateAsset = cleanHex(candidate.asset);

  if (allowedAssets.length > 0 && !allowedAssets.includes(candidateAsset)) reasons.push("asset_not_allowed");
  if (blockedAssets.has(candidateAsset)) reasons.push("asset_blocked");

  const balanceBase = findBalanceBase(balances, candidateAsset);
  const reserveBase = parseBaseAmount(policy.reserveBalanceBase || "0");
  const amountBase = parseBaseAmount(candidate.amount);

  if (balanceBase <= reserveBase) reasons.push("reserve_balance");
  if (balanceBase - amountBase < reserveBase) reasons.push("no_balance_for_amounts");

  if (parseBaseAmount(candidate.amount) < parseBaseAmount(chosenGame.throw_min_value)) {
    reasons.push("below_game_min_throw");
  }

  const candidateUsd = estimateCandidateUsd(candidate.amount, candidate.asset, simInput, priceHintsUsdPerBase);
  if (candidateUsd == null) {
    reasons.push("missing_price_basis");
    return reasons.filter((value, index, arr) => arr.indexOf(value) === index);
  }

  if (policy.minThrowUsd != null && candidateUsd < policy.minThrowUsd) reasons.push("below_min_throw_usd");
  if (policy.maxThrowUsd != null && candidateUsd > policy.maxThrowUsd) reasons.push("above_max_throw_usd");
  if (policy.maxSingleThrowUsd != null && candidateUsd > policy.maxSingleThrowUsd) {
    reasons.push("above_max_single_throw_usd");
  }
  if (policy.maxGameExposureUsd != null) {
    const currentStakeUsd = parseStakeUsdLike(chosenGame.stake);
    if (currentStakeUsd + candidateUsd > policy.maxGameExposureUsd) reasons.push("above_game_exposure");
  }

  return reasons.filter((value, index, arr) => arr.indexOf(value) === index);
}

export function incrementReasonCount(
  counts: Partial<Record<EligibilityReasonCode, number>>,
  reason: EligibilityReasonCode,
): void {
  counts[reason] = (counts[reason] ?? 0) + 1;
}

export function buildEligibilityCompactCode(snapshot: LatestEligibilitySnapshot | null): string {
  if (!snapshot) return "CHECK";
  const reasons = new Set(snapshot.globalReasons);
  const counts = snapshot.candidateFilterSummary.reasonCounts;

  if (reasons.has("target_balance")) return "TARGET/BAL";
  if (reasons.has("target_profit")) return "TARGET/PNL";
  if (reasons.has("session_cap")) return "MAX/S";
  if (reasons.has("cooldown")) return "COOLDOWN";
  if (snapshot.perGame.length > 0 && snapshot.perGame.every((entry) => entry.reasons.includes("cooldown"))) return "COOLDOWN";
  if (snapshot.perGame.length > 0 && snapshot.perGame.every((entry) => entry.reasons.includes("per_game_cap"))) return "MAX/G";
  if (reasons.has("reserve_balance") || reasons.has("no_balance_for_amounts")) return "NO-CAND/BAL";
  if (counts.below_game_min_throw || counts.below_min_throw_usd || counts.above_max_throw_usd) return "NO-CAND/MIN";
  if (counts.above_max_single_throw_usd || counts.above_game_exposure) return "NO-CAND/RISK";
  if (reasons.has("search_budget_stop")) return "NO-CAND/SEARCH";
  if (reasons.has("missing_price_basis") || reasons.has("asset_blocked") || reasons.has("asset_not_allowed")) return "NO-CAND/FILTER";
  if (reasons.has("no_candidates_after_filter")) return "NO-CAND/FILTER";
  if (reasons.has("below_min_game_stake")) return "STAKE/MIN";
  return "NO-CAND";
}





