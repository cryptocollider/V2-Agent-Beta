import type {ManagerTacticalOverlay} from "../strategy/tactical-overlay.js";
export const CLASSIC_MAP="619f8c78b24f66a0ec80c412e5065bed5329e251bfbd97d07b6ef061a9fc0911";
export const HOUR_POLICY={durationMs:3600000,cadenceMs:30000,maxNewThrows:100,throwBase:"4000000000000000000",reserveBase:"400000000000000000000",maxInferenceRounds:12,roundMs:300000,scoreBudget:5000};
export const EIGHT_HOUR_POLICY={...HOUR_POLICY,durationMs:8*3600000,maxNewThrows:800,reserveBase:"0",maxInferenceRounds:96};
export const FOUR_HOUR_POLICY={...EIGHT_HOUR_POLICY,durationMs:4*3600000,roundMs:150000};
export const ACCELERATED_POLICY={...FOUR_HOUR_POLICY,durationMs:1800000,maxNewThrows:100,roundMs:60000,maxInferenceRounds:30};
export const ACCELERATED_FOUR_HOUR_POLICY={...ACCELERATED_POLICY,durationMs:4*3600000,maxNewThrows:800,maxInferenceRounds:240};
export const RESEARCH_TWO_HOUR_POLICY={...ACCELERATED_POLICY,durationMs:2*3600000,maxNewThrows:400,maxInferenceRounds:120};
export function approvedExperimentPolicy(input:unknown){
  for(const policy of [HOUR_POLICY,EIGHT_HOUR_POLICY,FOUR_HOUR_POLICY,ACCELERATED_POLICY,ACCELERATED_FOUR_HOUR_POLICY,RESEARCH_TWO_HOUR_POLICY])if(JSON.stringify(input)===JSON.stringify(policy))return {...policy};
  throw Error("Experiment policy differs from the approved bounded comparison policies");
}
export function activityDecision(payload:unknown,remaining:number,spendableBase:string,policy=HOUR_POLICY){
  if(!payload||typeof payload!=="object"||Array.isArray(payload))throw Error("activity decision object required");
  const {throwsNextWindow,...scores}=payload as Record<string,unknown>;
  if(typeof throwsNextWindow!=="number"||!Number.isInteger(throwsNextWindow)||throwsNextWindow<0||throwsNextWindow>10)throw Error("throwsNextWindow must be an integer 0..10");
  const funded=BigInt(spendableBase)/BigInt(HOUR_POLICY.throwBase);
  const quota=Math.max(0,Math.min(throwsNextWindow,remaining,Number(funded),Math.floor(policy.roundMs/policy.cadenceMs)));
  return {requested:throwsNextWindow,quota,cadenceMs:quota?Math.max(policy.cadenceMs,Math.ceil(policy.roundMs/quota)):policy.roundMs,scores};
}
export function classicIds(games:any[]):string[]{const ids=games.filter(g=>String(g.map_id).replace(/^0x/,"").toLowerCase()===CLASSIC_MAP&&g.status===0).map(g=>String(g.game_id).replace(/^0x/,"").toLowerCase()).sort();return ids.length?ids:["0".repeat(64)];}
export function adaptiveOverlay(payload:unknown,hashes:ReadonlySet<string>,id:string,now:number,stopAt:number):ManagerTacticalOverlay{
  if(now>=stopAt)throw Error("test deadline reached; no policy update");
  if(!payload||typeof payload!=="object"||Array.isArray(payload))throw Error("one score overlay object required");
  const p=payload as Record<string,unknown>,out:any={id,updatedAt:new Date(now).toISOString(),expiresAt:new Date(Math.min(stopAt,now+360000)).toISOString(),notes:["Bounded Classic Codex policy; score bias only; fixed stake, risk and canonical physics unchanged."]};let budget=0;
  if(Object.keys(p).some(k=>!["candidateScoreDeltas","holeTypeScoreDeltas","candidateSourceScoreDeltas"].includes(k)))throw Error("only score adjustments permitted");
  for(const key of ["candidateScoreDeltas","holeTypeScoreDeltas","candidateSourceScoreDeltas"]){if(p[key]===undefined)continue;const d=p[key];if(!d||typeof d!=="object"||Array.isArray(d)||Object.keys(d).length>24)throw Error("invalid score map");out[key]={};for(const [k,v] of Object.entries(d)){const valid=key==="candidateScoreDeltas"?hashes.has(k):key==="holeTypeScoreDeltas"?/^[1-9]$/.test(k):["grid","history","copy-seed","manager","manual"].includes(k);if(!valid||typeof v!=="number"||!Number.isFinite(v))throw Error("unknown score target or invalid value");budget+=Math.abs(v);out[key][k]=v;}}
  if(budget>HOUR_POLICY.scoreBudget)throw Error("total score bias exceeds shared budget");return out;
}
