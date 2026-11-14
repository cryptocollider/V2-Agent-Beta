import assert from "node:assert/strict";
import test from "node:test";
import { normalizeSettings } from "./settings.js";

test("map priorities normalize canonical map IDs and accept only integers 1–10", () => {
  const id="ab".repeat(32);
  assert.deepEqual(normalizeSettings({mapPriorities:{['0x'+id.toUpperCase()]:10, bad:7, ['11'.repeat(32)]:0,
    ['22'.repeat(32)]:11, ['33'.repeat(32)]:1.5, ['44'.repeat(32)]:"10" as any}}).mapPriorities, {[id]:10});
  assert.deepEqual(normalizeSettings({}).mapPriorities, {});
});

test("normalizeSettings collapses maxThrowUsd and maxSingleThrowUsd into one effective cap", () => {
  const settings = normalizeSettings({ maxThrowUsd: 100, maxSingleThrowUsd: 12 });

  assert.equal(settings.maxThrowUsd, 12);
  assert.equal(settings.maxSingleThrowUsd, 12);
});

test("normalizeSettings keeps the legacy single-throw cap when the canonical max is absent", () => {
  const settings = normalizeSettings({ maxThrowUsd: null, maxSingleThrowUsd: 17 });

  assert.equal(settings.maxThrowUsd, 17);
  assert.equal(settings.maxSingleThrowUsd, 17);
});

test("normalizeSettings preserves a trimmed game allowlist", () => {
  const settings = normalizeSettings({ allowedGameIds: [" 0xAA ", "", "0xbb"] });

  assert.deepEqual(settings.allowedGameIds, ["0xAA", "0xbb"]);
});

test("normalizeSettings preserves a valid exact base cap and fails invalid text closed", () => {
  assert.equal(normalizeSettings({ maxSingleThrowBase: "8750000000000000" }).maxSingleThrowBase, "8750000000000000");
  assert.equal(normalizeSettings({ maxSingleThrowBase: "8.75e15" }).maxSingleThrowBase, "0");
});
