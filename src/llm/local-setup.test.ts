import assert from "node:assert/strict";
import test from "node:test";
import { buildLocalManagerSetupPlan, recommendOllamaModelForMemory } from "./local-setup.js";

test("recommendOllamaModelForMemory tiers Qwen size by RAM", () => {
  assert.equal(recommendOllamaModelForMemory(8 * 1024 ** 3), "qwen3:1.7b");
  assert.equal(recommendOllamaModelForMemory(16 * 1024 ** 3), "qwen3:4b");
  assert.equal(recommendOllamaModelForMemory(32 * 1024 ** 3), "qwen3:8b");
});

test("buildLocalManagerSetupPlan exposes desktop auto-setup for Ollama", () => {
  const plan = buildLocalManagerSetupPlan({ platform: "win32", arch: "x64", cpuCount: 12, totalMemoryBytes: 32 * 1024 ** 3 });
  assert.equal(plan.recommendedPlanId, "ollama");
  assert.equal(plan.machine.platform, "win32");
  assert.equal(plan.options[0]?.planId, "ollama");
  assert.equal(plan.options[0]?.model, "qwen3:8b");
  assert.equal(plan.options[0]?.autoSetupSupported, true);
  assert.match(plan.note, /Auto Connect checks the default local manager ports first/i);
});

test("buildLocalManagerSetupPlan keeps Linux on the guided manual path", () => {
  const plan = buildLocalManagerSetupPlan({ platform: "linux", arch: "x64", cpuCount: 8, totalMemoryBytes: 12 * 1024 ** 3 });
  assert.equal(plan.options[0]?.planId, "ollama");
  assert.equal(plan.options[0]?.model, "qwen3:1.7b");
  assert.equal(plan.options[0]?.autoSetupSupported, false);
  assert.match(plan.options[0]?.installHint || "", /guided manual path/i);
});
