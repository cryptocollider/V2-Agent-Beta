export type Hex32 = string;

export type Vec2 = {
  x: number;
  y: number;
};

export type Pose = {
  pos: Vec2;
  angle_rad: number;
};

export type PhysicsConfig = {
  pixels_per_meter: number;
  mass_multiplier: number;
  bounds: [number, number, number, number];
  input_bounds: [number, number, number, number];
  vis_bounds: [number, number];
  vel_bounds: [number, number, number];
  base_gravity_x: number;
  base_gravity_y: number;
  engine_type: number;
  ball_ccd: boolean;
  slammer_frames: number;
};

export type GameParams = {
  min_throws: number;
  idle_blocks: number;
  anti_snipe_window: number;
  max_extensions: number;
  max_age_blocks: number;
  entry_gap_frames: number;
  frame_dt_ms: number;
  mass_scale: number;
  frame_cap: number;
  throw_min_value: string;
  name: string;
  no_winner_policy: unknown;
  last_frame_teleport: number;
};

export type Material = {
  density: number;
  density_gWeight_mul: number;
  friction: number;
  friction_gWeight_mul: number;
  restitution: number;
  restitution_gWeight_mul: number;
  linear_damping: number;
  angular_damping: number;
};

export type AssetMeta = {
  asset: Hex32;
  name: string;
  symbol: string;
  decimals: number;
  radius_px: number;
  mass_scale: number;
  material: Material;
  status: number;
};

export type MapConfig = {
  geometry_objects: unknown[];
  overtime: unknown;
  tournament?: unknown | null;
  name: string;
  version: number;
  physicsConfig: PhysicsConfig;
};

export type ThrowRecord = {
  id: [number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number];
  user: [number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number];
  asset: [number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number];
  amount: string;
  price_epoch: number;
  mass_usd: number;
  value_usd_e8: string;
  enter_frame: number;
  init_pose: Pose;
  init_linvel: Vec2;
  init_angvel: number;
  data_commit: Hex32 | null;
  accepted_at_height: number;
};

export type SimRunInput = {
  game: GameParams;
  map: MapConfig;
  throws: ThrowRecord[];
  assets: AssetMeta[];
  snap_every: number;
  frame_cap_override: number | null;
};

export type GameListItem = {
  game_id: Hex32;
  status: number;
  name: string;
  map_id: Hex32;
  created_height: number;
  armed_at_height?: number | null;
  last_throw_height: number;
  close_deadline_height?: number | null;
  finalised_height?: number | null;
  settled_height?: number | null;
  throws: number;
  stake: string;
  min_throws: number;
  throw_min_value: string;
};

export type PlaceThrowArgs = {
  game_id: Hex32;
  user: Hex32;
  asset: Hex32;
  amount: string;
  init_pose: Pose;
  init_linvel: Vec2;
  init_angvel: number;
  data_commit: Hex32 | null;
};

export type AgentControlThrow = {
  x: number;
  y: number;
  angleDeg: number;
  speedPct: number;
  spinPct: number;
  asset: Hex32;
  amount: string;
};

export type PlannerSearchBudget = {
  maxCandidates?: number;
  maxMillis?: number;
  stopOnWinner?: boolean;
  winnerScoreThreshold?: number;
};

export type QueueScenario = {
  label: string;
  enterFrame: number;
  acceptedAtHeight: number;
  weight: number;
};

export type SyntheticThrowContext = {
  botUser: Hex32;
  gameId: Hex32;
  nextAcceptedHeight: number;
  syntheticThrowId?: Hex32;
};

export type PlannerCandidateResult = {
  scenario: QueueScenario;
  rawFinalizeBytes: Uint8Array;
  meta: Record<string, unknown>;
};
