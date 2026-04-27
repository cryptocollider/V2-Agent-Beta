import assert from "node:assert/strict";
import test from "node:test";
import type { GameListItem, SimRunInput } from "../collider/types.js";
import { buildAssetPlanningResult, buildEligibilityCompactCode, evaluateGamesForEligibility, getCandidateFilterReasons } from "./eligibility.js";
import type { AgentPolicy } from "../policy/schema.js";

const assetA = "01".repeat(32);
const assetB = "02".repeat(32);

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
      throw_min_value: "50",
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
        user: bytes("aa".repeat(32)) as any,
        asset: bytes(assetA) as any,
        amount: "100",
        price_epoch: 1,
        mass_usd: 5,
        value_usd_e8: "500000000",
        enter_frame: 0,
        init_pose: { pos: { x: 1, y: 1 }, angle_rad: 0 },
        init_linvel: { x: 1, y: 1 },
        init_angvel: 0,
        data_commit: null,
        accepted_at_height: 1,
      },
      {
        id: bytes("22".repeat(32)) as any,
        user: bytes("bb".repeat(32)) as any,
        asset: bytes(assetB) as any,
        amount: "100",
        price_epoch: 1,
        mass_usd: 10,
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
      { asset: bytes(assetA) as any, name: "A", symbol: "A", decimals: 0, radius_px: 1, mass_scale: 1, material: { density: 1, density_gWeight_mul: 1, friction: 1, friction_gWeight_mul: 1, restitution: 1, restitution_gWeight_mul: 1, linear_damping: 1, angular_damping: 1 }, status: 1 },
      { asset: bytes(assetB) as any, name: "B", symbol: "B", decimals: 0, radius_px: 1, mass_scale: 1, material: { density: 1, density_gWeight_mul: 1, friction: 1, friction_gWeight_mul: 1, restitution: 1, restitution_gWeight_mul: 1, linear_damping: 1, angular_damping: 1 }, status: 1 },
    ],
    snap_every: 1,
    frame_cap_override: null,
  };
}

function makeGame(): GameListItem {
  return {
    game_id: "ff".repeat(32),
    status: 1,
    name: "game",
    map_id: "ee".repeat(32),
    created_height: 1,
    last_throw_height: 4,
    throws: 2,
    stake: "1000000000",
    min_throws: 1,
    throw_min_value: "50",
  };
}

test("game minimum is enforced in USD units, not raw asset units", () => {
  const simInput = makeSimInput();
  const game = { ...makeGame(), throw_min_value: "100000000" };
  const policy: AgentPolicy = {
    enabled: true,
    reserveBalanceBase: "0",
    minThrowUsd: 11,
    maxThrowUsd: 11,
    maxSingleThrowUsd: 12,
  };

  const reasons = getCandidateFilterReasons({
    candidate: { asset: assetA, amount: "220" },
    chosenGame: game,
    policy,
    simInput,
    balances: { [assetA]: "1000" },
  });

  assert.ok(reasons.includes("below_game_min_throw"));
  assert.ok(!reasons.includes("below_min_throw_usd"));
});

test("asset planning stops early when game minimum exceeds current caps", () => {
  const simInput = makeSimInput();
  const planning = buildAssetPlanningResult({
    policy: {
      enabled: true,
      minThrowUsd: 11,
      maxThrowUsd: 11,
      maxSingleThrowUsd: 12,
      reserveBalanceBase: "0",
    },
    balances: { [assetA]: "1000" },
    simInput,
    defaultAsset: assetA,
    defaultAmount: "220",
    chosenGame: { ...makeGame(), throw_min_value: "100000000" },
  });

  assert.equal(planning.assetAmountPairs.length, 0);
  assert.ok(planning.globalReasons.includes("below_game_min_throw"));
});

test("candidate filters enforce max throw usd and balance diagnostics", () => {
  const simInput = makeSimInput();
  const game = makeGame();
  const policy: AgentPolicy = {
    enabled: true,
    maxThrowUsd: 8,
    reserveBalanceBase: "0",
  };

  const reasons = getCandidateFilterReasons({
    candidate: { asset: assetA, amount: "200" },
    chosenGame: game,
    policy,
    simInput,
    balances: { [assetA]: "150" },
  });

  assert.ok(reasons.includes("above_max_throw_usd"));
  assert.ok(reasons.includes("no_balance_for_amounts"));
});

test("asset planning can use fallback internal price hints for first-throw sizing", () => {
  const simInput = makeSimInput();
  simInput.throws = [simInput.throws[1]];
  const planning = buildAssetPlanningResult({
    policy: {
      enabled: true,
      minThrowUsd: 5,
      maxThrowUsd: 5,
      reserveBalanceBase: "0",
    },
    balances: { [assetA]: "1000" },
    simInput,
    defaultAsset: assetA,
    defaultAmount: "100",
    priceHintsUsdPerBase: { [assetA]: 0.05 },
  });

  assert.equal(planning.assetAmountPairs[0]?.asset, assetA);
  assert.ok(!planning.globalReasons.includes("missing_price_basis"));
});

test("asset planning prefers keep assets and demotes dispose assets", () => {
  const simInput = makeSimInput();
  const policy: AgentPolicy = {
    enabled: true,
    keepAssets: [assetA],
    disposeAssets: [assetB],
    allowedAssets: [assetA, assetB],
    minThrowUsd: 5,
    maxThrowUsd: 10,
    reserveBalanceBase: "0",
  };

  const planning = buildAssetPlanningResult({
    policy,
    balances: { [assetA]: "1000", [assetB]: "1000" },
    simInput,
    defaultAsset: assetA,
    defaultAmount: "100",
  });

  assert.equal(planning.assetAmountPairs[0]?.asset, assetA);
});

test("compact eligibility codes stay specific", () => {
  const base = {
    ts: new Date().toISOString(),
    selectedGameId: null,
    perGame: [],
    assetPlanning: [],
    notes: [],
    candidateFilterSummary: {
      reasonCounts: {},
      totalRawCandidates: 0,
      totalEligibleCandidates: 0,
      limitedCandidates: 0,
      plannedCandidates: 0,
    },
  };

  assert.equal(buildEligibilityCompactCode({ ...base, globalReasons: ["reserve_balance"] }), "NO-CAND/BAL");
  assert.equal(buildEligibilityCompactCode({ ...base, globalReasons: [], candidateFilterSummary: { ...base.candidateFilterSummary, reasonCounts: { below_game_min_throw: 1 } } }), "NO-CAND/MIN");
  assert.equal(buildEligibilityCompactCode({ ...base, globalReasons: [], candidateFilterSummary: { ...base.candidateFilterSummary, reasonCounts: { above_game_exposure: 1 } } }), "NO-CAND/RISK");
  assert.equal(buildEligibilityCompactCode({ ...base, globalReasons: ["search_budget_stop"] }), "NO-CAND/SEARCH");
  assert.equal(buildEligibilityCompactCode({ ...base, globalReasons: ["target_balance"] }), "TARGET/BAL");
  assert.equal(buildEligibilityCompactCode({ ...base, globalReasons: ["cooldown"] }), "COOLDOWN");
});

test("eligible game selection rotates toward least recently touched games", () => {
  const games: GameListItem[] = [
    { ...makeGame(), game_id: "aa".repeat(32), stake: "5000000000", throws: 6 },
    { ...makeGame(), game_id: "bb".repeat(32), stake: "1000000000", throws: 2 },
    { ...makeGame(), game_id: "cc".repeat(32), stake: "3000000000", throws: 4 },
  ];

  const { selectedGame } = evaluateGamesForEligibility(
    games,
    { enabled: true },
    {
      now: 10_000,
      cooldownMsPerGame: 100,
      recentGameTouches: {
        [games[0].game_id]: 9_900,
        [games[1].game_id]: 0,
        [games[2].game_id]: 5_000,
      },
      sessionThrowCounts: {
        [games[0].game_id]: 3,
        [games[1].game_id]: 0,
        [games[2].game_id]: 1,
      },
      maxThrowsPerGame: 99,
    },
  );

  assert.equal(selectedGame?.game_id, games[1].game_id);
});

