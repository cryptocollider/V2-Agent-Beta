import fs from 'node:fs/promises';
import {cohortMetrics} from '../dist/experiments/classic-hour-metrics.js';
const exportedFiles=new Map();
async function exportText(file,text){if(exportedFiles.get(file)===text)return;await fs.writeFile(file,text);exportedFiles.set(file,text);}
async function snapshot(){
const root=process.argv.includes('--plan-root')?process.argv[process.argv.indexOf('--plan-root')+1]:'data-doctrine-classic-hour-20261111a';
const plan=JSON.parse(await fs.readFile(root+'/plan.json','utf8'));
const events=(await fs.readFile(root+'/events.jsonl','utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
const metric=id=>events.filter(e=>e.type==='minute'&&e.id===id).at(-1);
const decision=id=>events.filter(e=>e.type==='activity-decision'&&e.id===id).at(-1);
const attached=events.filter(e=>e.type==='controller-attached').at(-1)?.ts??'';
const terminal=events.filter(e=>e.ts>=attached&&e.type==='all-paused').at(-1)??events.filter(e=>e.ts>=attached&&e.type==='controller-finished').at(-1);
const latestFault=events.filter(e=>e.ts>=attached&&(e.type==='safety-fault'||e.type==='inference-failed'||e.type==='stop-needs-review')&&!(e.error==='test deadline reached; no policy update'&&Date.parse(e.ts)>=Date.parse(plan.stopAt))).at(-1);
const out={at:new Date().toISOString(),elapsedMinutes:Math.max(0,(Date.now()-Date.parse(plan.startAt))/60000),remainingMinutes:Math.max(0,(Date.parse(plan.stopAt)-Date.now())/60000),lastEventAt:events.at(-1)?.ts,terminal,latestFault,profiles:plan.profiles.map(p=>{const m=metric(p.id),a=decision(p.id);return {id:p.id,sampledAt:m?.ts,accepted:m?.cohort.accepted,settled:m?.cohort.settled,hps:m?.cohort.meanHps,points:m?.cohort.attributedThrowPoints,netSettledClc:m?.cohort.settledNetClcBase===null?null:Number(m?.cohort.settledNetClcBase??0)/1e18,uniqueControls:m?.cohort.uniqueControls,selectionChanges:m?.cohort.verifiedSelectionChanges,round:a?.round,requested:a?.requested,quota:a?.quota};})};
const fresh=[];for(const p of plan.profiles){const ts=(await fs.readFile(p.dataDir+'/throws.jsonl','utf8')).split('\n').filter(Boolean).map(JSON.parse),rs=(await fs.readFile(p.dataDir+'/results.jsonl','utf8')).split('\n').filter(Boolean).map(JSON.parse);fresh.push({id:p.id,metrics:cohortMetrics(ts.filter(t=>!plan.oldCohortGames.includes(t.gameId)),rs,p.startNonce)});const m=cohortMetrics(ts,rs,p.startNonce),row=out.profiles.find(x=>x.id===p.id);Object.assign(row,{sampledAt:out.at,accepted:m.accepted,settled:m.settled,hps:m.meanHps,points:m.attributedThrowPoints,netSettledClc:m.settledNetClcBase===null?null:Number(m.settledNetClcBase)/1e18,uniqueControls:m.uniqueControls,selectionChanges:m.verifiedSelectionChanges});}
await fs.writeFile(root+'/fresh-live.json',JSON.stringify({at:out.at,profiles:fresh},null,2)+'\n');
await fs.writeFile(root+'/live.json',JSON.stringify(out,null,2)+'\n');
const publicRoot=root.replace(/^data-/,'public-');await fs.mkdir(publicRoot+'/rounds',{recursive:true});
const publicPlan={schema:plan.schema,startAt:plan.startAt,stopAt:plan.stopAt,model:plan.model,policy:plan.policy,profiles:plan.profiles.map(({id,label,vanityLabel,monitor,primaryGoal})=>({id,label,vanityLabel,monitor,primaryGoal}))};
await exportText(publicRoot+'/plan.json',JSON.stringify(publicPlan));
const publicEvents=events.map(e=>Object.fromEntries(['ts','type','id','round','requested','quota','reason','status','model','startAt','stopAt','actualStart','cohort'].filter(k=>e[k]!==undefined).map(k=>[k,e[k]])));
await exportText(publicRoot+'/events.jsonl',publicEvents.map(e=>JSON.stringify(e)).join('\n')+'\n');
await exportText(publicRoot+'/live.json',JSON.stringify(out));await exportText(publicRoot+'/fresh-live.json',JSON.stringify({at:out.at,profiles:fresh}));
for(const p of plan.profiles){const r=events.filter(e=>e.type==='inference'&&e.id===p.id).at(-1);if(!r)continue;const name=String(r.round).padStart(2,'0')+'-'+p.id+'.json',dest=publicRoot+'/rounds/'+name;if(exportedFiles.has(dest))continue;const original=JSON.parse(await fs.readFile(root+'/rounds/'+name,'utf8'));await exportText(dest,JSON.stringify({reply:original.reply,status:original.status,completedAt:original.completedAt,usage:original.usage,activity:original.activity}));}
for(const file of ['audit.json','audit.txt']){try{await exportText(publicRoot+'/'+file,await fs.readFile(root+'/'+file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}}
console.log(JSON.stringify({...out,fresh:fresh.map(p=>({id:p.id,accepted:p.metrics.accepted,settled:p.metrics.settled,points:p.metrics.attributedThrowPoints,netClc:p.metrics.settledNetClcBase===null?null:Number(p.metrics.settledNetClcBase)/1e18,hps:p.metrics.meanHps}))}));
}
if(process.argv.includes('--watch')){const i=process.argv.indexOf('--until'),until=Date.parse(process.argv[i+1]);if(i<0||!Number.isFinite(until)||until<=Date.now())throw Error('future --until required');while(Date.now()<until){try{await snapshot();}catch(e){console.error('Read-only checkpoint failed:',e.message);}await new Promise(r=>setTimeout(r,15000));}}
else await snapshot();
