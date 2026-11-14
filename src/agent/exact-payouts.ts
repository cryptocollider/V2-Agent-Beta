import type { SimRunInput, ThrowRecord } from "../collider/types.js";

// Port of timestampvm/src/payouts.rs: only integer base units and canonical USD-e8 weights.
export const PPM = 1_000_000n;
const MAX = (1n << 128n) - 1n;
export type Shares = { return_ppm: number; prize_ppm: number; losers_ppm: number; collider_fee_ppm: number; creator_fee_ppm: number };
export const DEFAULT_SHARES: Record<number, Shares> = Object.fromEntries([
  [1, 1000000, 0, 0, 0, 0], [2, 0, 0, 990000, 10000, 0], [3, 1000000, 0, 0, 0, 0],
  [4, 500000, 0, 495000, 5000, 0], [5, 990000, 0, 0, 5000, 5000],
  [6, 990000, 10000, 0, 0, 0], [7, 980000, 20000, 0, 0, 0],
  [8, 950000, 50000, 0, 0, 0], [9, 900000, 100000, 0, 0, 0],
].map(([id, r, p, l, f, c]) => [id, { return_ppm:r, prize_ppm:p, losers_ppm:l, collider_fee_ppm:f, creator_fee_ppm:c }]));
export function hex(value: unknown): string {
  return Array.isArray(value) ? value.map(n => Number(n).toString(16).padStart(2,"0")).join("") : String(value ?? "").toLowerCase().replace(/^0x/,"");
}
export function uint(value: unknown): bigint {
  if (typeof value === "number" && !Number.isSafeInteger(value)) throw Error("unsafe integer payout input");
  const s=String(value); if(!/^\d+$/.test(s))throw Error("invalid integer payout input");
  const n=BigInt(s); if(n>MAX)throw Error("u128 payout overflow");return n;
}
function add(map: Map<string,bigint>, key:string, amount:bigint) {
  const sum=(map.get(key)??0n)+amount;if(sum>MAX||sum<0n)throw Error("u128 payout overflow");if(sum)map.set(key,sum);
}
export function validateShares(value: unknown): Shares {
  const v=value as Shares;const amounts=[v?.return_ppm,v?.prize_ppm,v?.losers_ppm,v?.collider_fee_ppm,v?.creator_fee_ppm];
  if(amounts.some(x=>!Number.isSafeInteger(x)||x<0||x>1000000)||amounts.reduce((a,b)=>a+b,0)!==1000000
    ||v.creator_fee_ppm>v.collider_fee_ppm||v.return_ppm+v.losers_ppm+v.prize_ppm===0)throw Error("invalid canonical payout ppm rule");return v;
}
export function payoutRules(input: SimRunInput, canonical?: unknown): Map<number,Shares> {
  const map=new Map<number,Shares>();
  if(canonical!==undefined){
    if(!canonical||typeof canonical!=="object"||Array.isArray(canonical))throw Error("canonical payout rules unavailable");
    for(const [id,r]of Object.entries(canonical))map.set(Number(id),validateShares((r as any).CompositeFull??r));
  }else{
    for(const [id,r]of Object.entries(DEFAULT_SHARES))map.set(Number(id),r);
    for(const r of (input.map as any)?.tournament?.payout_rules??[])map.set(Number(r.id),validateShares(r.rule?.CompositeFull??r.CompositeFull));
  }
  return map;
}
export function splitAmount(amount: bigint, shares: Shares): {returned:bigint;prize:bigint;losers:bigint;fee:bigint;creator:bigint} {
  validateShares(shares);uint(amount);
  const returned=amount*BigInt(shares.return_ppm)/PPM,prize=amount*BigInt(shares.prize_ppm)/PPM,
    losers=amount*BigInt(shares.losers_ppm)/PPM,fee=amount*BigInt(shares.collider_fee_ppm)/PPM,creator=amount*BigInt(shares.creator_fee_ppm)/PPM;
  const out={returned,prize,losers,fee,creator},residual=amount-returned-prize-losers-fee-creator;
  const targets=([['returned',shares.return_ppm,3],['losers',shares.losers_ppm,2],['prize',shares.prize_ppm,1]] as const)
    .filter(x=>x[1]>0).sort((a,b)=>b[1]-a[1]||b[2]-a[2]);
  out[targets[0][0]]+=residual;return out;
}
export function distribute(pool:bigint, weights:Map<string,bigint>): Map<string,bigint> {
  uint(pool);const out=new Map<string,bigint>();if(!pool||!weights.size)return out;
  const total=[...weights.values()].reduce((a,b)=>{if(b<=0n)throw Error("zero payout weight");const n=a+b;uint(n);return n;},0n);
  const remainders:Array<[string,bigint]>=[];let floors=0n;
  for(const [key,weight]of weights){const p=pool*weight,floor=p/total;add(out,key,floor);floors+=floor;remainders.push([key,p%total]);}
  remainders.sort((a,b)=>a[1]===b[1]?(a[0]<b[0]?-1:a[0]>b[0]?1:0):a[1]>b[1]?-1:1);
  const residual=pool-floors;if(residual>BigInt(remainders.length))throw Error("payout residual invariant");
  for(let i=0;i<Number(residual);i++)add(out,remainders[i][0],1n);return out;
}
export type ExactPlan = {returns:Map<string,bigint>;winners:Map<string,bigint>;prizes:Map<string,bigint>;fees:Map<string,bigint>;creatorFees:Map<string,bigint>;
  directByThrow:Map<string,bigint>;pools:Map<string,bigint>;beneficiary:string|null;hasWinner:boolean;winnerWeights:Map<string,bigint>};
export function computePayouts(input:SimRunInput,outcomes:Array<{throw_id:unknown;hole_type:number}>,canonicalRules?:unknown):ExactPlan {
  const rules=payoutRules(input,canonicalRules),byId=new Map<string,ThrowRecord>();
  for(const t of input.throws){const id=hex(t.id);if(byId.has(id))throw Error("duplicate payout throw id");uint(t.amount);uint(t.value_usd_e8);byId.set(id,t);}
  if(outcomes.length!==byId.size)throw Error("payout outcome count mismatch");
  const plan:ExactPlan={returns:new Map(),winners:new Map(),prizes:new Map(),fees:new Map(),creatorFees:new Map(),directByThrow:new Map(),pools:new Map(),beneficiary:null,hasWinner:false,winnerWeights:new Map()};
  const seen=new Set<string>(),lossWeights=new Map<string,bigint>(),valueWeights=new Map<string,bigint>(),singleWeights=new Map<string,bigint>();
  for(const t of input.throws){const user=hex(t.user),value=uint(t.value_usd_e8);valueWeights.set(user,(valueWeights.get(user)??0n)+value);singleWeights.set(user,value>(singleWeights.get(user)??0n)?value:singleWeights.get(user)??0n);}
  for(const o of outcomes){const id=hex(o.throw_id),t=byId.get(id);if(!t||seen.has(id))throw Error("unknown or duplicate payout outcome");seen.add(id);
    const rule=rules.get(Number(o.hole_type));if(!rule)throw Error("missing canonical hole payout rule");
    const s=splitAmount(uint(t.amount),rule),user=hex(t.user),asset=hex(t.asset);
    add(plan.returns,user+':'+asset,s.returned);plan.directByThrow.set(id,s.returned);add(plan.prizes,asset,s.prize);add(plan.fees,asset,s.fee);add(plan.creatorFees,asset,s.creator);add(plan.pools,asset,s.losers);
    // Keep the common PPM numerator intact, including sub-USD-e8 losses.
    lossWeights.set(user,(lossWeights.get(user)??0n)+uint(t.value_usd_e8)*BigInt(1000000-rule.return_ppm));
    if(Number(o.hole_type)===3){const v=uint(t.value_usd_e8);if(!v)throw Error("zero canonical winner value");add(plan.winnerWeights,user,v);plan.hasWinner=true;}
  }
  if(plan.hasWinner){for(const [asset,pool]of plan.pools)for(const [user,n]of distribute(pool,plan.winnerWeights))add(plan.winners,user+':'+asset,n);}
  else{
    const raw=input.game.no_winner_policy,policy=typeof raw==='string'?raw:Object.keys(raw??{})[0];
    if(policy==='Refund'){
      for(const m of [plan.returns,plan.prizes,plan.fees,plan.creatorFees,plan.pools])m.clear();
      for(const t of input.throws){add(plan.returns,hex(t.user)+':'+hex(t.asset),uint(t.amount));plan.directByThrow.set(hex(t.id),uint(t.amount));}
    }else{
      const weights=policy==='BiggestLoser'?lossWeights:policy==='MostPlayed'?valueWeights:policy==='BiggestBalls'?singleWeights:null;
      if(!weights)throw Error("unknown no-winner payout policy");
      if(policy==='MostPlayed')for(const n of weights.values())uint(n);
      if(policy==='BiggestLoser')for(const n of weights.values())uint(n/PPM);
      const winner=[...weights].sort((a,b)=>a[1]===b[1]?(a[0]<b[0]?-1:a[0]>b[0]?1:0):a[1]>b[1]?-1:1)[0]?.[0]??null;
      plan.beneficiary=winner;if(winner)for(const [asset,pool]of plan.pools)add(plan.returns,winner+':'+asset,pool);
    }
  }
  const bank=new Map<string,bigint>();for(const t of input.throws)add(bank,hex(t.asset),uint(t.amount));
  for(const [asset,amount]of bank){let paid=(plan.prizes.get(asset)??0n)+(plan.fees.get(asset)??0n)+(plan.creatorFees.get(asset)??0n);
    for(const m of [plan.returns,plan.winners])for(const [key,n]of m)if(key.endsWith(':'+asset))paid+=n;
    if(paid!==amount)throw Error("payout conservation invariant");}
  return plan;
}
