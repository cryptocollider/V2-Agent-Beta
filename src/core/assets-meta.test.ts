import assert from "node:assert/strict";
import test from "node:test";
import { defaultDecimalsForAsset, normalizeAssetsMetaPayload } from "./assets-meta.js";

test("normalizeAssetsMetaPayload converts byte-array asset ids into hex keys", () => {
  const payload = [
    {
      asset: new Array(32).fill(1),
      symbol: "USDC",
      decimals: 6,
    },
    {
      asset: new Uint8Array(new Array(32).fill(3)),
      symbol: "CLC",
      decimals: 18,
    },
  ];

  const normalized = normalizeAssetsMetaPayload(payload);
  assert.deepEqual(Object.keys(normalized).sort(), ["01".repeat(32), "03".repeat(32)].sort());
  assert.equal(normalized["01".repeat(32)]?.symbol, "USDC");
  assert.equal(normalized["01".repeat(32)]?.decimals, 6);
  assert.equal(normalized["03".repeat(32)]?.symbol, "CLC");
  assert.equal(normalized["03".repeat(32)]?.decimals, 18);
});

test("defaultDecimalsForAsset accepts byte-array asset ids", () => {
  assert.equal(defaultDecimalsForAsset(new Array(32).fill(1)), 6);
  assert.equal(defaultDecimalsForAsset(new Uint8Array(new Array(32).fill(5))), 18);
});
