import assert from "node:assert/strict";
import test from "node:test";
import { normalizeSettings } from "./settings.js";

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
