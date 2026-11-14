// Prompt-only compression. Durable evidence and executable controls retain full precision.
export function compactResearchPrompt(packet:any){
 const p=structuredClone(packet),r=p.research;
 if(r){
  // Seed controls are supplied once in approvedControls, not once per historical hypothesis.
  if(r.feedback)r.feedback.experiments=(r.feedback.experiments??[]).slice(-4).map(({approvedControls,...e}:any)=>e);
  r.measuredSearch=(r.measuredSearch??[]).slice(-6).map((x:any)=>({at:x.at,policyId:x.policyId,search:Object.fromEntries(['elapsedMs','simulatedScenarios','plannedCandidates','maxCandidates'].map(k=>[k,x.search?.[k]]))}));
  if(r.feedback)r.feedback.cases=(r.feedback.cases??[]).slice(-6).map(({proposedControls,...c}:any)=>c);
 }
 if(p.own?.currentOverlay){const o=p.own.currentOverlay;p.own.currentOverlay={id:o.id,candidateScoreDeltas:o.candidateScoreDeltas,holeTypeScoreDeltas:o.holeTypeScoreDeltas,candidateSourceScoreDeltas:o.candidateSourceScoreDeltas};}
 const rounded=JSON.parse(JSON.stringify(p,(_k,v)=>typeof v==='number'&&Number.isFinite(v)&&!Number.isInteger(v)?Number(v.toPrecision(7)):v));
 if(Buffer.byteLength(JSON.stringify(rounded))>32000){
  if(rounded.research?.feedback)rounded.research.feedback.cases=rounded.research.feedback.cases.slice(-3);
  if(rounded.research?.approvedControls)rounded.research.approvedControls=rounded.research.approvedControls.slice(0,12);
 }
 if(Buffer.byteLength(JSON.stringify(rounded))>36000)throw Error('Research public context exceeds compact budget');
 return rounded;
}
