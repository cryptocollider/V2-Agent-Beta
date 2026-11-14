import assert from "node:assert/strict";
import test from "node:test";
import {assertLivePlayWindow} from "./play-window.js";
test("a deadline checked again after planning blocks a late signer invocation",()=>{
  let signed=0;const submit=(now:number)=>{assertLivePlayWindow(200,now);signed++;};
  assertLivePlayWindow(200,100);assert.throws(()=>submit(201),/no new signed throw/);assert.equal(signed,0);
  submit(199);assert.equal(signed,1);assert.throws(()=>submit(200));
});
test("invalid deadlines fail closed while normal unbounded callers retain behavior",()=>{
  assert.throws(()=>assertLivePlayWindow(NaN));assert.throws(()=>assertLivePlayWindow(Infinity));assertLivePlayWindow(undefined);
});
