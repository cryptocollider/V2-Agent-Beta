import assert from "node:assert/strict";
import test from "node:test";
import { blockFromBytes,envelopeBlocks,KuboRawPublisher,validateIpfsConfig,KuboRetryError } from "./ipfs.js";
import { buildContentAddressRefFromJson } from "../core/content-address.js";
const config={enabled:true,kuboApi:"http://127.0.0.1:5001",httpFallback:true};
test("Kubo raw publication preserves exact bytes/CID, requests a pin and verifies readback",async()=>{
  const block=blockFromBytes(Buffer.from('{"a":1}')),calls:string[]=[];
  const client=new KuboRawPublisher(config,(async(url:any,init?:RequestInit)=>{calls.push(String(url));assert.equal(init?.redirect,"error");assert.equal(init?.method,"POST");if(String(url).endsWith('/id'))return new Response(JSON.stringify({ID:"12D3KooWfixtureNodeIdentity"}));if(String(url).includes('block/put')){assert.match(String(url),/cid-codec=raw/);assert.match(String(url),/pin=true/);assert.match(String(url),/allow-big-block=false/);const blob=(init!.body as FormData).get('file') as Blob;assert.deepEqual(Buffer.from(await blob.arrayBuffer()),Buffer.from(block.bytes));return new Response(JSON.stringify({Key:block.cid,Size:block.bytes.length}));}return new Response(new Uint8Array(block.bytes));})as any);
  const nodeId=await client.identity(),receipt=await client.pin(block,nodeId);assert.equal(receipt.readbackVerified,true);assert.equal(receipt.nodeId,nodeId);assert.equal(calls.length,3);assert.ok(calls.every(u=>!u.includes('/add')));
});
test("wrong CID, corrupt readback, disabled publishing and remote admin APIs hold",async()=>{
  const block=blockFromBytes(Buffer.from('original'));
  for(const corruptPut of[true,false]){const c=new KuboRawPublisher(config,(async(url:any)=>String(url).includes('block/put')?new Response(JSON.stringify({Key:corruptPut?'wrong':block.cid,Size:block.bytes.length})):new Response('tampered'))as any);await assert.rejects(c.pin(block,'fixture'));}
  assert.throws(()=>new KuboRawPublisher({...config,enabled:false}));
  for(const url of['http://public.example:5001','https://127.0.0.1:5001','http://user:secret@localhost:5001','http://127.0.0.1:5001/path'])assert.throws(()=>validateIpfsConfig({...config,kuboApi:url}));
  assert.throws(()=>validateIpfsConfig({...config,kuboApi:'https://operator.example',allowRemoteKubo:true,authEnv:'COLLIDER_AGENT_PRIVATE_KEY'}));
  assert.throws(()=>blockFromBytes(new Uint8Array(2*1024*1024+1)));
});
test("envelope block set includes unchanged canonical commits, history, reveal and full envelope",()=>{
  const ref=(payload:any)=>{const r=buildContentAddressRefFromJson(payload);return {payload,cid:r.cid,sha256_hex:r.sha256Hex};};
  const e={schema:"collider.forecast.reveal-envelope.v1",artifacts:{commit:ref({kind:'commit'}),history:[ref({kind:'history'})],reveal:ref({kind:'reveal'})}};
  const bytes=Buffer.from(JSON.stringify(e)),blocks=envelopeBlocks(bytes);assert.equal(blocks.length,4);assert.equal(blocks.at(-1)?.cid,blockFromBytes(bytes).cid);
  e.artifacts.commit.payload.kind='changed';assert.throws(()=>envelopeBlocks(Buffer.from(JSON.stringify(e))),/changed/);
});

test("Kubo Retry-After is surfaced without losing or replacing content",async()=>{
  const c=new KuboRawPublisher(config,(async()=>new Response('{}',{status:503,headers:{'retry-after':'120'}}))as any);
  await assert.rejects(c.identity(),(e:any)=>e instanceof KuboRetryError&&e.delayMs>=120000);
});
test("remote Kubo requires explicit HTTPS and takes its credential only from an environment reference",async()=>{
  const name='AGENT1_IPFS_TEST_TOKEN',prior=process.env[name];process.env[name]='fixture-only-not-a-real-credential';
  try{const c=new KuboRawPublisher({...config,kuboApi:'https://operator.example',allowRemoteKubo:true,authEnv:name},(async(url:any,init?:RequestInit)=>{
    assert.equal(String(url),'https://operator.example/api/v0/id');assert.equal((init?.headers as any).authorization,'Bearer '+process.env[name]);return new Response(JSON.stringify({ID:'12D3KooWfixtureNodeIdentity'}));
  })as any);assert.equal(await c.identity(),'12D3KooWfixtureNodeIdentity');}
  finally{if(prior===undefined)delete process.env[name];else process.env[name]=prior;}
});
