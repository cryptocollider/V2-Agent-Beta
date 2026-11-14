import {readFile,writeFile,mkdir} from "node:fs/promises";import path from "node:path";
import {PUBLIC_RC1 as P,assertPublicAuth} from "../public-rc1/contract.js";
import {HOUR_POLICY,CLASSIC_MAP,classicIds} from "../experiments/classic-hour.js";
const root="data-doctrine-classic-hour-20261111a";await mkdir(root,{recursive:true});
const old=JSON.parse(await readFile("data-doctrine-baselines-20261110a/manifest.json","utf8")),pids=JSON.parse(await readFile("data-doctrine-baselines-20261110a/pilot-processes.json","utf8"));
async function get(url:string,body?:any){const r=await fetch(url,{method:body?"POST":"GET",headers:{"content-type":"application/json"},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)});const v=await r.json() as any;if(!r.ok||v.error)throw Error("preflight read failed");return body?v.result:v;}
const games=await get(P.rpc,{jsonrpc:"2.0",id:1,method:"colliderV2.listGames",params:[]});if(classicIds(games)[0]==="0".repeat(64))throw Error("no live Classic supply");
const profiles=[],oldGames=new Set<string>();
for(const p of old.profiles){const settings=await get(p.monitor+"/api/settings"),control=await get(p.monitor+"/api/control/status"),h=await get(p.monitor+"/api/history/summary");if(control.state!=="paused")throw Error("existing player must be paused");
  for(const file of ["rc1-intent-state.json","rc1-points-conversion-state.json","rc1-withdrawal-state.json"]){try{const v=JSON.parse(await readFile(path.join(p.dataDir,file),"utf8"));if(v.pending)throw Error("pending signed operation");}catch(e){if((e as any).code!=="ENOENT")throw e;}}
  const auth=await get(P.rpc,{jsonrpc:"2.0",id:1,method:"colliderV2.getAuthContext",params:["0x"+p.user]});assertPublicAuth(auth,"0x"+p.user);const expected=p.id==="profit"?12:11;if(auth.user.accepted_next_nonce!==expected||auth.user.next_available_nonce!==expected||h.throws.accepted!==11)throw Error("pilot nonce/history changed; reconcile before new test");
  const balances=await get(P.rpc,{jsonrpc:"2.0",id:1,method:"colliderV2.getBalances",params:["0x"+p.user]}),balance=balances[P.clc]??balances[P.clc.slice(2)]??"0";if(BigInt(balance)<BigInt(HOUR_POLICY.reserveBase)+BigInt(HOUR_POLICY.throwBase))throw Error("insufficient usable bankroll for a minimum throw above reserve");
  const ladder=await get(P.rpc,{jsonrpc:"2.0",id:1,method:"colliderV2.getLadderUser",params:["0x"+p.user]});
  const rows=(await readFile(path.join(p.dataDir,"throws.jsonl"),"utf8")).trim().split("\n").map(l=>JSON.parse(l));for(const t of rows.filter(t=>t.submitted))oldGames.add(t.gameId);
  await writeFile(path.join(root,p.id+"-before-settings.json"),JSON.stringify(settings,null,2)+"\n",{flag:"wx"});
  profiles.push({...p,oldPid:pids.find((v:any)=>v.id===p.id).pid,baselineAccepted:11,startNonce:expected,baselineClc:balance,baselinePoints:ladder?.points_total??"0"});
}
const plan={schema:"agent1.classic-hour.v1",createdAt:new Date().toISOString(),root,chain:P.chain,classicMap:CLASSIC_MAP,policy:HOUR_POLICY,model:"gpt-6.1-sol",effort:"low",profiles,oldCohortGames:[...oldGames],initialClassicIds:classicIds(games),status:"prepared",funding:false,tournaments:false,inferenceMaximum:48,notes:["Existing balances differ; incremental fixed stake and gross risk budget are equal (120 CLC each).","First Classic game contains older throws; label it as mixed-cohort warmup in comparisons."]};
await writeFile(path.join(root,"plan.json"),JSON.stringify(plan,null,2)+"\n",{flag:"wx"});console.log(JSON.stringify({root,profiles:profiles.map(p=>({id:p.id,oldPid:p.oldPid,balance:p.baselineClc,startNonce:p.startNonce})),maxNewThrowsEach:30,model:plan.model,claims:0}));
