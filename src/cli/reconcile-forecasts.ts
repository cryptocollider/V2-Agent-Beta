import path from "node:path";
import { open, readFile, rm } from "node:fs/promises";
import { ColliderClient } from "../collider/client.js";
import { PUBLIC_RC1 as P, assertPublicAuth } from "../public-rc1/contract.js";
import { initStorage } from "../core/storage.js";
import { normalizeSettings } from "../core/settings.js";
import { initRuntimeSettings, updateControlState } from "../core/runtime-state.js";
import { runAgentSession, type ColliderClientSessionLike } from "../agent/session.js";
import type { LoopConfig } from "../agent/loop.js";
import type { WasmVizRuntime } from "../sim/wasm.js";

const args=process.argv.slice(2),at=args.indexOf("--data-dir"),dir=at>=0?args[at+1]:P.dataDir;
const untilAt=args.indexOf("--until"),until=untilAt>=0?Date.parse(args[untilAt+1]):null;
if(until!==null&&(!Number.isFinite(until)||until<=Date.now()))throw Error("--until must be a future read-only observer deadline");
const settings=JSON.parse(await readFile(path.join(dir,"settings.json"),"utf8"));
if(settings.rpc!==P.rpc||settings.expectedNetworkDomain!==P.domain||!/^[a-fA-F0-9]{64}$/.test(settings.user.replace(/^0x/,"")))throw Error("reconciler scope mismatch");
const user="0x"+settings.user.replace(/^0x/,""),monitor="http://127.0.0.1:"+Number(settings.monitorPort??8795);
const client=new ColliderClient(P.rpc); // No wallet supplied, no key file loaded.
const readonlyClient=Object.freeze(Object.fromEntries(["getGame","getGameReport","getSimInput","getHoleRules"].map(name=>[name,(client[name as keyof ColliderClient] as Function).bind(client)]))) as ColliderClientSessionLike;
const storage=await initStorage(dir),lockPath=path.join(dir,"paused-forecast-reconciler.lock"),lock=await open(lockPath,"wx",0o600);
await lock.writeFile(String(process.pid));await lock.sync();
const stop=new AbortController();process.once("SIGINT",()=>stop.abort());process.once("SIGTERM",()=>stop.abort());
const deadline=until===null?null:setTimeout(()=>stop.abort(),until-Date.now());
// Only public identity/sizing defaults enter this isolated process's memory; it has no monitor/control write API.
initRuntimeSettings(normalizeSettings({rpc:P.rpc,user:settings.user,asset:settings.asset,amount:settings.amount,pollMs:30000}));
updateControlState({state:"paused",mode:"read-only-reconciliation"});
async function canReconcile(){
  if(stop.signal.aborted)return false;
  try{
    const r=await fetch(monitor+"/api/control/status",{redirect:"error",signal:AbortSignal.timeout(5000)}),c=await r.json();
    if(!r.ok||c.state!=="paused")return false;
    const rt=await(await fetch(monitor+"/api/runtime-settings",{redirect:"error",signal:AbortSignal.timeout(5000)})).json();
    if(rt.rpc!==P.rpc||String(rt.user).replace(/^0x/,"").toLowerCase()!==user.slice(2).toLowerCase())return false;
    assertPublicAuth(await client.getAuthContext(user),user);return true;
  }catch{return false;}
}
console.log("Read-only paused-result reconciler: two pending decisions per 30s; no wallet, signing or control writes.");
try{await runAgentSession(readonlyClient,Object.freeze({}) as WasmVizRuntime,{enabled:false},{botUser:settings.user,defaultAsset:settings.asset,defaultAmount:settings.amount,storage,sessionId:"paused-reconciler-"+process.pid,dryRun:false} as LoopConfig,{pollMs:30000,reconciliationOnly:true,canReconcile,signal:stop.signal});}
finally{if(deadline)clearTimeout(deadline);await lock.close();await rm(lockPath);}
