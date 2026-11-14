import type { Hex32, SimRunInput, ThrowRecord } from "../collider/types.js";
import { defaultDecimalsForAsset } from "../core/assets-meta.js";
import { decimalE8ToApproxNumber, decimalUnitsToApproxNumber } from "../core/exact.js";
import { computePayouts, distribute, uint } from "./exact-payouts.js";


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
  return decimalUnitsToApproxNumber(amountBase.toString(), decimals) ?? 0;
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
  return input.assets.find((entry) => bytesToHex(entry.asset) === cleanHex(asset))?.decimals ?? defaultDecimalsForAsset(asset);
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
  const direct = decimalE8ToApproxNumber(throwRecord.value_usd_e8) ?? 0;
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


export function buildPriceLookupFromSimInput(input: SimRunInput): PriceLookup {
  const byAssetEpoch = new Map<string, Map<number, number>>();

  for (const throwRecord of input.throws) {
    const asset = bytesToHex(throwRecord.asset);
    const epoch = Number(throwRecord.price_epoch ?? 0);
    const amountBase = bigintOrZero(throwRecord.amount);
    const valueUsd = decimalE8ToApproxNumber(throwRecord.value_usd_e8) ?? 0;
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
  const submissionValueUsd = decimalE8ToApproxNumber(throwRecord.value_usd_e8) ?? 0;

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

export function buildScenarioSettlementView(params: {
  input: SimRunInput;
  outcomes: ThrowOutcomeLike[];
  priceLookup?: PriceLookup | null;
  holeRules?: unknown;
  canonicalPayouts?: unknown;
}): ScenarioSettlementView {
  const { input, outcomes, priceLookup = null } = params;
  const plan = computePayouts(input, outcomes, params.holeRules);
  // The VM publishes user-level credits. Per-throw values below are deterministic
  // attributions of those credits, never a second source of bank balances.
  if (params.canonicalPayouts !== undefined) {
    if (!Array.isArray(params.canonicalPayouts)) throw Error("canonical payouts unavailable");
    for (const [kind, expected] of [["Return",plan.returns],["WinnerShare",plan.winners]] as const) {
      const observed = new Map<string,bigint>();
      for (const p of params.canonicalPayouts) {
        if (p.kind !== kind) continue;
        const key = bytesToHex(p.user)+":"+bytesToHex(p.asset);
        const amount = uint(p.amount);
        if (amount) observed.set(key,(observed.get(key)??0n)+amount);
      }
      if (expected.size !== observed.size || [...expected].some(([key,n])=>observed.get(key)!==n)) {
        throw Error("local payout plan differs from canonical VM credits");
      }
    }
  }
  const throwViews = new Map<string,SettledThrowView>();
  const usersById = new Map<string,UserSettlementView>();
  const outcomeById = new Map(outcomes.map(o=>[bytesToHex(o.throw_id),o]));
  let finalFrame = 0;
  for (const t of input.throws) {
    const id=bytesToHex(t.id),view=makeThrowView(input,priceLookup,t),o=outcomeById.get(id)!;
    view.holeType=Number(o.hole_type); view.holeIndex=Number.isFinite(Number(o.hole_i))?Number(o.hole_i):null;
    view.endFrame=Number(o.endFrame);finalFrame=Math.max(finalFrame,view.endFrame);
    const amount=plan.directByThrow.get(id)??0n;
    mergeBaseAmount(view.returnedByAssetBase,view.asset,amount);
    mergeKindBaseAmount(view.payoutKindsBase,"Return",view.asset,amount);
    throwViews.set(id,view);
    const user=usersById.get(view.user)??{user:view.user,throwIds:[],stakeUsd:0,returnedUsd:0,pnlUsd:0,returnedByAssetBase:{},winnerWeightUsd:0};
    user.throwIds.push(id);user.stakeUsd+=view.submissionValueUsd;usersById.set(view.user,user);
  }
  function attribute(user:string,asset:string,total:bigint,kind:string,winnersOnly:boolean) {
    const eligible=[...throwViews.values()].filter(t=>t.user===user&&(!winnersOnly||t.holeType===3));
    const weights=new Map<string,bigint>();
    for(const t of input.throws)if(eligible.some(v=>v.throwId===bytesToHex(t.id))){const v=uint(t.value_usd_e8);if(v>0n)weights.set(bytesToHex(t.id),v);}
    if(!weights.size&&eligible.length)weights.set(eligible.map(t=>t.throwId).sort()[0],1n);
    for(const [id,n]of distribute(total,weights)){
      const view=throwViews.get(id)!;mergeBaseAmount(view.returnedByAssetBase,asset,n);mergeKindBaseAmount(view.payoutKindsBase,kind,asset,n);
    }
  }
  for(const [key,amount]of plan.winners){const [user,asset]=key.split(":");attribute(user,asset,amount,"WinnerShare",true);}
  if(plan.beneficiary)for(const [asset,pool]of plan.pools)attribute(plan.beneficiary,asset,pool,"Return",false);
  for(const [user,weight]of plan.winnerWeights)usersById.get(user)!.winnerWeightUsd=Number(weight)/1e8;
  for(const view of throwViews.values()){
    for(const [asset,n]of Object.entries(view.returnedByAssetBase))view.returnedUsd+=baseToUsd(input,priceLookup,asset,view.priceEpoch,BigInt(n));
    view.pnlUsd=view.returnedUsd-view.submissionValueUsd;
    for(const [kind,amounts]of Object.entries(view.payoutKindsBase))view.payoutKindsUsd[kind]=Object.entries(amounts).reduce((sum,[a,n])=>sum+baseToUsd(input,priceLookup,a,view.priceEpoch,BigInt(n)),0);
    const user=usersById.get(view.user)!;user.returnedUsd+=view.returnedUsd;
    for(const [a,n]of Object.entries(view.returnedByAssetBase))mergeBaseAmount(user.returnedByAssetBase,a,BigInt(n));
  }
  for(const user of usersById.values())user.pnlUsd=user.returnedUsd-user.stakeUsd;
  return {throwsById:throwViews,usersById,finalFrame,hasWinner:plan.hasWinner,noWinnerPolicy:parseNoWinnerPolicy(input.game.no_winner_policy)};
}

