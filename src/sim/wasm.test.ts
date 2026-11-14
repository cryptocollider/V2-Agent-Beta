import assert from "node:assert/strict";
import test from "node:test";
import type { SimRunInput } from "../collider/types.js";
import { createVizRuntime } from "./wasm.js";

test("Arena early completion finalizes below the cap and stalled/invalid sessions fail closed", async () => {
  const memory = { buffer: new ArrayBuffer(65536) };
  let steps = 0, destroyed = 0, status = 2;
  const exports = { memory, sim_core_alloc_viz: () => 128, sim_core_free_viz: () => {},
    sim_core_last_len_viz: () => 1, sim_begin_json: () => 1,
    sim_step: () => { steps++; return 1; }, sim_status: () => status,
    sim_destroy: () => { destroyed++; return 1; }, sim_finalize: () => 16 };
  const input = { game: { frame_cap: 8000 } } as SimRunInput;
  const runtime = createVizRuntime(exports);
  assert.equal((await runtime.runToFinalize(input)).length, 1);
  assert.equal(steps, 1);
  status = 1;
  await assert.rejects(runtime.runToFinalize(input), /did not advance/);
  assert.equal(destroyed, 1);
  await assert.rejects(createVizRuntime({ ...exports, sim_begin_json: () => 0 }).runToFinalize(input), /rejected/);
});

test("gameplay yields to RPC/timer work without interleaving serialized WASM simulations", async () => {
  const memory = { buffer: new ArrayBuffer(65536) };
  let frame = 0, active = false, timerWhileActive = 0, finalized = 0;
  const runtime = createVizRuntime({ memory,
    sim_core_alloc_viz: () => 128, sim_core_free_viz: () => {}, sim_core_last_len_viz: () => 2,
    sim_begin_json: () => { assert.equal(active, false); active = true; frame = 0; return 1; },
    sim_step: () => { const until = performance.now() + 2; while (performance.now() < until) { /* mock compute */ }
      frame += 32; return frame; },
    sim_finalize: () => { assert.equal(active, true); active = false; finalized++;
      new Uint8Array(memory.buffer, 16, 2).set([7, 9]); return 16; },
  });
  const timer = setInterval(() => { if (active) timerWhileActive++; }, 1);
  try {
    const input = { game: { frame_cap: 512 } } as SimRunInput;
    const outputs = await Promise.all([runtime.runToFinalize(input), runtime.runToFinalize(input)]);
    assert.equal(finalized, 2); assert.ok(timerWhileActive >= 2);
    for (const output of outputs) assert.deepEqual([...output], [7, 9]);
  } finally { clearInterval(timer); }
});
