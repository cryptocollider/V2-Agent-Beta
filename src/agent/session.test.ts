import assert from "node:assert/strict";
import test from "node:test";

import { sessionCapExitAction } from "./session.js";
import {runAgentSession,loadPredictionHistoryForGame} from "./session.js";
import {initStorage,appendThrowLog,writeArtifactJson} from "../core/storage.js";
import {readPendingDecisions} from "../core/pending-decisions.js";
import {initRuntimeSettings,updateControlState,getControlState} from "../core/runtime-state.js";
import {normalizeSettings} from "../core/settings.js";
import {mkdtemp,rm,readFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

test("bounded session drains accepted results before exiting at its throw cap", () => {
  assert.equal(sessionCapExitAction(false, true, 0), "normal");
  assert.equal(sessionCapExitAction(true, false, 0), "normal");
  assert.equal(sessionCapExitAction(true, true, 1), "drain");
  assert.equal(sessionCapExitAction(true, true, 0), "exit");
});

async function pausedFixture(t:any,count=1){
  const dir=await mkdtemp(path.join(tmpdir(),"paused-results-"));t.after(()=>rm(dir,{recursive:true,force:true}));const storage=await initStorage(dir),user="aa".repeat(32),gameId="bb".repeat(32),asset="cc".repeat(32);
  const payload={asset,amount:"100",init_pose:{pos:{x:1,y:2},angle_rad:0},init_linvel:{x:3,y:4},init_angvel:0};
  const raw:any[]=[],outcomes:any[]=[];
  for(let n=0;n<count;n++){const id=(n+1).toString(16).padStart(64,"0");await appendThrowLog(storage,{ts:"2026-11-09T00:00:00Z",sessionId:"fixture",decisionId:"decision"+n,gameId,botUser:user,submitted:true,dryRun:false,payload,signedIntent:{throwId:id} as any});raw.push({...payload,id,user});outcomes.push({throw_id:id,hole_type:1,endFrame:20});}
  initRuntimeSettings(normalizeSettings({user,asset,amount:"100",pollMs:1}));updateControlState({state:"paused"});
  let reads=0;const client=new Proxy({getGame:async()=>{reads++;return {status:4,has_result:true,settled_height:100};},getGameReport:async()=>({throws_raw:raw,outcomes_raw:outcomes,payouts_raw:[]}),getHoleRules:async()=>({}),getSimInput:async()=>{throw Error("no settled simulation in fixture");}}, {get(target,key){if(key==="then")return undefined;if(key in target)return (target as any)[key];throw Error("forbidden client capability: "+String(key));}});
  const run=(allowed:boolean)=>runAgentSession(client as any,{} as any,{enabled:false},{botUser:user,defaultAsset:asset,defaultAmount:"100",storage,sessionId:"readonly",dryRun:false} as any,{pollMs:1,maxCycles:1,reconciliationOnly:true,canReconcile:async()=>allowed});
  return {client,storage,user,run,reads:()=>reads};
}

test("paused reconciliation completes a canonical accepted result without trading or signed-intent access",async t=>{
  const f=await pausedFixture(t);await f.run(true);assert.equal(f.reads(),1);assert.equal((await readPendingDecisions(f.storage,f.user)).length,0);assert.equal(getControlState().state,"paused");const rows=(await readFile(f.storage.resultsFile,"utf8")).trim().split("\n").map(line=>JSON.parse(line));assert.equal(rows.length,1);assert.equal(rows[0].actual.matched,true);
  await f.run(true);assert.equal(f.reads(),1);assert.equal((await readFile(f.storage.resultsFile,"utf8")).trim().split("\n").length,1);
});

test("reconciler performs no RPC or result write while the owning trader is live or unavailable",async t=>{
  const f=await pausedFixture(t);await f.run(false);assert.equal(f.reads(),0);assert.equal((await readPendingDecisions(f.storage,f.user)).length,1);await assert.rejects(readFile(f.storage.resultsFile));
});

test("reconciliation-only hard boundary survives local live flag and bounds work to two pending decisions",async t=>{
  const f=await pausedFixture(t,3);updateControlState({state:"live"});await f.run(true);assert.equal(f.reads(),2);assert.equal((await readPendingDecisions(f.storage,f.user)).length,1);updateControlState({state:"paused"});
});

test("canonical report maps historical candidate IDs before any local result order, refusing ambiguous commitments",async t=>{
  const f=await pausedFixture(t,0),gameId="bb".repeat(32),rows:any[]=[];
  for(let n=0;n<3;n++){
    const commit={schema:"collider.prediction.commit.v1",createdAt:"2026-11-09T00:00:0"+n+"Z",gameId,botUser:f.user,decisionId:"canonical"+n};
    const ref=await writeArtifactJson({dir:f.storage.predictionCommitsDir,schema:commit.schema,payload:commit});
    const id=(n+1).toString(16).padStart(64,"0");rows.push({id,user:f.user,data_commit:ref.sha256Hex});
    await appendThrowLog(f.storage,{ts:commit.createdAt,sessionId:"fixture",decisionId:commit.decisionId,gameId,botUser:f.user,submitted:true,dryRun:false,payload:{},predictionCommit:ref});
  }
  const params={storage:f.storage,gameId,botUser:f.user};
  assert.deepEqual((await loadPredictionHistoryForGame(params)).map(x=>x.resolvedActualThrowId),[null,null,null]);
  assert.deepEqual((await loadPredictionHistoryForGame({...params,report:{game_id:gameId,throws_raw:rows}})).map(x=>x.resolvedActualThrowId),rows.map(x=>x.id));
  const ambiguous=[...rows,{...rows[0],id:"ff".repeat(32)}];
  assert.equal((await loadPredictionHistoryForGame({...params,report:{game_id:gameId,throws_raw:ambiguous}}))[0].resolvedActualThrowId,null);
});

test("expired timed play pauses before any client or signing capability can be reached",async()=>{
  initRuntimeSettings(normalizeSettings({pollMs:1}));updateControlState({state:"live"});
  let clientAccesses=0;
  const client=new Proxy({}, {get(){clientAccesses++;throw Error("deadline must block all client access");}});
  await runAgentSession(client as any,{} as any,{enabled:true},{dryRun:false} as any,{pollMs:1,maxCycles:1,stopAtMs:Date.now()-1});
  assert.equal(getControlState().state,"paused");assert.equal(getControlState().lastAction?.action,"auto_pause_time_limit");
  assert.equal(clientAccesses,0);
});

test("regular operator pauses still collect precise settled outcomes without signing",async t=>{
  const f=await pausedFixture(t);
  await runAgentSession(f.client as any,{} as any,{enabled:true},{storage:f.storage,botUser:f.user,dryRun:true} as any,{pollMs:1,maxCycles:1});
  const rows=(await readFile(f.storage.resultsFile,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(rows.length,1);assert.equal(getControlState().state,'paused');
});
test("expired play with outstanding results performs only read-only settlement collection",async t=>{
  const f=await pausedFixture(t);updateControlState({state:'live'});
  await runAgentSession(f.client as any,{} as any,{enabled:true},{storage:f.storage,botUser:f.user,dryRun:false} as any,{pollMs:1,maxCycles:1,stopAtMs:Date.now()-1});
  const rows=(await readFile(f.storage.resultsFile,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(rows.length,1);assert.equal(getControlState().state,'paused');
});
