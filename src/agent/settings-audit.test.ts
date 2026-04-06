import assert from "node:assert/strict";
import test from "node:test";
import { buildSettingsAuditReport } from "./settings-audit.js";

test("settings audit exposes implemented and partial states", () => {
  const report = buildSettingsAuditReport({
    asset: "01".repeat(32),
    amount: "1000000",
    riskMode: "balanced",
    keepAssets: ["01".repeat(32)],
  });

  const assetEntry = report.matrix.find((entry) => entry.key === "asset");
  const riskEntry = report.matrix.find((entry) => entry.key === "riskMode");
  const keepEntry = report.matrix.find((entry) => entry.key === "keepAssets");

  assert.equal(assetEntry?.state, "implemented");
  assert.equal(riskEntry?.state, "partial");
  assert.equal(keepEntry?.state, "partial");
  assert.ok(report.counts.implemented > 0);
  assert.ok(report.counts.partial > 0);
});
