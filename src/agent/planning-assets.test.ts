import assert from "node:assert/strict";
import test from "node:test";
import type { SimRunInput } from "../collider/types.js";
import { enrichPlanningAssets, missingPlanningAssets } from "./planning-assets.js";
import { buildPriceHintsUsdPerBase, type ColliderClientLike } from "./loop.js";
import type { AgentPolicy } from "../policy/schema.js";
import { buildAssetPlanningResult, estimateBaseAmountForUsd, estimateCandidateUsd, getCandidateFilterReasons } from "./eligibility.js";
import { canonicalValueE8, exactPriceBasis } from "../core/price-basis.js";

const diem = "09".repeat(32), usdc = "01".repeat(32);
const meta = (id = diem) => ({ asset: [...Buffer.from(id, "hex")], name: "Mock DIEM", symbol: "DIEM", decimals: 18,
  radius_px: 38, mass_scale: 1, status: 3, material: { density: 1, density_gWeight_mul: 0, friction: 0,
    friction_gWeight_mul: 0, restitution: 0.9, restitution_gWeight_mul: 0, linear_damping: 0, angular_damping: 0 } });
const empty = () => ({ assets: [], throws: [], game: { name: "empty" }, map: { name: "test" },
  snap_every: 20, frame_cap_override: null } as unknown as SimRunInput);

test("planning enriches only missing allowed assets and never mutates canonical/frozen source values", () => {
  const canonical = empty(), catalog = [meta(), meta(usdc)];
  const bytes = JSON.stringify(canonical), catalogBytes = JSON.stringify(catalog);
  const planning = enrichPlanningAssets(canonical, catalog, [diem]);
  assert.notEqual(planning, canonical); assert.equal(planning.assets.length, 1);
  assert.deepEqual(planning.assets[0].asset, meta().asset);
  assert.equal(JSON.stringify(canonical), bytes); assert.equal(JSON.stringify(catalog), catalogBytes);
  assert.deepEqual(missingPlanningAssets(planning, [diem]), []);
  (planning.assets[0].material as any).density = 99;
  assert.equal(catalog[0].material.density, 1);
});

test("included canonical asset snapshots are not replaced by current catalog physics", () => {
  const canonical = empty();
  canonical.assets.push({ ...meta(), decimals: 8, mass_scale: 9 } as any);
  const planning = enrichPlanningAssets(canonical, [meta(), meta(usdc)], [diem, usdc]);
  assert.equal(planning.assets.length, 2); assert.equal(planning.assets[0].decimals, 8);
  assert.equal(planning.assets[0].mass_scale, 9); assert.equal(canonical.assets.length, 1);
});

test("missing/invalid/dormant metadata does not get guessed or silently activated", () => {
  for (const row of [{ ...meta(), decimals: undefined }, { ...meta(), decimals: 1.5 }, { ...meta(), status: 0 },
    { ...meta(), material: { density: 1 } }, { ...meta(), radius_px: -1 }]) {
    const input = empty(); assert.equal(enrichPlanningAssets(input, [row], [diem]), input);
  }
  assert.throws(() => enrichPlanningAssets(empty(), [meta(), meta()], [diem]), /duplicate/);
});

test("fresh oracle prices work for enriched empty games; stale/network-failed feeds cannot revive cached or historical prices", async () => {
  const canonical = empty(), input = enrichPlanningAssets(canonical, [meta()], [diem]);
  const client = { listOracleFeeds: async () => [{ asset: "0x" + diem, usable: true,
    current: { price_e8: "180000000000", published_at_ts: 1792526500 } }],
    getSimInput: async () => { throw new Error("historical fallback must not run"); } } as unknown as ColliderClientLike;
  const params = { client, games: [{ game_id: "old-game", throws: 99 }] as any, selectedGameId: "empty-game",
    selectedSimInput: input, policy: { allowedAssets: [diem] } as AgentPolicy, defaultAsset: diem };
  const fresh = await buildPriceHintsUsdPerBase(params);
  assert.equal(fresh[diem], 1800 / 1e18); assert.equal(canonical.assets.length, 0);
  const amount = estimateBaseAmountForUsd(input,diem,10,fresh)!;
  assert.equal(amount,'5555555555555556');
  assert.equal(canonicalValueE8(amount,fresh,diem),1000000000n);
  assert.equal(canonicalValueE8('5555555555555555',fresh,diem),999999999n);
  const game={game_id:'aa'.repeat(32),throw_min_value:'1000000000'} as any;
  const policy={enabled:true,maxThrowUsd:10,maxSingleThrowBase:amount} as AgentPolicy;
  assert.deepEqual(getCandidateFilterReasons({candidate:{asset:diem,amount},chosenGame:game,policy,simInput:input,
    botUser:'bb'.repeat(32),balances:{[diem]:'55555555555555555'},priceHintsUsdPerBase:fresh}),[]);
  input.throws.push({ asset: meta().asset, amount: "1000000000000000000", value_usd_e8: "999999999999",
    price_epoch: 999999999999 } as any);
  assert.equal(estimateCandidateUsd("1000000000000000000", diem, input, fresh), 1800);
  client.listOracleFeeds = async () => [{ asset: "0x" + diem, usable: false, current: { price_e8: "180000000000" } }];
  assert.deepEqual(await buildPriceHintsUsdPerBase(params), {});
  const unavailable = await buildPriceHintsUsdPerBase(params);
  assert.equal(exactPriceBasis(unavailable,diem),null);
  assert.equal(estimateCandidateUsd("1000000000000000000", diem, input, unavailable), null);
  const planning = buildAssetPlanningResult({ simInput: input, defaultAsset: diem,
    defaultAmount: "55555555555556", balances: { [diem]: "55555555555555555" },
    policy: { enabled: true, allowedAssets: [diem], minThrowUsd: 0.1, maxThrowUsd: 1.1 },
    priceHintsUsdPerBase: unavailable });
  assert.equal(planning.assetAmountPairs.length, 0);
  assert.ok(planning.globalReasons.includes("missing_price_basis"));
  client.listOracleFeeds = async () => { throw new Error("network unavailable"); };
  assert.deepEqual(await buildPriceHintsUsdPerBase(params), {});
  assert.deepEqual(await buildPriceHintsUsdPerBase({ ...params, client: { ...client, listOracleFeeds: async () => [] } }), {});
});
