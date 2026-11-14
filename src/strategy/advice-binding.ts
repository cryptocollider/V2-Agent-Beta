import {hashCandidate,normalizeManagerCandidateSet,type ManagerTacticalOverlay} from './tactical-overlay.js';
// Bind only supplied, fixed-stake controls; live planning still applies policy filters and re-simulates current canonical input.
export function bindCandidateAdvice(overlay:ManagerTacticalOverlay,candidates:any[],asset?:string,amount?:string){
 const specs:any[]=[],deltas:Record<string,number>={};
 for(const [key,delta] of Object.entries(overlay.candidateScoreDeltas??{})){
  const c=candidates.find(c=>c.candidateHash===key);if(!c||typeof c.asset!=='string'||!c.asset||typeof c.amount!=='string'||!/^\d+$/.test(c.amount)||(asset!==undefined&&String(c.asset).replace(/^0x/,'')!==asset.replace(/^0x/,''))||(amount!==undefined&&c.amount!==amount)||!['x','y','angleDeg','speedPct','spinPct'].every(k=>typeof c[k]==='number'&&Number.isFinite(c[k])))throw Error('Manager candidate is not an approved current-stake control');
  if(!delta)continue;const spec={id:key,label:'Manager control '+key,...Object.fromEntries(['x','y','angleDeg','speedPct','spinPct'].map(k=>[k,c[k]])),asset:asset??c.asset,amount:amount??c.amount,enabled:true,notes:['Bound from supplied snapshot; fresh simulation required']};specs.push(spec);
  const rebound=hashCandidate({...spec,source:'manager'} as any);deltas[rebound]=(deltas[rebound]??0)+delta;
 }
 return {...overlay,candidateScoreDeltas:deltas,candidateSet:normalizeManagerCandidateSet({id:overlay.id,updatedAt:overlay.updatedAt,expiresAt:overlay.expiresAt,candidates:specs})};
}
