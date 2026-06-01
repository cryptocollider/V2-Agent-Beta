import assert from "node:assert/strict";
import test from "node:test";
import type { AgentControlThrow, QueueScenario, SimRunInput } from "./types.js";
import { buildSyntheticThrowRecord } from "./throw-builder.js";

const assetUsdc = "01".repeat(32);
const assetAvax = "05".repeat(32);
const botUser = "aa".repeat(32);
const gameId = "bb".repeat(32);

function bytes(hex: string): number[] {
  return hex.match(/../g)?.map((value) => parseInt(value, 16)) ?? [];
}

function makeSimInput(): SimRunInput {
  return {
    game: {
      min_throws: 1,
      idle_blocks: 1,
      anti_snipe_window: 1,
      max_extensions: 1,
      max_age_blocks: 1,
      entry_gap_frames: 10,
      frame_dt_ms: 16,
      mass_scale: 1,
      frame_cap: 600,
      throw_min_value: "10000000",
      name: "test",
      no_winner_policy: "Refund",
      last_frame_teleport: 0,
    },
    map: {
      geometry_objects: [],
      overtime: null,
      tournament: null,
      name: "map",
      version: 1,
      physicsConfig: {
        pixels_per_meter: 1,
        mass_multiplier: 1,
        bounds: [0, 0, 100, 100],
        input_bounds: [0, 0, 100, 100],
        vis_bounds: [100, 100],
        vel_bounds: [100, 100, 10],
        base_gravity_x: 0,
        base_gravity_y: 0,
        engine_type: 0,
        ball_ccd: false,
        slammer_frames: 1,
      },
    },
    throws: [
      {
        id: bytes("11".repeat(32)) as any,
        user: bytes(botUser) as any,
        asset: bytes(assetUsdc) as any,
        amount: "7000000",
        price_epoch: 1,
        mass_usd: 7,
        value_usd_e8: "700000000",
        enter_frame: 0,
        init_pose: { pos: { x: 1, y: 1 }, angle_rad: 0 },
        init_linvel: { x: 1, y: 1 },
        init_angvel: 0,
        data_commit: null,
        accepted_at_height: 1,
      },
      {
        id: bytes("22".repeat(32)) as any,
        user: bytes(botUser) as any,
        asset: bytes(assetAvax) as any,
        amount: "625000000000000000",
        price_epoch: 1,
        mass_usd: 11.5,
        value_usd_e8: "1000000000",
        enter_frame: 10,
        init_pose: { pos: { x: 2, y: 2 }, angle_rad: 0 },
        init_linvel: { x: 1, y: 1 },
        init_angvel: 0,
        data_commit: null,
        accepted_at_height: 2,
      },
    ],
    assets: [
      { asset: bytes(assetUsdc) as any, name: "USDC", symbol: "USDC", decimals: 6, radius_px: 1, mass_scale: 1, material: { density: 1, density_gWeight_mul: 1, friction: 1, friction_gWeight_mul: 1, restitution: 1, restitution_gWeight_mul: 1, linear_damping: 1, angular_damping: 1 }, status: 1 },
      { asset: bytes(assetAvax) as any, name: "AVAX", symbol: "AVAX", decimals: 18, radius_px: 1, mass_scale: 1.15, material: { density: 1, density_gWeight_mul: 1, friction: 1, friction_gWeight_mul: 1, restitution: 1, restitution_gWeight_mul: 1, linear_damping: 1, angular_damping: 1 }, status: 1 },
    ],
    snap_every: 1,
    frame_cap_override: null,
  };
}

const scenario: QueueScenario = {
  label: "expected",
  enterFrame: 20,
  acceptedAtHeight: 3,
  weight: 1,
};

test("synthetic throw valuation uses same-asset template data when available", () => {
  const simInput = makeSimInput();
  const control: AgentControlThrow = {
    x: 10,
    y: 10,
    angleDeg: 0,
    speedPct: 50,
    spinPct: 0,
    asset: assetAvax,
    amount: "125000000000000000",
  };

  const synthetic = buildSyntheticThrowRecord(gameId, control, simInput, botUser, scenario);
  assert.equal(String(synthetic.value_usd_e8), "200000000");
  assert.equal(Number(synthetic.mass_usd), 2.3);
});

test("synthetic throw valuation uses explicit price hints when no same-asset throw exists yet", () => {
  const simInput = makeSimInput();
  simInput.throws = [];
  const control: AgentControlThrow = {
    x: 10,
    y: 10,
    angleDeg: 0,
    speedPct: 50,
    spinPct: 0,
    asset: assetAvax,
    amount: "125000000000000000",
  };

  const synthetic = buildSyntheticThrowRecord(
    gameId,
    control,
    simInput,
    botUser,
    scenario,
    { [assetAvax]: 1.6e-17 },
  );

  assert.equal(String(synthetic.value_usd_e8), "200000000");
  assert.equal(Number(synthetic.mass_usd), 2.3);
});
