import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp,mkdir,writeFile,readFile,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildContentAddressRefFromJson,buildContentAddressRefFromBytes } from "../core/content-address.js";
import { PUBLIC_RC1 as P } from "../public-rc1/contract.js";
import { buildEnvelope,ForecastPublisher,validateConfig,atomic,retryDelay } from "./publisher.js";
async function fixture(t:any){const dir=await mkdtemp(path.join(tmpdir(),"forecast-publisher-"));t.after(()=>rm(dir,{recursive:true,force:true}));
  const user="11".repeat(32),gameId="22".repeat(32),throwId="33".repeat(32);
  for(const sub of["prediction-commits","prediction-reveals","game-history/results"])await mkdir(path.join(dir,sub),{recursive:true});
  const commit={schema:"collider.prediction.commit.v1",version:1,createdAt:"2026-11-06T00:00:00Z",sessionId:"fixture",decisionId:"one",gameId,botUser:user,placeThrowCommitField:"data_commit",commitSaltHex:"public-settled-fixture",weights:{},coverage:{},priceBasis:{},snapshots:[{}]};
  const cr=buildContentAddressRefFromJson(commit);await writeFile(path.join(dir,"prediction-commits",cr.cid+".json"),cr.canonicalJson);
  const reveal={schema:"collider.prediction.reveal.v1",version:1,createdAt:"2026-11-06T01:00:00Z",sessionId:"fixture",decisionId:"one",gameId,botUser:user,commit:{sha256Hex:cr.sha256Hex,cid:cr.cid,localPath:"prediction-commits/"+cr.cid+".json"},actualContext:{matchedThrowId:throwId},headline:{},layers:{},evaluations:{}};
  const rr=buildContentAddressRefFromJson(reveal);await writeFile(path.join(dir,"prediction-reveals",rr.cid+".json"),rr.canonicalJson);
  const row={gameId,botUser:user,decisionId:"one",actual:{throwMatch:{throw_id:throwId}},predictionCommit:{sha256Hex:cr.sha256Hex},predictionReveal:{sha256Hex:rr.sha256Hex}};
  const game={game_id:gameId,status:4,has_result:true,settled_height:100};const report={throws_raw:[{id:throwId,user,data_commit:cr.sha256Hex}]};
  await atomic(path.join(dir,"settings.json"),{rpc:P.rpc,expectedNetworkDomain:P.domain,user});
  await atomic(path.join(dir,"forecast-publisher.json"),{enabled:true,targets:["http://127.0.0.1:8787"],allowLoopbackHttp:true});
  await writeFile(path.join(dir,"game-history/results",gameId+".jsonl"),JSON.stringify(row)+"\n");
  return {dir,row,game,report,client:{getGame:async()=>game,getGameReport:async()=>report}};
}
const response=(data:unknown,status=200,headers={})=>new Response(JSON.stringify(data),{status,headers:{"content-type":"application/json",...headers}});
const capability={schema:"collider.forecast.provider-capabilities.v1",network:"fuji-rc1-public",chain_id:P.chain,native_chain_id:P.chainHex,max_envelope_bytes:2*1024*1024,features:{single_reveal_post:true},endpoints:{reveal:"/v1/forecast/reveals"},ingestion:{enabled:true,accepting:true,settlement_required:true}};
test("only exact canonical settled identity can disclose a deterministic envelope",async t=>{const f=await fixture(t),first=await buildEnvelope(f.dir,f.row,f.report,f.game),second=await buildEnvelope(f.dir,f.row,f.report,f.game);assert.equal(first.id,second.id);assert.equal(first.bytes,second.bytes);assert.equal(first.envelope.created_at_ms,Date.parse("2026-11-06T01:00:00Z"));
  await assert.rejects(buildEnvelope(f.dir,f.row,f.report,{...f.game,status:0}),/settlement/);
  await assert.rejects(buildEnvelope(f.dir,f.row,{throws_raw:[{...f.report.throws_raw[0],data_commit:"00".repeat(32)}]},f.game),/data_commit/);
  await assert.rejects(buildEnvelope(f.dir,f.row,{throws_raw:[...f.report.throws_raw,{id:"44".repeat(32),user:f.row.botUser,data_commit:"55".repeat(32)}]},f.game));
});
test("persistent acknowledgement means delivery only; restart does not repost",async t=>{const f=await fixture(t);let posts=0;const fetchFn=async(url:any,init?:RequestInit)=>{if(String(url).endsWith("capabilities"))return response(capability);posts++;assert.equal(init?.redirect,"error");return response({accepted:true,status:"queued",artifact_id:"fixture"},202);};
  assert.equal((await new ForecastPublisher(f.dir,{client:f.client,fetchFn:fetchFn as any}).tick(1) as any).delivered,1);
  await new ForecastPublisher(f.dir,{client:f.client,fetchFn:fetchFn as any}).tick(1);assert.equal(posts,1);
  const s=JSON.parse(await readFile(path.join(f.dir,"forecast-outbox/state.json"),"utf8"));assert.equal((Object.values(s.jobs)[0] as any).receipt.status,"queued");
});
test("lost delivery response retries identical bytes after restart, respecting Retry-After",async t=>{const f=await fixture(t);let now=100000,posts:string[]=[];const fetchFn=async(url:any,init?:RequestInit)=>{if(String(url).endsWith("capabilities"))return response(capability);posts.push(String(init?.body));return posts.length===1?response({},429,{"retry-after":"120"}):response({accepted:true,status:"queued",artifact_id:1},202);};const deps={client:f.client,fetchFn:fetchFn as any,now:()=>now,random:()=>0};
  await new ForecastPublisher(f.dir,deps).tick(1);now+=60000;await new ForecastPublisher(f.dir,deps).tick(1);assert.equal(posts.length,1);now+=61000;await new ForecastPublisher(f.dir,deps).tick(1);assert.equal(posts.length,2);assert.equal(posts[0],posts[1]);
});
test("missing capabilities, paused settlement and disabled config send no artifacts",async t=>{const f=await fixture(t);let posts=0;const fetchFn=async(_u:any,init?:RequestInit)=>{if(init?.method==="POST")posts++;return response({})};await new ForecastPublisher(f.dir,{client:f.client,fetchFn:fetchFn as any}).tick();assert.equal(posts,0);
  await atomic(path.join(f.dir,"forecast-publisher.json"),{enabled:false,targets:[],allowLoopbackHttp:false});await new ForecastPublisher(f.dir,{fetchFn:fetchFn as any}).tick();assert.equal(posts,0);
});
test("target roots reject credentials, paths, and non-loopback HTTP; retry remains bounded",()=>{for(const target of["http://evil.example","https://user:password@host","https://example.com/a","https://example.com?key=x"])assert.throws(()=>validateConfig({enabled:true,targets:[target],allowLoopbackHttp:true}));validateConfig({enabled:true,targets:["https://gamechain.info","https://explorer.cryptocollider.com"],allowLoopbackHttp:false});assert.ok(retryDelay(1,"120",0,0)>=120000);});

test("lost receipt fails over later with the same immutable envelope and never broadcasts",async t=>{const f=await fixture(t);await atomic(path.join(f.dir,"forecast-publisher.json"),{enabled:true,targets:["https://primary.example","https://backup.example"],allowLoopbackHttp:false});let now=100000;const posts:{url:string;body:string}[]=[];const deps={client:f.client,now:()=>now,random:()=>0,fetchFn:(async(url:any,init?:RequestInit)=>{if(String(url).endsWith("capabilities"))return response(capability);posts.push({url:String(url),body:String(init?.body)});if(posts.length===1)throw Error("lost acknowledgement");return response({accepted:true,status:"queued",artifact_id:1},202);}) as any};
  await new ForecastPublisher(f.dir,deps).tick(1);assert.equal(posts.length,1);now+=61000;await new ForecastPublisher(f.dir,deps).tick(1);assert.equal(posts.length,2);assert.match(posts[0].url,/primary/);assert.match(posts[1].url,/backup/);assert.equal(posts[0].body,posts[1].body);
});
test("absolute-path hashed artifacts hold without rewriting",async t=>{const f=await fixture(t);
  const ref=f.row.predictionReveal.sha256Hex;const files=await import("node:fs/promises").then(m=>m.readdir(path.join(f.dir,"prediction-reveals")));const original=JSON.parse(await readFile(path.join(f.dir,"prediction-reveals",files[0]),"utf8"));original.commit.localPath="C:\\private\\profile\\commit.json";const a=buildContentAddressRefFromJson(original);await writeFile(path.join(f.dir,"prediction-reveals",a.cid+".json"),a.canonicalJson);f.row.predictionReveal.sha256Hex=a.sha256Hex;
  await assert.rejects(buildEnvelope(f.dir,f.row,f.report,f.game),/absolute localPath/);assert.notEqual(a.sha256Hex,ref);
});
test("capability pressure delays even new backfill, and an outbox lease prevents concurrent delivery",async t=>{const f=await fixture(t);let now=100000,calls=0;const deps={client:f.client,now:()=>now,random:()=>0,fetchFn:(async()=>{calls++;return response({},503,{"retry-after":"120"});})as any};await new ForecastPublisher(f.dir,deps).tick();now+=60000;await new ForecastPublisher(f.dir,deps).tick();assert.equal(calls,1);
  await writeFile(path.join(f.dir,"forecast-outbox/publisher.lock"),"other process");await assert.rejects(new ForecastPublisher(f.dir,deps).tick());assert.equal(calls,1);
});

const ipfsCapability={...capability,features:{single_reveal_post:true,reveal_announcement_post:true},endpoints:{reveal:"/v1/forecast/reveals",announcements:"/v1/forecast/announcements"}};
test("activation watermark skips old predictions durably, preserving dependencies for a fresh reveal",async t=>{
  const f=await fixture(t);await atomic(path.join(f.dir,"forecast-publisher.json"),{enabled:true,targets:["http://127.0.0.1:8787"],allowLoopbackHttp:true,publishAfter:"2026-11-06T00:30:00Z"});let posts=0;
  const fetchFn=(async(url:any)=>String(url).endsWith("capabilities")?response(capability):(posts++,response({accepted:true,status:"queued",artifact_id:1},202)))as typeof fetch;
  await new ForecastPublisher(f.dir,{client:f.client,fetchFn}).tick();assert.equal(posts,0);
  const before=JSON.parse(await readFile(path.join(f.dir,"forecast-outbox/state.json"),"utf8"));assert.ok(before.cursors[f.row.gameId+".jsonl"]>0);assert.equal(Object.keys(before.jobs).length,0);
  const files=await import("node:fs/promises").then(m=>m.readdir(path.join(f.dir,"prediction-commits")));const old=JSON.parse(await readFile(path.join(f.dir,"prediction-commits",files[0]),"utf8"));const fresh={...old,createdAt:"2026-11-06T02:00:00Z",decisionId:"two"};const cr=buildContentAddressRefFromJson(fresh);await writeFile(path.join(f.dir,"prediction-commits",cr.cid+".json"),cr.canonicalJson);
  const reveals=await import("node:fs/promises").then(m=>m.readdir(path.join(f.dir,"prediction-reveals")));const rev=JSON.parse(await readFile(path.join(f.dir,"prediction-reveals",reveals[0]),"utf8"));const throwId="44".repeat(32),rr=buildContentAddressRefFromJson({...rev,createdAt:"2026-11-06T03:00:00Z",decisionId:"two",commit:{sha256Hex:cr.sha256Hex},actualContext:{matchedThrowId:throwId}});await writeFile(path.join(f.dir,"prediction-reveals",rr.cid+".json"),rr.canonicalJson);
  f.report.throws_raw.push({id:throwId,user:f.row.botUser,data_commit:cr.sha256Hex});const row={...f.row,decisionId:"two",actual:{throwMatch:{throw_id:throwId}},predictionCommit:{sha256Hex:cr.sha256Hex},predictionReveal:{sha256Hex:rr.sha256Hex}};
  await import("node:fs/promises").then(m=>m.appendFile(path.join(f.dir,"game-history/results",f.row.gameId+".jsonl"),JSON.stringify(row)+"\n"));let history=0;
  const send=(async(url:any,init?:RequestInit)=>{if(String(url).endsWith("capabilities"))return response(capability);posts++;history=JSON.parse(String(init?.body)).artifacts.history.length;return response({accepted:true,status:"queued",artifact_id:1},202);})as typeof fetch;
  await new ForecastPublisher(f.dir,{client:f.client,fetchFn:send}).tick();assert.equal(posts,1);assert.equal(history,1);
});

test("verification polling survives restart and never reposts acknowledged envelopes",async t=>{
  const f=await fixture(t);let posts=0,gets=0;const cap={...capability,features:{...capability.features,receipt_lookup:true},endpoints:{...capability.endpoints,receipts:"/v1/forecast/receipts/{artifact_id}"}};
  const fetchFn=(async(url:any,init?:RequestInit)=>{if(String(url).endsWith("capabilities"))return response(cap);if(init?.method==="POST"){posts++;return response({accepted:true,status:"queued",artifact_id:1},202);}gets++;return response({artifact_id:1,network:cap.network,chain_id:P.chain,data_commit:f.row.predictionCommit.sha256Hex,game_id:f.row.gameId,throw_id:f.row.actual.throwMatch.throw_id,user_id:f.row.botUser,verification:"verified",score:{eligible:1,honest_score:65.6}});})as typeof fetch;
  await new ForecastPublisher(f.dir,{client:f.client,fetchFn}).tick();await new ForecastPublisher(f.dir,{client:f.client,fetchFn}).tick();assert.equal(posts,1);assert.equal(gets,1);
  const s=JSON.parse(await readFile(path.join(f.dir,"forecast-outbox/state.json"),"utf8")),j:any=Object.values(s.jobs)[0];assert.equal(j.receipt.status,"queued");assert.equal(j.verification.status,"verified");assert.equal(j.verification.honestScore,65.6);
});

test("foreign receipt scope cannot turn delivery acknowledgement into verified HPS",async t=>{
  const {pollVerification}=await import("./receipts.js"),f=await fixture(t),e=await buildEnvelope(f.dir,f.row,f.report,f.game);
  const v=await pollVerification((async()=>response({artifact_id:1,network:"fuji-rc1-public",chain_id:P.chain,verification:"verified",score:{eligible:1,honest_score:100}}))as typeof fetch,"https://collector.example",1,e.envelope,100000);
  assert.equal(v.status,"pending");assert.match(v.error!,/scope mismatch/);assert.equal(v.honestScore,undefined);
});
const ipfsConfig={enabled:true,kuboApi:"http://127.0.0.1:5001",httpFallback:false};
function networkFixture(options:{unavailable?:boolean;interrupt?:boolean}={}){
  const blocks=new Map<string,Buffer>(),puts=new Map<string,number>(),posts:{url:string;body:any}[]=[];let interrupted=false;
  const fetchFn=(async(url:any,init?:RequestInit)=>{const u=String(url);
    if(u.startsWith(ipfsConfig.kuboApi)){
      if(options.unavailable)throw Error("Kubo unavailable");
      if(u.endsWith('/id'))return response({ID:"12D3KooWfixtureNodeIdentity"});
      if(u.includes('/block/put')){if(options.interrupt&&!interrupted&&blocks.size===1){interrupted=true;throw Error("temporary pin interruption");}const blob=(init?.body as FormData).get('file') as Blob,bytes=Buffer.from(await blob.arrayBuffer()),ref=buildContentAddressRefFromBytes(bytes);blocks.set(ref.cid,bytes);puts.set(ref.cid,(puts.get(ref.cid)??0)+1);return response({Key:ref.cid,Size:bytes.length});}
      const cid=new URL(u).searchParams.get('arg')!;return new Response(new Uint8Array(blocks.get(cid)!));
    }
    if(u.endsWith('capabilities'))return response(ipfsCapability);
    posts.push({url:u,body:JSON.parse(String(init?.body))});
    return u.endsWith('announcements')?response({accepted:true,announcement_id:7,artifact_id:null,verification:"pending",receipt_url:"/v1/forecast/announcements/7"},202):response({accepted:true,artifact_id:9,status:"queued"},202);
  })as typeof fetch;
  return {fetchFn,blocks,puts,posts};
}
test("IPFS pins exact artifacts then only announces CID; queued discovery is not artifact verification",async t=>{
  const f=await fixture(t),n=networkFixture();await atomic(path.join(f.dir,'forecast-publisher.json'),{enabled:true,targets:['https://collector.example'],allowLoopbackHttp:false,ipfs:ipfsConfig});
  await new ForecastPublisher(f.dir,{client:f.client,fetchFn:n.fetchFn}).tick(1);
  assert.equal(n.blocks.size,3);assert.equal(n.posts.length,1);assert.match(n.posts[0].url,/announcements$/);assert.equal(n.posts[0].body.schema,"collider.forecast.reveal-announcement.v1");assert.ok(n.blocks.has(n.posts[0].body.cid));assert.equal(n.posts[0].body.artifacts,undefined);
  const s=JSON.parse(await readFile(path.join(f.dir,'forecast-outbox-ipfs/state.json'),'utf8')),j:any=Object.values(s.jobs)[0];assert.equal(j.status,'delivered');assert.equal(j.receipt.announcement_id,7);assert.equal(j.receipt.artifact_id,undefined);assert.equal(j.receipt.status,'pending');
  await new ForecastPublisher(f.dir,{client:f.client,fetchFn:n.fetchFn}).tick(1);assert.equal(n.posts.length,1);
});
test("IPFS outage uses explicit HTTP envelope fallback, without claiming pins",async t=>{
  const f=await fixture(t),n=networkFixture({unavailable:true});await atomic(path.join(f.dir,'forecast-publisher.json'),{enabled:true,targets:['https://collector.example'],allowLoopbackHttp:false,ipfs:{...ipfsConfig,httpFallback:true}});
  await new ForecastPublisher(f.dir,{client:f.client,fetchFn:n.fetchFn}).tick(1);assert.equal(n.posts.length,1);assert.match(n.posts[0].url,/reveals$/);assert.equal(n.posts[0].body.schema,'collider.forecast.reveal-envelope.v1');assert.equal(n.blocks.size,0);
});
test("restart resumes retained pin progress before announcing and does not repin acknowledged block",async t=>{
  const f=await fixture(t),n=networkFixture({interrupt:true});let now=100000;await atomic(path.join(f.dir,'forecast-publisher.json'),{enabled:true,targets:['https://collector.example'],allowLoopbackHttp:false,ipfs:ipfsConfig});const deps={client:f.client,fetchFn:n.fetchFn,now:()=>now,random:()=>0};
  await new ForecastPublisher(f.dir,deps).tick(1);assert.equal(n.blocks.size,1);assert.equal(n.posts.length,0);now+=61000;await new ForecastPublisher(f.dir,deps).tick(1);assert.equal(n.blocks.size,3);assert.equal(n.posts.length,1);assert.ok([...n.puts.values()].every(v=>v===1));
});
test("IPFS-only publication pins without collector but keeps envelope discovery pending",async t=>{
  const f=await fixture(t),n=networkFixture();await atomic(path.join(f.dir,'forecast-publisher.json'),{enabled:true,targets:[],allowLoopbackHttp:false,ipfs:ipfsConfig});
  const result:any=await new ForecastPublisher(f.dir,{client:f.client,fetchFn:n.fetchFn}).tick(1);assert.equal(n.blocks.size,3);assert.equal(n.posts.length,0);assert.equal(result.delivered,0);assert.equal(result.pending,1);
});

test('manual reveal export is bounded, default-off, deduplicated and preserves activation watermark/cursors',async t=>{const {queueExistingReveals,setExplorerPublishing}=await import('./publisher.js');const f=await fixture(t);await writeFile(path.join(f.dir,'results.jsonl'),JSON.stringify(f.row)+'\n');await atomic(path.join(f.dir,'forecast-publisher.json'),{enabled:false,targets:[],allowLoopbackHttp:false});await assert.rejects(queueExistingReveals(f.dir,101,{client:f.client}),/1..100/);await assert.rejects(queueExistingReveals(f.dir,1,{client:f.client}),/Enable/);await setExplorerPublishing(f.dir,true);const before=JSON.parse(await readFile(path.join(f.dir,'forecast-publisher.json'),'utf8'));const a=await queueExistingReveals(f.dir,1,{client:f.client});assert.equal(a.queued,1);const b=await queueExistingReveals(f.dir,1,{client:f.client});assert.equal(b.queued,0);assert.equal(b.duplicates,1);const after=JSON.parse(await readFile(path.join(f.dir,'forecast-publisher.json'),'utf8'));assert.equal(after.publishAfter,before.publishAfter);const state=JSON.parse(await readFile(path.join(f.dir,'forecast-outbox/state.json'),'utf8'));assert.deepEqual(state.cursors,{});assert.equal(Object.keys(state.jobs).length,1);await setExplorerPublishing(f.dir,false);});
