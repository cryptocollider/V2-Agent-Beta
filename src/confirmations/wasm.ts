import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Worker } from "node:worker_threads";
import { decodeGameResult, type DecodedGameResult } from "../sim/decode.js";
import { CANDIDATE_WASM_SHA256 } from "./contract.js";
// Exact binary ABI; no JSON re-encode and no server-provided artifact URL.
const WORKER = [
 'const {parentPort,workerData}=require("node:worker_threads");',
 '(async()=>{const {instance}=await WebAssembly.instantiate(workerData.wasm,{});',
 'const w=instance.exports;let ip,op,ol;const u32=x=>x>>>0;try{',
 'ip=u32(w.sim_core_alloc(workerData.input.length));',
 'if(ip+workerData.input.length>w.memory.buffer.byteLength)throw Error("input bounds");',
 'new Uint8Array(w.memory.buffer,ip,workerData.input.length).set(workerData.input);',
 'op=u32(w.sim_core_run(ip,workerData.input.length));ol=u32(w.sim_core_last_len());',
 'if(!ol||ol>workerData.maxOutput||op+ol>w.memory.buffer.byteLength)throw Error("output bounds");',
 'const out=new Uint8Array(w.memory.buffer,op,ol).slice();parentPort.postMessage({out},[out.buffer]);',
 '}finally{if(op!==undefined&&ol)w.sim_core_free(op,ol);if(ip!==undefined)w.sim_core_free(ip,workerData.input.length);}',
 '})().catch(()=>parentPort.postMessage({error:"candidate WASM execution failed"}));',
].join("\n");
export type ConfirmationResult = { bytes: Buffer; result: DecodedGameResult };
export async function runFrozenWasm(wasmPath: string, input: Uint8Array, timeoutMs = 10000): Promise<ConfirmationResult> {
  const wasm = await readFile(wasmPath);
  if (createHash("sha256").update(wasm).digest("hex") !== CANDIDATE_WASM_SHA256) throw new Error("unreviewed confirmation WASM artifact");
  if (input.length > 1_048_576 || timeoutMs < 1 || timeoutMs > 60000) throw new Error("confirmation compute bound exceeded");
  const output = await new Promise<Buffer>((resolve, reject) => {
    const worker = new Worker(WORKER, { eval: true, workerData: { wasm, input, maxOutput: 16 * 1024 * 1024 },
      resourceLimits: { maxOldGenerationSizeMb: 128 } });
    const timer = setTimeout(() => { void worker.terminate(); reject(new Error("confirmation compute timed out")); }, timeoutMs);
    const cleanup = () => { clearTimeout(timer); void worker.terminate(); };
    worker.once("message", (message: { out?: Uint8Array; error?: string }) => {
      cleanup(); if (message.out) resolve(Buffer.from(message.out)); else reject(new Error("candidate WASM execution failed"));
    });
    worker.once("error", () => { cleanup(); reject(new Error("candidate WASM worker failed")); });
    worker.once("exit", code => { clearTimeout(timer); if (code !== 0) reject(new Error("candidate WASM worker exited")); });
  });
  const result = decodeGameResult(output);
  if (result.snapshot_hashes.length < 1) throw new Error("v2 result missing terminal digest");
  return { bytes: output, result };
}
