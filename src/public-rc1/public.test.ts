import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { Wallet } from "ethers";
import { JsonRpcClient } from "../core/rpc.js";
import { normalizeSettings, saveSettings } from "../core/settings.js";
import { loadOrCreateFujiTestWallet } from "../core/fuji-test-wallet.js";
import { buildBootstrapSummary } from "../core/bootstrap.js";
import { PUBLIC_RC1 as P, assertPublicAuth, assertPublicScope, FAUCET_SCOPE, verifyPublicPayload } from "./contract.js";
import { attachExactPriceBases } from "../core/price-basis.js";
import { estimateCandidateUsd } from "../agent/eligibility.js";
import { buildPublicSettings, assertPublicSettings, createPublicProfile, inspectOwnerJournals, acquirePublicSignerLease } from "./profile.js";
import { loadPublicGameRuntime, verifyPublicArtifact } from "./artifacts.js";
import { loadVizWasm } from "../sim/wasm.js";
import { authFixture, fundingFixture } from "./fixtures.test-support.js";
import { publicJson, parsePublicJson } from "./http.js";

test("public profile preserves owner limits, maps CLC deliberately, keeps funding opt-in and never selects historical start commands",()=>{
  const address=Wallet.createRandom().address,owner=normalizeSettings({expectedEvmAddress:address,signingKeyEnv:"FIXTURE_ONLY",maxThrowsPerGame:22,maxThrowsPerSession:498,
    minMillisBetweenLiveThrows:30000,maxThrowUsd:10,maxSingleThrowUsd:10,maxGameExposureUsd:110});
  const p=buildPublicSettings(owner,"data-owner",address);assertPublicSettings(p);
  for(const key of ["maxThrowsPerGame","maxThrowsPerSession","minMillisBetweenLiveThrows","maxThrowUsd","maxGameExposureUsd"] as const)assert.equal(p[key],owner[key]);
  assert.equal(p.asset,P.clc.slice(2));assert.equal(p.testnetAutoFunding?.enabled,false);assert.equal(p.expectedSigningChainId,null);
  assert.equal(buildBootstrapSummary(p).startCommand,"npm run start:fuji:public");
  assert.equal(buildBootstrapSummary(p).testnetAutoFunding.profile,P.profile);
  for(const changed of [{...p,rpc:"http://127.0.0.1/old"},{...p,expectedNetworkDomain:"0x"+"00".repeat(32)},
    {...p,asset:"09".repeat(32)},{...p,wasm:"assets/old.wasm"},{...p,expectedEvmAddress:Wallet.createRandom().address}])assert.throws(()=>assertPublicSettings(changed));
  assert.throws(()=>buildPublicSettings(owner,"data-owner",Wallet.createRandom().address));
});
test("wallets are owner supplied or explicitly unique, stored outside repo, and an existing public profile cannot rotate/copy journals",async t=>{
  const root=await mkdtemp(path.join(tmpdir(),"public-profile-"));t.after(()=>rm(root,{recursive:true,force:true}));
  const workspace=path.join(root,"workspace"),ownerDir=path.join(workspace,"data-owner"),data=path.join(workspace,"data-rc1-public-test");await mkdir(ownerDir,{recursive:true});
  const key=Wallet.createRandom(),keyFile=path.join(root,"fixture-owner.hex");await writeFile(keyFile,key.privateKey);
  const owner=normalizeSettings({expectedEvmAddress:key.address,signingKeyFile:keyFile,minMillisBetweenLiveThrows:30000,maxThrowsPerGame:22,maxThrowsPerSession:498});
  await saveSettings(owner,ownerDir);
  const settings=await createPublicProfile(data,ownerDir,key.address,workspace);assert.equal(settings.signingKeyFile,keyFile);
  await assert.rejects(createPublicProfile(data,ownerDir,key.address,workspace),/never overwrite/);
  await writeFile(path.join(ownerDir,"rc1-intent-state.json"),JSON.stringify({pending:{nonce:5}}));
  await assert.rejects(inspectOwnerJournals(ownerDir,key.address),/uncertain old signed work/);
  await rm(path.join(ownerDir,"rc1-intent-state.json"));
  const receipts=path.join(ownerDir,"confirmation-receipts.json");
  await writeFile(receipts,JSON.stringify({jobs:[{state:"refunded",pendingNonce:null,auditComplete:true}]}));
  assert.equal((await inspectOwnerJournals(ownerDir,key.address)).length,2);
  await writeFile(receipts,JSON.stringify({jobs:[{state:"refunded",pendingNonce:null,auditComplete:false}]}));
  await assert.rejects(inspectOwnerJournals(ownerDir,key.address),/bonded obligations/);
  await assert.rejects(loadOrCreateFujiTestWallet(path.join(workspace,"shared-test.hex"),workspace),/outside/);
  const leases=path.join(root,"leases"),release=await acquirePublicSignerLease(settings,data,leases);
  await assert.rejects(acquirePublicSignerLease(settings,"another-instance",leases),/lease held/);await release();
});
test("public auth uses the current signing epoch and canonical wallet while wrong domain, epoch or user holds",()=>{
  const user="0x"+"00".repeat(12)+"12".repeat(20),auth=authFixture(user,42);assert.equal(assertPublicAuth(auth,user),43113);
  assert.throws(()=>assertPublicAuth({...auth,network_domain:"0x"+"00".repeat(32)},user));
  assert.throws(()=>assertPublicAuth({...auth,native_intent_signing:{epoch:-1,evm_chain_id:43113}},user));
  assert.throws(()=>assertPublicAuth(auth,"0x"+"13".repeat(32)));
  assert.throws(()=>assertPublicScope({...FAUCET_SCOPE,route_id:"old"}));
});
test("public JSON preserves u128 but accepts physical floats; read 429/503 honor Retry-After and writes never retry",async t=>{
  assert.deepEqual(parsePublicJson('{"amount":340282366920938463463374607431768211455,"x":1.25,"literal":"123"}'),
    {amount:"340282366920938463463374607431768211455",x:1.25,literal:"123"});
  const waits:number[]=[],requests:string[]=[];
  t.mock.method(globalThis,"fetch",async(_url:unknown,init:RequestInit)=>{
    assert.equal(init.redirect,"error");const body=JSON.parse(String(init.body));requests.push(body.method);
    if(requests.length===1)return new Response("",{status:429,headers:{"retry-after":"2"}});
    if(requests.length===2)return new Response("",{status:503,headers:{"retry-after":"1"}});
    return new Response(JSON.stringify({jsonrpc:"2.0",id:body.id,result:{n:"1"}}),{headers:{"content-type":"application/json"}});
  });
  const rpc=new JsonRpcClient(P.rpc,{}, {sleep:async ms=>{waits.push(ms);}});
  assert.deepEqual(await rpc.call("colliderV2.getBalances",[]),{n:"1"});assert.equal(requests.length,3);assert.ok(waits[0]>=2000&&waits[1]>=1000);
  await assert.rejects(rpc.call("colliderV2.donateTreasury",[]),/denied/);
  let writes=0;t.mock.method(globalThis,"fetch",async()=>{writes++;return new Response("",{status:503});});
  await assert.rejects(rpc.call("colliderV2.submitSignedIntent",[],{retries:100,redactErrors:true}));assert.equal(writes,1);
});
test("public faucet transport rejects another URL, redirects and HTML, and never retries claim POST after 429/503",async()=>{
  for(const status of [429,503]){let calls=0;await assert.rejects(publicJson(P.faucet+"/v1/claim",{method:"POST"},
    {fetchFn:async()=>{calls++;return new Response("",{status,headers:{"retry-after":"1"}});},sleep:async()=>{}}));assert.equal(calls,1);}
  await assert.rejects(publicJson("https://evil.example/healthz"),/not pinned/);
  await assert.rejects(publicJson(P.faucet+"/healthz",{},{fetchFn:async()=>new Response("",{status:302,headers:{location:"https://evil.example"}})}),/redirect/);
  await assert.rejects(publicJson(P.faucet+"/healthz",{},{fetchFn:async()=>new Response("<html>not health</html>",{headers:{"content-type":"text/html"}})}),/not JSON/);
});
test("simulator selection rejects unknown game/round artifact instead of latest fallback and verifies bytes before execution",async t=>{
  const game="0x"+"12".repeat(32),binding={game_id:game,artifact_hash:"0x"+P.wasmSha256,arena_schema:4,preview_abi:2,result_digest_version:2};
  let bad=false,frozen=false,runs=0;
  const runtime=await loadPublicGameRuntime({getGameSimulator:async()=>bad?{...binding,artifact_hash:"0x"+"00".repeat(32)}:binding,
    getFrozenConfirmationInput:async()=>frozen?{game_id:game,artifact_hash:"wrong",digest_version:2}:null},P.wasmPath,async()=>({runToFinalize:async()=>{runs++;return new Uint8Array();}}));
  await assert.rejects(runtime.runToFinalize({} as any),/select the game/);
  await (await runtime.forGame!(game)).runToFinalize({} as any);assert.equal(runs,1);
  bad=true;await assert.rejects(runtime.forGame!(game),/unsupported/);bad=false;frozen=true;await assert.rejects(runtime.forGame!(game),/frozen round/);assert.equal(runs,1);
  const temp=await mkdtemp(path.join(tmpdir(),"wrong-sim-"));t.after(()=>rm(temp,{recursive:true,force:true}));const file=path.join(temp,"sim.wasm");await writeFile(file,"not wasm");
  await assert.rejects(verifyPublicArtifact(file),/bytes\/hash/);
});
test("reviewed 0.2.1 WASM matches independent native whole-result vectors for rotation, moving bodies, conveyors and weight/value scaling",async()=>{
  const raw=await readFile("assets/public-rc1-20261104/native-motion-vectors-r29b.json");assert.equal(createHash("sha256").update(raw).digest("hex"),"c0f5484a9a06a89ac74a89b4c1ab00c75da214e8bf2e483368eaea32d7d90065");
  const fixtures=parsePublicJson(raw.toString()) as any,runtime=await loadVizWasm(P.wasmPath);assert.equal(fixtures.schema,4);
  for(const vector of fixtures.vectors){const before=JSON.stringify(vector.input),actual=await runtime.runToFinalize(vector.input);
    const expected=typeof vector.result_bytes==="string"?Buffer.from(vector.result_bytes,"base64"):Buffer.from(vector.result_bytes);
    assert.deepEqual(Buffer.from(actual),expected,vector.name);assert.equal(JSON.stringify(vector.input),before);}
});
test("CLC bootstrap valuation is explicit live input, not an outage/market fallback",()=>{
  const input={assets:[],throws:[]} as any,hints=attachExactPriceBases({[P.clc.slice(2)]:2.5e-20},{[P.clc]:{priceE8:"2500000",decimals:18,epoch:0}});
  assert.equal(estimateCandidateUsd("4000000000000000000",P.clc,input,hints),0.1);
  assert.equal(estimateCandidateUsd("4000000000000000000",P.clc,input,{}),null);
});

test("public signing independently verifies returned op_b64 against canonical tagged payload hash",async()=>{
  const vectors=JSON.parse(await readFile("src/collider/fixtures/native-signing-vectors.json","utf8"));
  for(const v of vectors){const prepared={op_b64:v.op_b64,payload_hash:v.typed_data.message.payloadHash};
    assert.doesNotThrow(()=>verifyPublicPayload(prepared));
    assert.throws(()=>verifyPublicPayload({...prepared,op_b64:Buffer.from("different operation").toString("base64")}));}
});
