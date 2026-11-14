import {createHash} from "node:crypto";
import {canonicalJsonStringify} from "../core/content-address.js";
import type {AgentSettings} from "../core/settings.js";
import type {DoctrinePackId,GoalWeights} from "../core/agent-profile.js";
import type {ManagerTacticalOverlay} from "../strategy/tactical-overlay.js";
export const BASELINES:ReadonlyArray<{id:string;label:string;doctrine:DoctrinePackId;primaryGoal:keyof GoalWeights;port:number}>=[
  {id:"profit",label:"ToughNut — profit",doctrine:"tough_nut",primaryGoal:"profitMaxing",port:8801},
  {id:"points",label:"Peanut — points",doctrine:"peanut",primaryGoal:"ladderMaxing",port:8802},
  {id:"discovery",label:"NutJob — discovery",doctrine:"nutjob",primaryGoal:"discoveryMapping",port:8803},
  {id:"calibration",label:"Prof DeezNutz — calibration",doctrine:"prof_deez_nutz",primaryGoal:"selfAwarenessMaxing",port:8804},
];
export function primaryGoalWeights(goal:keyof GoalWeights):GoalWeights{return {profitMaxing:goal==="profitMaxing"?.7:.1,ladderMaxing:goal==="ladderMaxing"?.7:.1,selfAwarenessMaxing:goal==="selfAwarenessMaxing"?.7:.1,discoveryMapping:goal==="discoveryMapping"?.7:.1};}
export function commonBehavior(settings:AgentSettings){
  const s=JSON.parse(JSON.stringify(settings));for(const k of ["user","expectedEvmAddress","signingKeyFile","signingKeyEnv","monitorPort","doctrinePack","goalWeights","onboarding"])delete s[k];
  if(s.publicRc1){delete s.publicRc1.ownerWallet;delete s.publicRc1.ownerSourceDir;}
  return s;
}
export function behaviorHash(settings:AgentSettings){return createHash("sha256").update(canonicalJsonStringify(commonBehavior(settings))).digest("hex");}
export function reconciledWalletNonces(accepted:number[],confirmedRejected:number[],next:number):boolean{
  const all=[...accepted,...confirmedRejected].sort((a,b)=>a-b);
  return Number.isSafeInteger(next)&&next>=0&&all.length===next&&all.every((nonce,index)=>nonce===index);
}
export function validatedSeedOverlay(payload:unknown,hashes:ReadonlySet<string>,id:string):ManagerTacticalOverlay{
  if(!payload||typeof payload!=="object"||Array.isArray(payload))throw Error("baseline requires one overlay object");const p=payload as Record<string,unknown>;
  if(Object.keys(p).some(k=>!["candidateScoreDeltas","holeTypeScoreDeltas","candidateSourceScoreDeltas"].includes(k)))throw Error("baseline cannot change settings, money, predicted payouts, controls or execution");
  let budget=0;const out:any={id,updatedAt:new Date().toISOString(),notes:["Minimal inference baseline seed; score bias only; native simulation/commitments and risk limits unchanged."]};
  for(const kind of ["candidateScoreDeltas","holeTypeScoreDeltas","candidateSourceScoreDeltas"]){if(p[kind]===undefined)continue;const d=p[kind];if(!d||typeof d!=="object"||Array.isArray(d)||Object.keys(d).length>10)throw Error("invalid bounded score map");out[kind]={};for(const [key,value]of Object.entries(d)){const known=kind==="candidateScoreDeltas"?hashes.has(key):kind==="candidateSourceScoreDeltas"?["grid","history","copy-seed","manager","manual"].includes(key):/^[1-5]$/.test(key);if(!known)throw Error("unknown candidate, hole type or candidate source");if(typeof value!=="number"||!Number.isFinite(value)||Math.abs(value)>100)throw Error("score nudge exceeds bound");budget+=Math.abs(value);out[kind][key]=value;}}
  if(!(budget>0&&budget<=100))throw Error("baseline requires a nonzero total absolute score budget at most100");return out;
}
