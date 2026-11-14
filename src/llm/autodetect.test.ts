import assert from "node:assert/strict";
import test from "node:test";
import { autoDetectLocalManagerProvider } from "./autodetect.js";

test("Ollama-only detection reads installed models without probing or installing other runtimes", async t => {
  const calls:string[]=[];
  t.mock.method(globalThis,"fetch",async(url:unknown,init:RequestInit)=>{
    calls.push(String(url));assert.equal(init.method,"GET");
    return new Response(JSON.stringify({models:[{name:"owner-installed-model"}]}),{headers:{"content-type":"application/json"}});
  });
  const result=await autoDetectLocalManagerProvider("ollama");
  assert.deepEqual(calls,["http://127.0.0.1:11434/api/tags"]);
  assert.equal(result.selected?.providerId,"ollama");
  assert.equal(result.selected?.model,"owner-installed-model");
});

test("missing or model-less Ollama remains disconnected without setup or fallback",async t=>{
  let calls=0;
  t.mock.method(globalThis,"fetch",async()=>{calls++;return new Response(JSON.stringify({models:[]}));});
  assert.equal((await autoDetectLocalManagerProvider("ollama")).selected,null);
  t.mock.method(globalThis,"fetch",async()=>{calls++;throw Error("not running");});
  assert.equal((await autoDetectLocalManagerProvider("ollama")).selected,null);
  assert.equal(calls,2);
});
