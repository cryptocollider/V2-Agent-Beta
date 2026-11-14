// Cycle-local metadata on the existing numeric display hints. It never survives
// JSON/cache reconstruction, so stale approximate hints cannot become exact prices.
export type ExactPriceBasis = { priceE8: string; decimals: number; epoch: number };
const bases = new WeakMap<object, Record<string, ExactPriceBasis>>();
const clean = (asset:string) => asset.replace(/^0x/i, "").toLowerCase();

export function attachExactPriceBases(hints: Record<string,number>, prices: Record<string,ExactPriceBasis>): Record<string,number> {
  const valid:Record<string,ExactPriceBasis>={};
  for(const [asset,p] of Object.entries(prices)) if (/^\d+$/.test(p.priceE8) && BigInt(p.priceE8)>0n
    && Number.isInteger(p.decimals) && p.decimals>=0 && p.decimals<=30 && Number.isSafeInteger(p.epoch) && p.epoch>=0
    && hints[clean(asset)]>0) valid[clean(asset)]={...p};
  bases.set(hints,valid);return hints;
}
export function exactPriceBasis(hints: object | undefined, asset:string): ExactPriceBasis | null {
  return hints ? bases.get(hints)?.[clean(asset)] ?? null : null;
}
export function canonicalValueE8(amount:string, hints: object | undefined, asset:string): bigint | null {
  const p=exactPriceBasis(hints,asset);
  return p && /^\d+$/.test(amount) ? BigInt(amount)*BigInt(p.priceE8)/(10n**BigInt(p.decimals)) : null;
}
export function usdCeilE8(usd:number): bigint {
  const m=/^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(String(usd));
  if(!m)throw Error("invalid positive USD target");
  const fraction=m[2]??"", n=BigInt(m[1]+fraction), shift=8+Number(m[3]??0)-fraction.length;
  if(shift>=0)return n*10n**BigInt(shift);
  const denominator=10n**BigInt(-shift);return (n+denominator-1n)/denominator;
}
export function minimumAmountForUsd(usd:number,hints:object|undefined,asset:string): string | null {
  const p=exactPriceBasis(hints,asset);if(!p)return null;
  const numerator=usdCeilE8(usd)*10n**BigInt(p.decimals),price=BigInt(p.priceE8);
  return ((numerator+price-1n)/price).toString();
}
