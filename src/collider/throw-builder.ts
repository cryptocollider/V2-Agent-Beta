import type {
    AgentControlThrow,
    Hex32,
    PlaceThrowArgs,
    QueueScenario,
    SimRunInput,
    ThrowRecord,
  } from "./types.js";
  
  type Byte32 = number[];
  
  function clamp(v: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, v));
  }
  
  function deepClone<T>(v: T): T {
    return JSON.parse(JSON.stringify(v)) as T;
  }
  
  export function hex32ToBytes(hex: string): Byte32 {
    const clean = String(hex).trim().replace(/^0x/i, "").toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(clean)) {
      throw new Error(`invalid hex32: ${hex}`);
    }
    const out: number[] = [];
    for (let i = 0; i < 64; i += 2) {
      out.push(parseInt(clean.slice(i, i + 2), 16));
    }
    return out;
  }
  
  export function bytesToHex32(bytes: ArrayLike<number>): Hex32 {
    if (!bytes || bytes.length !== 32) {
      throw new Error(`expected 32 bytes, got ${bytes?.length ?? "null"}`);
    }
    let out = "";
    for (let i = 0; i < 32; i++) {
      out += Number(bytes[i]).toString(16).padStart(2, "0");
    }
    return out;
  }
  
  function getInputBounds(simInput: SimRunInput): [number, number, number, number] {
    return simInput.map.physicsConfig.input_bounds;
  }
  
  function getVelBounds(simInput: SimRunInput): [number, number, number] {
    return simInput.map.physicsConfig.vel_bounds;
  }
  
  export function controlThrowToPlaceThrowArgs(
    gameId: Hex32,
    user: Hex32,
    control: AgentControlThrow,
    simInput: SimRunInput,
  ): PlaceThrowArgs {
    const ib = getInputBounds(simInput);
    const vb = getVelBounds(simInput);
  
    const x = clamp(control.x, ib[0], ib[2]);
    const y = clamp(control.y, ib[1], ib[3]);
  
    const angleRad = (control.angleDeg * Math.PI) / 180;
    const speedT = clamp(control.speedPct, 0, 100) / 100;
    const spinT = clamp(control.spinPct, -100, 100) / 100;
  
    const vx = vb[0] * speedT * Math.cos(angleRad);
    const vy = vb[1] * speedT * Math.sin(angleRad);
    const angVel = vb[2] * spinT;
  
    return {
      game_id: gameId,
      user,
      asset: control.asset,
      amount: control.amount,
      init_pose: {
        pos: { x, y },
        angle_rad: angleRad,
      },
      init_linvel: { x: vx, y: vy },
      init_angvel: angVel,
      rec_commit: null,
      rec_len: null,
    };
  }
  
  export function nextEnterFrame(simInput: SimRunInput): number {
    const gap = simInput.game?.entry_gap_frames ?? 10;
    return (simInput.throws?.length ?? 0) * gap;
  }
  
  export function buildQueueScenarioSet(
    simInput: SimRunInput,
    nextAcceptedHeight: number,
  ): QueueScenario[] {
    const gap = simInput.game?.entry_gap_frames ?? 10;
    const base = nextEnterFrame(simInput);
  
    return [
      {
        label: "expected",
        enterFrame: base,
        acceptedAtHeight: nextAcceptedHeight,
        weight: 1.0,
      },
      {
        label: "slip_1",
        enterFrame: base + gap,
        acceptedAtHeight: nextAcceptedHeight + 1,
        weight: 0.35,
      },
    ];
  }
  
  /**
   * Minimal fallback template only used if a game has zero throws.
   * Keep exact wire shape that sim_input expects.
   */
  function fallbackTemplateThrow(): ThrowRecord {
    return {
      accepted_at_height: 361,
      amount: "26400000000000",
      asset: [
        3, 3, 3, 3, 3, 3, 3, 3,
        3, 3, 3, 3, 3, 3, 3, 3,
        3, 3, 3, 3, 3, 3, 3, 3,
        3, 3, 3, 3, 3, 3, 3, 3,
      ],
      enter_frame: 0,
      id: [
        47, 119, 29, 53, 247, 185, 138, 211,
        0, 0, 0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0, 0, 0,
      ],
      init_angvel: 0,
      init_linvel: { x: 281.1888122558594, y: -1217.9625244140625 },
      init_pose: {
        angle_rad: -1.3439035415649414,
        pos: { x: 953, y: 420 },
      },
      mass_usd: 4.356,
      price_epoch: 1,
      rec_commit: null,
      rec_len: null,
      user: [
        68, 47, 27, 132, 64, 92, 162, 43,
        177, 7, 137, 108, 25, 88, 173, 229,
        18, 119, 221, 43, 159, 247, 211, 72,
        217, 247, 14, 173, 72, 179, 31, 220,
      ],
      value_usd_e8: "290700000",
    };
  }
  
  function pickTemplateThrow(simInput: SimRunInput): ThrowRecord {
    if (Array.isArray(simInput.throws) && simInput.throws.length > 0) {
      return deepClone(simInput.throws[0]);
    }
    return fallbackTemplateThrow();
  }
  
  function findAssetMeta(simInput: SimRunInput, assetHex: Hex32) {
    const clean = assetHex.replace(/^0x/i, "").toLowerCase();
    return simInput.assets.find((a) => bytesToHex32(a.asset as unknown as number[]) === clean) ?? null;
  }
  
  /**
   * Current V0 price source:
   * - use the current game's own throw snapshot pricing if present
   * - for now, anchor to the template's observed price_epoch
   *
   * price_per_unit_e8 = template.value_usd_e8 / template.amount
   * new_value_usd_e8 = new_amount * price_per_unit_e8
   *
   * This is exactly the level you asked for: use the game's current pricing context
   * rather than a fake placeholder, until oracle hookup is wired.
   */
  function estimateValueUsdE8FromTemplate(
    amountBaseStr: string,
    templateThrow: ThrowRecord,
  ): string {
    const amountBase = BigInt(amountBaseStr);
    const tplAmount = BigInt(templateThrow.amount || "0");
    const tplValue = BigInt(templateThrow.value_usd_e8 || "0");
  
    if (tplAmount <= 0n || tplValue < 0n) {
      return "0";
    }
  
    return ((amountBase * tplValue) / tplAmount).toString();
  }
  
  /**
   * Physics uses mass_usd. From your own comments/front-end:
   * mass_usd = value_usd * asset_mass_scale * game_mass_scale * (game_asset_mass_scale?)
   *
   * For V0 we use:
   * mass_usd = valueUsd * asset.mass_scale * game.mass_scale
   *
   * That matches the existing model closely enough until asset/game-specific extra
   * mass multipliers are surfaced explicitly in sim input.
   */
  function estimateMassUsd(
    valueUsdE8Str: string,
    assetMassScale: number,
    gameMassScale: number,
  ): number {
    const valueUsd = Number(valueUsdE8Str) / 1e8;
    if (!Number.isFinite(valueUsd)) return 0;
    return valueUsd * (assetMassScale || 1) * (gameMassScale || 1);
  }
  
  export function buildSyntheticThrowRecord(
    gameId: Hex32,
    control: AgentControlThrow,
    simInput: SimRunInput,
    botUserHex: Hex32,
    scenario: QueueScenario,
  ): ThrowRecord {
    const place = controlThrowToPlaceThrowArgs(gameId, botUserHex, control, simInput);
    const template = pickTemplateThrow(simInput);
  
    const assetHex = control.asset.replace(/^0x/i, "").toLowerCase();
    const assetBytes = hex32ToBytes(assetHex);
    const userBytes = hex32ToBytes(botUserHex);
  
    const previewThrow = deepClone(template);
  
    const assetMeta = findAssetMeta(simInput, assetHex);
    const assetMassScale = assetMeta?.mass_scale ?? 1;
    const gameMassScale = simInput.game?.mass_scale ?? 1;
  
    const valueUsdE8 = estimateValueUsdE8FromTemplate(control.amount, template);
    const massUsd = estimateMassUsd(valueUsdE8, assetMassScale, gameMassScale);
  
    previewThrow.asset = assetBytes as unknown as ThrowRecord["asset"];
    previewThrow.user = userBytes as unknown as ThrowRecord["user"];
  
    previewThrow.amount = String(control.amount);
    previewThrow.value_usd_e8 = valueUsdE8;
    previewThrow.mass_usd = massUsd;
  
    previewThrow.init_pose = deepClone(place.init_pose);
    previewThrow.init_linvel = deepClone(place.init_linvel);
    previewThrow.init_angvel = place.init_angvel;
  
    previewThrow.enter_frame = scenario.enterFrame;
    previewThrow.accepted_at_height = scenario.acceptedAtHeight;
  
    // Keep template id/price_epoch/rec fields for now, exactly as front-end style does.
    // price_epoch stays on the current game snapshot price context for V0.
  
    return previewThrow;
  }
  
  export function appendSyntheticThrow(
    gameId: Hex32,
    control: AgentControlThrow,
    simInput: SimRunInput,
    botUserHex: Hex32,
    scenario: QueueScenario,
  ): SimRunInput {
    const synthetic = buildSyntheticThrowRecord(
      gameId,
      control,
      simInput,
      botUserHex,
      scenario,
    );
  
    return {
      ...deepClone(simInput),
      throws: [...deepClone(simInput.throws), synthetic],
    };
  }