import type { CandidatePlanRun } from "../sim/planner.js";
import { buildPriceLookupFromSimInput, buildScenarioSettlementView } from "./prediction-settlement.js";

export type PredictionSummary = {
  scenarioCount:number; winnerScenarioCount:number; pnlUsd:number|null; bestPnlUsd:number|null; worstPnlUsd:number|null;
  holeType:number|null;holeTypeCounts:Record<string,number>;valueUsd:number|null;valueUsdE8:string|null;massUsd:number|null;winnerValuePct:number|null;
};
export function summarizePredictionFromPlan(plan:CandidatePlanRun,botUser:string,holeRules?:unknown):PredictionSummary|null {
  const user=botUser.toLowerCase().replace(/^0x/,"");
  const samples=plan.perScenario.map(run=>{
    const settlement=buildScenarioSettlementView({input:run.syntheticInput,outcomes:run.decoded.per_throw,priceLookup:buildPriceLookupFromSimInput(run.syntheticInput),holeRules});
    const candidate=settlement.throwsById.get(run.syntheticThrowId.toLowerCase().replace(/^0x/,""));
    if(!candidate)return null;
    const source=run.syntheticInput.throws.find(t=>(Array.isArray(t.id)?t.id.map(n=>Number(n).toString(16).padStart(2,"0")).join(""):String(t.id).replace(/^0x/,""))===candidate.throwId);
    return {weight:Number(run.scenario.weight??1),pnl:settlement.usersById.get(user)?.pnlUsd??0,candidate,valueUsdE8:String(source?.value_usd_e8??"0")};
  }).filter((s):s is NonNullable<typeof s>=>s!==null);
  if(!samples.length)return null;
  const total=samples.reduce((n,s)=>n+s.weight,0);
  const avg=(pick:(s:typeof samples[number])=>number)=>total>0?samples.reduce((n,s)=>n+pick(s)*s.weight,0)/total:null;
  const counts:Record<string,number>={},modes=new Map<number,number>();
  for(const s of samples)if(s.candidate.holeType!=null){const h=s.candidate.holeType;counts[h]=(counts[h]??0)+1;modes.set(h,(modes.get(h)??0)+s.weight);}
  const mode=[...modes].sort((a,b)=>b[1]-a[1])[0]?.[0]??null;
  return {scenarioCount:samples.length,winnerScenarioCount:samples.filter(s=>s.candidate.holeType===3).length,
    pnlUsd:avg(s=>s.pnl),bestPnlUsd:Math.max(...samples.map(s=>s.pnl)),worstPnlUsd:Math.min(...samples.map(s=>s.pnl)),
    holeType:mode,holeTypeCounts:counts,valueUsd:avg(s=>s.candidate.submissionValueUsd),valueUsdE8:samples[0].valueUsdE8,
    massUsd:avg(s=>s.candidate.massUsd),winnerValuePct:avg(s=>s.candidate.holeType===3?100:0)};
}
