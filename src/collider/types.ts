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

export type Rc1AuthContext = {
  network_id: number;
  l1_id: Hex32;
  chain_id: Hex32;
  network_domain: Hex32;
  domain_configured: boolean;
  last_accepted_height: number;
  max_intent_lifetime_blocks: number;
  eip712: {
    name: string;
    version: string;
    uses_chain_id: boolean;
    chain_id?: string;
    domain_separator_field: string;
  };
  user?: {
    user_id: Hex32;
    canonical_wallet_user: boolean;
    accepted_next_nonce: number;
    next_available_nonce: number;
  };
  [key: string]: unknown;
};

export type PreparedSignedIntent = {
  native_intent_signing?: { evm_chain_id: number; epoch: number };
  signer: Hex32;
  nonce: number;
  issued_at_height: number;
  valid_until_height: number;
  action: string;
  details: string;
  payload_hash: Hex32;
  network_domain: Hex32;
  digest: Hex32;
  op_b64: string;
  typed_data: unknown;
};

export type SubmitSignedIntentArgs = {
  signer: Hex32;
  nonce: number;
  issued_at_height: number;
  valid_until_height: number;
  op_b64: string;
  signature: string;
};

export type SubmittedSignedIntent = {
  accepted: boolean;
  op_id: Hex32;
  signer: Hex32;
  nonce: number;
};

export type SignedThrowStatus =
  | "throw_accepted"
  | "authenticated_business_rejected"
  | "pending"
  | "expired";

export type SignedThrowResult = {
  status: SignedThrowStatus;
  signer: Hex32;
  nonce: number;
  payloadHash: Hex32;
  opId: Hex32 | null;
  throwId: Hex32 | null;
  authenticatedAtHeight: number | null;
  acceptedAtHeight: number | null;
  submitError: string | null;
};

export type Rc1ClientOptions = {
  expectedSigningChainId?: number | null;
  expectedNetworkDomain?: string | null;
  expectedNetworkId?: number | null;
  expectedL1Id?: string | null;
  expectedChainId?: string | null;
  intentTtlBlocks?: number;
  reconcilePollMs?: number;
  reconcileTimeoutMs?: number;
  intentStateFile?: string | null;
};

export type BridgeAssetPin = {
  tokenAddress: string;
  policyHash: Hex32;
  minWithdrawalAmount: string;
};

export type BridgeWithdrawalSettings = {
  cRpc: string;
  expectedEvmChainId: number;
  custodyContract: string;
  routeId: Hex32;
  expectedAttestor: string;
  assets: Record<string, BridgeAssetPin>;
};

export type BridgeWithdrawalArgs = {
  asset: Hex32;
  user: Hex32;
  amount: string;
  withdrawalNonce: number;
  originRefId: Hex32;
};

export type BridgeWithdrawalPreview = {
  attestor_required_after_acceptance: boolean;
  custody_digest: Hex32;
  custody_typed_data: unknown;
  expected_attestor_after_acceptance: string;
  expected_user_signer: string;
  origin_ref_id: Hex32;
  policy_hash: Hex32;
  request_id: Hex32;
  route_id: Hex32;
  user_custody_signature_required: boolean;
  withdrawal_nonce: number;
};

export type BridgeWithdrawalResult = {
  status: "withdrawal_reserved" | "authenticated_business_rejected" | "pending" | "expired";
  signer: Hex32;
  nonce: number;
  payloadHash: Hex32;
  opId: Hex32 | null;
  requestId: Hex32;
  authenticatedAtHeight: number | null;
  reservedAtHeight: number | null;
  balanceBefore: string;
  balanceAfter: string | null;
  submitError: string | null;
};

export type BridgeWithdrawalObservation = {
  requestId: Hex32;
  status: string;
  asset: Hex32;
  amount: string;
  user: Hex32;
  createdHeight: number;
  terminalHeight: number | null;
  terminalTs: number | null;
  acceptedBalance: string;
  pendingLiability: string;
  recognizedCollateral: string;
  evmReceipt: {
    txHash: Hex32;
    status: number;
    blockNumber: number;
    blockHash: Hex32;
    exactTransferVerified: boolean;
  } | null;
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
