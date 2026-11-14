import test from "node:test";
import assert from "node:assert/strict";
import {invokeOpenRouterProvider} from "./openrouter.js";
import {invokeVeniceProvider} from "./venice.js";
import {invokeOpenAiProvider} from "./openai.js";
test("free OpenRouter inference has zero-price routing, no fallback and a small bounded response",async()=>{
  const original=globalThis.fetch;let calls=0;globalThis.fetch=(async(_url,init)=>{calls++;const b=JSON.parse(String(init?.body));assert.deepEqual(b.provider,{allow_fallbacks:false,max_price:{prompt:0,completion:0}});assert.equal(b.max_tokens,768);assert.equal(init?.redirect,"error");assert.ok(init?.signal);return new Response(JSON.stringify({model:b.model,choices:[{message:{content:'{"reply":"ok","proposals":[]}'}}]}),{headers:{"content-type":"application/json"}});})as typeof fetch;
  try{await invokeOpenRouterProvider({config:{enabled:true,model:"liquid/lfm-3-1.7b:free",endpointUrl:"https://openrouter.ai/api/v1/chat/completions",apiKey:"fake-test-key"},systemPrompt:"public",messages:[]});assert.equal(calls,1);}finally{globalThis.fetch=original;}
});
test("Venice and OpenAI adapters enforce bounded outputs without any live paid test calls",async()=>{
  const original=globalThis.fetch,limits:number[]=[];globalThis.fetch=(async(_url,init)=>{const b=JSON.parse(String(init?.body));limits.push(b.max_tokens??b.max_output_tokens);assert.ok(init?.signal);return new Response(JSON.stringify({output_text:"ok",choices:[{message:{content:"ok"}}]}));})as typeof fetch;
  try{const r={config:{enabled:true,model:"fixture",endpointUrl:"https://fixture.invalid",apiKey:"fake-test-key",maxOutputTokens:512},systemPrompt:"public",messages:[]};await invokeVeniceProvider(r);await invokeOpenAiProvider(r);assert.deepEqual(limits,[512,512]);}finally{globalThis.fetch=original;}
});
