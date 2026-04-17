import assert from "node:assert/strict";
import test from "node:test";
import type { SimRunInput } from "../collider/types.js";
import { buildPriceLookupFromSimInput, buildScenarioSettlementView } from "./prediction-settlement.js";

function hexBytes(hex: string): number[] {
  const clean = hex.replace(/^0x/, "");
  return clean.match(/../g)?.map((part) => Number.parseInt(part, 16)) ?? [];
}

test("buildScenarioSettlementView resolves byte-array outcome throw ids", () => {
  const userHex = "aa".repeat(32);
  const assetHex = "01".repeat(32);
  const throwHex = "11".repeat(32);

  const input: SimRunInput = {
    game: {
      min_throws: 1,
      idle_blocks: 1,
      anti_snipe_window: 0,
      max_extensions: 0,
      max_age_blocks: 100,
      entry_gap_frames: 10,
      frame_dt_ms: 16,
      mass_scale: 1,
      frame_cap: 2000,
      throw_min_value: "100000000",
      name: "test",
      no_winner_policy: "Refund",
      last_frame_teleport: 0,
    },
    map: {
      geometry_objects: [],
      overtime: null,
      name: "test-map",
      version: 1,
      physicsConfig: {
        pixels_per_meter: 1,
        mass_multiplier: 1,
        bounds: [0, 0, 100, 100],
        input_bounds: [0, 0, 100, 100],
        vis_bounds: [100, 100],
        vel_bounds: [0, 100, 100],
        base_gravity_x: 0,
        base_gravity_y: 0,
        engine_type: 0,
        ball_ccd: false,
        slammer_frames: 0,
      },
    },
    throws: [
      {
        id: hexBytes(throwHex) as any,
        user: hexBytes(userHex) as any,
        asset: hexBytes(assetHex) as any,
        amount: "100000000",
        price_epoch: 1,
        mass_usd: 1,
        value_usd_e8: "100000000",
        enter_frame: 12,
        init_pose: { pos: { x: 10, y: 10 }, angle_rad: 0 },
        init_linvel: { x: 1, y: 1 },
        init_angvel: 0,
        data_commit: null,
        accepted_at_height: 1,
      },
    ],
    assets: [
      {
        asset: assetHex,
        name: "USD Coin",
        symbol: "USDC",
        decimals: 8,
        radius_px: 10,
        mass_scale: 1,
        material: {
          density: 1,
          density_gWeight_mul: 1,
          friction: 0,
          friction_gWeight_mul: 1,
          restitution: 0,
          restitution_gWeight_mul: 1,
          linear_damping: 0,
          angular_damping: 0,
        },
        status: 1,
      },
    ],
    snap_every: 1,
    frame_cap_override: null,
  };

  const settlement = buildScenarioSettlementView({
    input,
    outcomes: [
      {
        throw_id: hexBytes(throwHex) as any,
        hole_type: 1,
        hole_i: 3,
        endFrame: 321,
      },
    ],
    priceLookup: buildPriceLookupFromSimInput(input),
  });

  const throwView = settlement.throwsById.get(throwHex);
  assert.ok(throwView);
  assert.equal(throwView?.holeType, 1);
  assert.equal(throwView?.holeIndex, 3);
  assert.equal(throwView?.endFrame, 321);
  assert.equal(settlement.finalFrame, 321);
});
