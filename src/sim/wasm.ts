import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import type { SimRunInput } from "../collider/types.js";

type WasmMemoryLike = {
  buffer: ArrayBuffer;
};

type WasmExports = {
  memory: WasmMemoryLike;
  sim_core_alloc_viz: (size: number) => number;
  sim_core_last_len_viz: () => number;
  sim_core_free_viz: (ptr: number, cap: number) => void;
  sim_begin_json: (ptr: number, len: number) => number;
  sim_step: (handle: number, steps: number) => number;
  sim_status?: (handle: number) => number;
  sim_destroy?: (handle: number) => number;
  sim_finalize: (handle: number) => number;
};

export type WasmVizRuntime = {
  forGame?(gameId:string):Promise<WasmVizRuntime>;
  runToFinalize(input: SimRunInput, stepChunk?: number): Promise<Uint8Array>;
};

function encodeJson(obj: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj));
}

function toU32(n: number): number {
  return n >>> 0;
}

export async function loadVizWasm(wasmPath: string, expectedSha256?:string): Promise<WasmVizRuntime> {
  const bytes = await readFile(wasmPath);
  if(expectedSha256&&createHash("sha256").update(bytes).digest("hex")!==expectedSha256)throw Error("simulator bytes changed before execution");
  const instantiated = await globalThis.WebAssembly.instantiate(bytes, {});
  const instance = instantiated.instance as { exports: unknown };
  const wasm = instance.exports as WasmExports;
  return createVizRuntime(wasm);
}

/** Serial gameplay runtime; yields do not change simulation steps or frozen confirmation execution. */
export function createVizRuntime(wasm: WasmExports): WasmVizRuntime {

  function writeBytes(data: Uint8Array): { ptr: number; len: number } {
    const rawPtr = wasm.sim_core_alloc_viz(data.length);
    const ptr = toU32(rawPtr);
    const len = toU32(data.length);

    const memBuf = wasm.memory.buffer;
    if (ptr + len > memBuf.byteLength) {
      throw new Error(
        `writeBytes out of bounds: ptr=${ptr} len=${len} mem=${memBuf.byteLength}`,
      );
    }

    const mem = new Uint8Array(memBuf, ptr, len);
    mem.set(data);
    return { ptr, len };
  }

  function readOwnedBytes(ptrRaw: number, lenRaw: number): Uint8Array {
    const ptr = toU32(ptrRaw);
    const len = toU32(lenRaw);

    const memBuf = wasm.memory.buffer;
    if (ptr + len > memBuf.byteLength) {
      throw new Error(
        `readOwnedBytes out of bounds: ptr=${ptr} len=${len} mem=${memBuf.byteLength}`,
      );
    }

    const mem = new Uint8Array(memBuf, ptr, len);
    const out = new Uint8Array(len);
    out.set(mem);

    wasm.sim_core_free_viz(ptr, len);
    return out;
  }

  async function runToFinalizeUnsafe(input: SimRunInput, stepChunk = 32): Promise<Uint8Array> {
    const jsonText = JSON.stringify(input);
    const encoded = new TextEncoder().encode(jsonText);
    const { ptr, len } = writeBytes(encoded);

    let handle = 0;
    try {
      handle = toU32(wasm.sim_begin_json(ptr, len));
    } catch (err) {
      wasm.sim_core_free_viz(ptr, len);
      await writeFile("./debug-last-sim-input.json", jsonText, "utf8");
      throw new Error(
        `sim_begin_json failed; wrote debug-last-sim-input.json. Original error: ${String(err)}`,
      );
    }

    // sim_begin_json has already consumed the JSON payload, so keeping the
    // input buffer alive leaks WASM heap across long-running planner sessions.
    wasm.sim_core_free_viz(ptr, len);
    if (handle === 0) throw new Error("sim_begin_json rejected the simulation input");

    const frameCap =
      input.frame_cap_override ??
      input.game.frame_cap ??
      8000;

    let currentFrame = 0;
    let lastYield = performance.now();
    while (currentFrame < frameCap) {
      const previousFrame = currentFrame;
      currentFrame = toU32(wasm.sim_step(handle, stepChunk));
      // Arena 0.2 can finish naturally before the requested frame cap.
      // Status 2 is canonical completion, not a reason to keep stepping forever.
      const status = wasm.sim_status?.(handle);
      if (status === 2) break;
      if (status === 0 || currentFrame <= previousFrame) {
        wasm.sim_destroy?.(handle);
        throw new Error("simulation session did not advance or became invalid");
      }
      if (currentFrame >= frameCap) break;
      if (performance.now() - lastYield >= 8) {
        await yieldToEventLoop();
        lastYield = performance.now();
      }
    }

    const outPtr = toU32(wasm.sim_finalize(handle));
    const outLen = toU32(wasm.sim_core_last_len_viz());

    if (outLen === 0) {
      throw new Error(`sim_finalize returned zero-length output; ptr=${outPtr}`);
    }

    return readOwnedBytes(outPtr, outLen);
  }

  let runQueue = Promise.resolve();

  async function runToFinalize(input: SimRunInput, stepChunk = 32): Promise<Uint8Array> {
    const task = runQueue.then(async () => {
      // Promise-only candidate queues otherwise drain as one long microtask chain,
      // starving confirmation reads, HTTP replies and timeout processing.
      await yieldToEventLoop();
      return runToFinalizeUnsafe(input, stepChunk);
    });
    runQueue = task.then(() => undefined, () => undefined);
    return task;
  }

  return { runToFinalize };
}
