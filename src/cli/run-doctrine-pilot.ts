import {readFile,writeFile,appendFile,open} from "node:fs/promises";
import path from "node:path";
import {PUBLIC_RC1 as P,assertPublicAuth} from "../public-rc1/contract.js";
import {assertPublicSettings} from "../public-rc1/profile.js";
import {behaviorHash} from "../experiments/doctrine-baseline.js";
const root="data-doctrine-baselines-20261110a",m=JSON.parse(await readFile(path.join(root,"manifest.json"),"utf8"));
const lock=await open(path.join(root,"pilot-controller-attempt.json"),"wx");await lock.writeFile(JSON.stringify({at:new Date().toISOString(),approvedTotalThrows:44,approvedPerProfile:11}));await lock.sync();await lock.close();
const processes=JSON.parse(await readFile(path.join(root,"pilot-processes.json"),"utf8"));
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function json(url:string,body?:unknown,method=body===undefined?"GET":"POST"){const r=await fetch(url,{method,headers:{"content-type":"application/json"},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(15000)});const v=await r.json() as any;if(!r.ok)throw Error("HTTP "+r.status+" at "+new URL(url).pathname);return v;}
async function rpc(method:string,params:any[]){const v=await json(P.rpc,{jsonrpc:"2.0",id:1,method,params});if(v.error)throw Error(v.error.message);return v.result;}
async function event(row:any){await appendFile(path.join(root,"pilot-events.jsonl"),JSON.stringify({at:new Date().toISOString(),...row})+"\n");console.log(JSON.stringify(row));}
async function pending(p:any){for(const name of ["rc1-intent-state.json","rc1-points-conversion-state.json","rc1-withdrawal-state.json"]){try{const v=JSON.parse(await readFile(path.join(p.dataDir,name),"utf8"));if(v.pending)throw Error(p.id+" pending signed operation");}catch(e){if((e as any).code!=="ENOENT")throw e;}}}
async function identity(p:any){const s=await json(p.monitor+"/api/settings");assertPublicSettings(s);if(s.expectedEvmAddress.toLowerCase()!==p.address.toLowerCase()||s.monitorPort!==p.port||s.maxThrowsPerSession!==11||s.minMillisBetweenLiveThrows!==30000||s.maxThrowsPerGame!==22||s.maxGameExposureUsd!==110||s.maxSingleThrowUsd!==10||s.reserveBalanceBase!=="400000000000000000000")throw Error("profile identity or approved caps changed");const proc=processes.find((x:any)=>x.id===p.id);process.kill(proc.pid,0);return s;}
let started=false;
try{
  const waiting=Date.now();let previous="";
  for(;;){const stages=[];for(const p of m.profiles){process.kill(processes.find((x:any)=>x.id===p.id).pid,0);const f=JSON.parse(await readFile(path.join(p.dataDir,"public-testnet-funding-state.json"),"utf8"));stages.push({id:p.id,stage:f.stage});}const key=JSON.stringify(stages);if(key!==previous){await event({event:"funding-progress",stages});previous=key;}if(stages.every(s=>s.stage==="COMPLETE"))break;if(Date.now()-waiting>900000)throw Error("funding remained pending; do not replay original work");await sleep(5000);}
  const hashes=[];
  for(const p of m.profiles){await identity(p);await pending(p);const c=await json(p.monitor+"/api/control/status");if(c.state!=="paused")throw Error("baseline must begin paused");const h=await json(p.monitor+"/api/history/summary");if(h.throws.accepted!==0)throw Error("baseline has prior throws; no replay");const auth=await rpc("colliderV2.getAuthContext",["0x"+p.user]);assertPublicAuth(auth,"0x"+p.user);if(auth.user?.accepted_next_nonce!==0)throw Error("new wallet native nonce is not zero");
    const balance=await rpc("colliderV2.getBalances",["0x"+p.user]);if(BigInt(balance[P.clc]??balance[P.clc.slice(2)]??"0")!==4000n*10n**18n)throw Error("initial native bankroll differs");
    const s=await identity(p),saved=await json(p.monitor+"/api/settings",{testnetAutoFunding:{...s.testnetAutoFunding,enabled:false}});if(saved.runtimeSyncPending||saved.runtimeSyncError||saved.settings.testnetAutoFunding.enabled||saved.runtime?.testnetAutoFunding?.enabled)throw Error("funding-off runtime synchronization failed");hashes.push(behaviorHash(saved.settings));
    const seed=JSON.parse(await readFile(path.join(root,p.id+"-policy-seed.json"),"utf8"));if(seed.status!=="validated-score-overlay")throw Error("manager seed not verified");seed.overlay.notes.push("Codex objective prior: "+seed.reply);const applied=await json(p.monitor+"/api/manager/overlay",seed.overlay);if(!applied.ok)throw Error("bounded overlay application failed");
    const llm=(await json(p.monitor+"/api/manager/llm")).state;if(llm.config.activeProvider!=="codex"||llm.config.autoApply)throw Error("manager provider or autoApply changed");
  }
  if(new Set(hashes).size!==1)throw Error("common behavior differs across funded profiles");await event({event:"preflight-passed",commonBehaviorHash:hashes[0],profiles:4,acceptedBaseline:0});
  started=true;await Promise.all(m.profiles.map((p:any)=>json(p.monitor+"/api/control/action",{action:"start"})));await event({event:"pilot-start",maximumAcceptedEach:11,maximumAcceptedTotal:44});
  const playStart=Date.now(),done=new Set<string>();let last="";
  while(done.size<4){const rows=[];for(const p of m.profiles){await identity(p);const h=await json(p.monitor+"/api/history/summary"),c=await json(p.monitor+"/api/control/status");if(h.throws.accepted>11)throw Error("accepted bound exceeded");if(h.throws.accepted>=11&&!done.has(p.id)){await json(p.monitor+"/api/control/action",{action:"stop"});done.add(p.id);await event({event:"profile-cap-pause",id:p.id,accepted:h.throws.accepted,latestNonce:h.throws.latestNonce});}else if(c.state==="paused"&&!done.has(p.id)){done.add(p.id);await event({event:"profile-early-pause",id:p.id,accepted:h.throws.accepted,reason:c.lastMessage});}rows.push({id:p.id,accepted:h.throws.accepted,scored:h.results.scored,state:c.state});}const key=JSON.stringify(rows);if(key!==last){await event({event:"progress",profiles:rows});last=key;}if(Date.now()-playStart>1200000)throw Error("pilot timed out; leaving profiles paused");await sleep(5000);}
  await event({event:"pilot-finished-all-paused"});
}catch(e){await event({event:"pilot-blocked",error:String((e as Error).message)});process.exitCode=1;}
finally{if(started){for(const p of m.profiles){try{await identity(p);await json(p.monitor+"/api/control/action",{action:"stop"});}catch{/* Never send controls to an unverified replacement instance. */}}}}
