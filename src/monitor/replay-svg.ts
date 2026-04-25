import type { Hex32, SimRunInput, ThrowRecord } from "../collider/types.js";
import { bytesToHex32 } from "../collider/throw-builder.js";
import { decodeGameResult, type DecodedGameResult, type DecodedThrowOutcome } from "../sim/decode.js";
import type { WasmVizRuntime } from "../sim/wasm.js";

export type ReplaySvgRequest = {
  gameId: Hex32;
  frames: number[];
};

export type ReplaySvgFrame = {
  frame: number;
  visibleThrows: number;
  resolvedThrows: number;
  svg: string;
};

export type ReplaySvgExport = {
  mode: "forecast_storyboard_v1";
  exactPhysics: false;
  gameId: Hex32;
  generatedAt: string;
  finalFrame: number;
  selectedFrames: number[];
  notes: string[];
  frames: ReplaySvgFrame[];
};

export type ReplaySvgClientLike = {
  getSimInput(gameId: Hex32): Promise<SimRunInput>;
};

type HoleView = {
  index: number;
  x: number;
  y: number;
  radius: number;
  holeType: number;
};

type BoardBallView = {
  throwId: string;
  asset: string;
  assetSymbol: string;
  amount: string;
  x: number;
  y: number;
  radius: number;
  holeType: number | null;
  endFrame: number | null;
  resolved: boolean;
};

function cleanHex(value: unknown): string {
  return String(value ?? "").trim().replace(/^0x/i, "").toLowerCase();
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

function esc(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function normalizeFrame(value: unknown): number | null {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  return Math.floor(numeric);
}

export function normalizeReplaySvgRequest(input: unknown): ReplaySvgRequest {
  const payload = (input && typeof input === "object") ? input as Record<string, unknown> : {};
  const gameId = cleanHex(payload.gameId);
  if (!gameId) {
    throw new Error("missing gameId");
  }

  const rawFrames = Array.isArray(payload.frames) ? payload.frames : [];
  const frames = [...new Set(
    rawFrames
      .map((frame) => normalizeFrame(frame))
      .filter((frame): frame is number => frame != null),
  )]
    .sort((a, b) => a - b)
    .slice(0, 24);

  if (!frames.length) {
    throw new Error("missing frames");
  }

  return {
    gameId,
    frames,
  };
}

function quadraticBezier(start: number, control: number, end: number, t: number): number {
  const omt = 1 - t;
  return (omt * omt * start) + (2 * omt * t * control) + (t * t * end);
}

function easeOut(value: number): number {
  const t = clamp01(value);
  return 1 - Math.pow(1 - t, 2.15);
}

function assetColor(symbol: string, index: number): string {
  const normalized = String(symbol || "").trim().toUpperCase();
  if (normalized === "USDC") return "#4fdfff";
  if (normalized === "CLC") return "#36a3ff";
  if (normalized === "AVAX") return "#ff6a7c";
  if (normalized === "BTC") return "#f7c14a";
  const palette = ["#7cf4b9", "#ff9e57", "#d07cff", "#ffe66d", "#8ab6ff", "#69f0ff"];
  return palette[index % palette.length];
}

function toDisplayAmount(amount: string, decimals: number): string {
  const numeric = Number(amount);
  if (!Number.isFinite(numeric)) return String(amount);
  const scale = Math.pow(10, decimals || 0);
  if (!(scale > 0)) return String(amount);
  const display = numeric / scale;
  if (display >= 100) return display.toFixed(0);
  if (display >= 10) return display.toFixed(1).replace(/\.0$/, "");
  return display.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function collectHoles(simInput: SimRunInput): HoleView[] {
  const holes: HoleView[] = [];
  for (const geometry of simInput.map?.geometry_objects ?? []) {
    const hole = (geometry as { Hole?: any }).Hole;
    if (!hole?.data?.center_px) continue;
    const center = hole.data.center_px;
    const radius = Number(hole.data.visible_area?.Circle?.radius ?? 28);
    holes.push({
      index: holes.length,
      x: Number(center.x ?? 0),
      y: Number(center.y ?? 0),
      radius: Number.isFinite(radius) ? radius : 28,
      holeType: Number(hole.data.result_type ?? 0),
    });
  }
  return holes;
}

function rotatePoint(x: number, y: number, angleRad: number): { x: number; y: number } {
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  return {
    x: x * cos - y * sin,
    y: x * sin + y * cos,
  };
}

function renderStaticGeometry(simInput: SimRunInput): string {
  const parts: string[] = [];
  for (const geometry of simInput.map?.geometry_objects ?? []) {
    const polygon = (geometry as { Polygon?: any }).Polygon;
    if (polygon?.data?.vertices?.length) {
      const pose = polygon.pose ?? { pos: { x: 0, y: 0 }, angle_rad: 0 };
      const points = polygon.data.vertices
        .map((vertex: any) => {
          const rotated = rotatePoint(Number(vertex.x ?? 0), Number(vertex.y ?? 0), Number(pose.angle_rad ?? 0));
          const x = rotated.x + Number(pose.pos?.x ?? 0);
          const y = rotated.y + Number(pose.pos?.y ?? 0);
          return `${x.toFixed(2)},${y.toFixed(2)}`;
        })
        .join(" ");
      parts.push(`<polygon points="${points}" fill="#10243d" stroke="#1d4d74" stroke-width="2"/>`);
      continue;
    }

    const circle = (geometry as { Circle?: any }).Circle;
    if (circle?.data?.radius != null) {
      parts.push(
        `<circle cx="${Number(circle.pose?.pos?.x ?? 0)}" cy="${Number(circle.pose?.pos?.y ?? 0)}" r="${Number(circle.data.radius ?? 0)}" fill="#132c4a" stroke="#275679" stroke-width="2"/>`,
      );
      continue;
    }

    const flipper = (geometry as { Flipper?: any }).Flipper;
    if (flipper?.data?.shape?.vertices?.length) {
      const pose = flipper.pose ?? { pos: { x: 0, y: 0 }, angle_rad: 0 };
      const points = flipper.data.shape.vertices
        .map((vertex: any) => {
          const rotated = rotatePoint(Number(vertex.x ?? 0), Number(vertex.y ?? 0), Number(pose.angle_rad ?? 0));
          const x = rotated.x + Number(pose.pos?.x ?? 0);
          const y = rotated.y + Number(pose.pos?.y ?? 0);
          return `${x.toFixed(2)},${y.toFixed(2)}`;
        })
        .join(" ");
      parts.push(`<polygon points="${points}" fill="#14375f" stroke="#47b4ff" stroke-width="2"/>`);
      continue;
    }
  }
  return parts.join("");
}

function renderHoles(holes: HoleView[]): string {
  const palette: Record<number, string> = {
    1: "#5bd8ff",
    2: "#3f7ca8",
    3: "#5cf4a3",
    4: "#ffd966",
    5: "#ff84cf",
  };

  return holes.map((hole) => `
    <g data-hole-index="${hole.index}">
      <circle cx="${hole.x}" cy="${hole.y}" r="${hole.radius}" fill="rgba(6,18,32,0.82)" stroke="${palette[hole.holeType] ?? "#7aa5d8"}" stroke-width="4"/>
      <text x="${hole.x}" y="${hole.y + 5}" text-anchor="middle" font-size="18" fill="#d8f1ff" font-weight="700">${esc(String(hole.holeType))}</text>
    </g>
  `).join("");
}

function computeTeleportAnchor(throwsVisible: ThrowRecord[], simInput: SimRunInput): { x: number; y: number } | null {
  if (Number((simInput.map?.physicsConfig as any)?.black_hole_mode ?? 0) <= 0) return null;
  const early = throwsVisible.slice(0, 3);
  if (!early.length) return null;

  let sumX = 0;
  let sumY = 0;
  let sumW = 0;
  for (const throwRecord of early) {
    const weight = Math.max(0, Number(String(throwRecord.value_usd_e8 ?? "0")) / 1e8);
    const effectiveWeight = weight > 0 ? weight : 1;
    sumX += Number(throwRecord.init_pose?.pos?.x ?? 0) * effectiveWeight;
    sumY += Number(throwRecord.init_pose?.pos?.y ?? 0) * effectiveWeight;
    sumW += effectiveWeight;
  }

  if (!(sumW > 0)) return null;
  return {
    x: sumX / sumW,
    y: sumY / sumW,
  };
}

function computeBlackholeOwnerPoint(throwsVisible: ThrowRecord[], simInput: SimRunInput): { x: number; y: number } | null {
  if (Number((simInput.map?.physicsConfig as any)?.black_hole_mode ?? 0) <= 0) return null;
  const owner = [...throwsVisible]
    .sort((a, b) => Number(b.mass_usd ?? 0) - Number(a.mass_usd ?? 0))[0];
  if (!owner) return null;
  return {
    x: Number(owner.init_pose?.pos?.x ?? 0),
    y: Number(owner.init_pose?.pos?.y ?? 0),
  };
}

function renderBlackholeMarkers(
  simInput: SimRunInput,
  throwsVisible: ThrowRecord[],
): string {
  if (Number((simInput.map?.physicsConfig as any)?.black_hole_mode ?? 0) <= 0) return "";

  const anchor = computeTeleportAnchor(throwsVisible, simInput);
  const owner = computeBlackholeOwnerPoint(throwsVisible, simInput);
  const out: string[] = [];

  if (anchor) {
    out.push(`
      <g>
        <circle cx="${anchor.x}" cy="${anchor.y}" r="26" fill="none" stroke="#ff79d1" stroke-width="4" stroke-dasharray="8 6"/>
        <circle cx="${anchor.x}" cy="${anchor.y}" r="8" fill="#ff79d1"/>
        <text x="${anchor.x + 34}" y="${anchor.y - 12}" fill="#ffd8f1" font-size="18" font-weight="700">ANCHOR</text>
      </g>
    `);
  }

  if (owner) {
    out.push(`
      <g>
        <circle cx="${owner.x}" cy="${owner.y}" r="20" fill="none" stroke="#44d2ff" stroke-width="4"/>
        <line x1="${owner.x - 24}" y1="${owner.y}" x2="${owner.x + 24}" y2="${owner.y}" stroke="#44d2ff" stroke-width="3"/>
        <line x1="${owner.x}" y1="${owner.y - 24}" x2="${owner.x}" y2="${owner.y + 24}" stroke="#44d2ff" stroke-width="3"/>
        <text x="${owner.x + 30}" y="${owner.y + 36}" fill="#b8f5ff" font-size="18" font-weight="700">BH CTRL</text>
      </g>
    `);
  }

  return out.join("");
}

function targetHoleForOutcome(holes: HoleView[], outcome: DecodedThrowOutcome | null): HoleView | null {
  if (!outcome) return null;
  return holes[outcome.hole_i] ?? holes.find((hole) => hole.holeType === outcome.hole_type) ?? null;
}

function buildBallView(
  frame: number,
  throwRecord: ThrowRecord,
  outcome: DecodedThrowOutcome | null,
  hole: HoleView | null,
  simInput: SimRunInput,
): BoardBallView {
  const assetHex = bytesToHex32(throwRecord.asset as unknown as number[]);
  const assetMeta = simInput.assets.find((asset) => bytesToHex32(asset.asset as unknown as number[]) === assetHex) ?? null;
  const enterFrame = Number(throwRecord.enter_frame ?? 0);
  const endFrame = outcome ? Number(outcome.endFrame ?? 0) : null;
  const entryX = Number(throwRecord.init_pose?.pos?.x ?? 0);
  const entryY = Number(throwRecord.init_pose?.pos?.y ?? 0);
  const radius = Number(assetMeta?.radius_px ?? 28);

  let x = entryX;
  let y = entryY;
  let resolved = false;

  if (hole && endFrame != null && frame >= enterFrame) {
    if (frame >= endFrame) {
      x = hole.x;
      y = hole.y;
      resolved = true;
    } else {
      const rawT = (frame - enterFrame) / Math.max(1, endFrame - enterFrame);
      const t = easeOut(rawT);
      const controlX = clamp(entryX + (Number(throwRecord.init_linvel?.x ?? 0) * 0.08), 0, Number(simInput.map?.physicsConfig?.vis_bounds?.[0] ?? 1920));
      const controlY = clamp(entryY + (Number(throwRecord.init_linvel?.y ?? 0) * 0.08), -200, Number(simInput.map?.physicsConfig?.vis_bounds?.[1] ?? 1080));
      x = quadraticBezier(entryX, controlX, hole.x, t);
      y = quadraticBezier(entryY, controlY, hole.y, t);
    }
  }

  return {
    throwId: bytesToHex32(throwRecord.id as unknown as number[]),
    asset: assetHex,
    assetSymbol: String(assetMeta?.symbol ?? "BALL").toUpperCase(),
    amount: toDisplayAmount(String(throwRecord.amount ?? "0"), Number(assetMeta?.decimals ?? 0)),
    x,
    y,
    radius,
    holeType: outcome?.hole_type ?? null,
    endFrame,
    resolved,
  };
}

function renderBalls(
  balls: BoardBallView[],
  frame: number,
): string {
  return balls.map((ball, index) => {
    const fill = assetColor(ball.assetSymbol, index);
    const opacity = ball.resolved ? 0.96 : 0.74;
    const stroke = ball.resolved ? "#ecfdff" : "#b7fbff";
    const ring = ball.resolved ? 4 : 2.5;
    return `
      <g>
        <title>${esc(`${ball.assetSymbol} ${ball.amount} | throw ${ball.throwId.slice(0, 10)} | frame ${frame}${ball.holeType != null ? ` | hole ${ball.holeType}` : ""}`)}</title>
        <circle cx="${ball.x.toFixed(2)}" cy="${ball.y.toFixed(2)}" r="${ball.radius.toFixed(2)}" fill="${fill}" fill-opacity="${opacity}" stroke="${stroke}" stroke-width="${ring}"/>
        <text x="${ball.x.toFixed(2)}" y="${(ball.y + 5).toFixed(2)}" text-anchor="middle" font-size="${Math.max(12, ball.radius * 0.42).toFixed(0)}" fill="#041018" font-weight="800">${esc(ball.assetSymbol.slice(0, 1))}</text>
      </g>
    `;
  }).join("");
}

function renderHud(params: {
  simInput: SimRunInput;
  gameId: string;
  frame: number;
  finalFrame: number;
  visibleThrows: number;
  resolvedThrows: number;
}): string {
  const { simInput, gameId, frame, finalFrame, visibleThrows, resolvedThrows } = params;
  const mode = Number((simInput.map?.physicsConfig as any)?.black_hole_mode ?? 0);
  const boardName = String(simInput.map?.name ?? simInput.game?.name ?? "Collider Board");
  const subtitle = mode > 0
    ? `Forecast storyboard | blackhole mode ${mode} | frame ${frame}/${finalFrame}`
    : `Forecast storyboard | frame ${frame}/${finalFrame}`;

  return `
    <g>
      <rect x="24" y="20" width="640" height="94" rx="18" fill="rgba(5,11,20,0.78)" stroke="#1f527a" stroke-width="2"/>
      <text x="48" y="54" font-size="28" fill="#67f4ff" font-weight="800">${esc(boardName)}</text>
      <text x="48" y="82" font-size="16" fill="#a7cfe5">${esc(subtitle)}</text>
      <text x="48" y="104" font-size="16" fill="#d6f8ff">Game ${esc(gameId.slice(0, 12))} | Visible throws ${visibleThrows} | Resolved ${resolvedThrows}</text>
    </g>
  `;
}

export function buildReplaySvgStoryboard(params: {
  gameId: string;
  simInput: SimRunInput;
  decoded: DecodedGameResult;
  frames: number[];
}): ReplaySvgExport {
  const { gameId, simInput, decoded } = params;
  const visWidth = Number(simInput.map?.physicsConfig?.vis_bounds?.[0] ?? 1920);
  const visHeight = Number(simInput.map?.physicsConfig?.vis_bounds?.[1] ?? 1080);
  const holes = collectHoles(simInput);
  const outcomesByThrowId = new Map<string, DecodedThrowOutcome>();
  for (const outcome of decoded.per_throw ?? []) {
    outcomesByThrowId.set(cleanHex(outcome.throw_id), outcome);
  }

  const selectedFrames = [...new Set(params.frames.map((frame) => clamp(frame, 0, Math.max(0, decoded.end_frame ?? 0))))].sort((a, b) => a - b);
  const staticGeometry = renderStaticGeometry(simInput);
  const holesSvg = renderHoles(holes);
  const inputBounds = simInput.map?.physicsConfig?.input_bounds ?? [10, 10, visWidth - 10, 420];

  const frames = selectedFrames.map((frame): ReplaySvgFrame => {
    const throwsVisible = (simInput.throws ?? []).filter((throwRecord) => Number(throwRecord.enter_frame ?? 0) <= frame);
    const balls = throwsVisible.map((throwRecord) => {
      const throwId = cleanHex(bytesToHex32(throwRecord.id as unknown as number[]));
      const outcome = outcomesByThrowId.get(throwId) ?? null;
      return buildBallView(frame, throwRecord, outcome, targetHoleForOutcome(holes, outcome), simInput);
    });
    const resolvedThrows = balls.filter((ball) => ball.resolved).length;
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="${visWidth}" height="${visHeight}" viewBox="0 0 ${visWidth} ${visHeight}" data-exact-physics="false" data-mode="forecast_storyboard_v1">
        <rect width="${visWidth}" height="${visHeight}" fill="#07121f"/>
        <rect x="${Number(inputBounds[0])}" y="${Number(inputBounds[1])}" width="${Number(inputBounds[2]) - Number(inputBounds[0])}" height="${Number(inputBounds[3]) - Number(inputBounds[1])}" rx="16" fill="none" stroke="#1b4f74" stroke-width="2" stroke-dasharray="10 8"/>
        ${renderHud({
          simInput,
          gameId,
          frame,
          finalFrame: decoded.end_frame ?? 0,
          visibleThrows: throwsVisible.length,
          resolvedThrows,
        })}
        <g>${staticGeometry}</g>
        <g>${holesSvg}</g>
        <g>${renderBlackholeMarkers(simInput, throwsVisible)}</g>
        <g>${renderBalls(balls, frame)}</g>
        <text x="${visWidth - 28}" y="${visHeight - 24}" text-anchor="end" font-size="14" fill="#7ea7c4">Explicit export only | storyboard approximation from canonical sim input + current local finalize</text>
      </svg>
    `.trim();

    return {
      frame,
      visibleThrows: throwsVisible.length,
      resolvedThrows,
      svg,
    };
  });

  return {
    mode: "forecast_storyboard_v1",
    exactPhysics: false,
    gameId: cleanHex(gameId),
    generatedAt: new Date().toISOString(),
    finalFrame: Number(decoded.end_frame ?? 0),
    selectedFrames,
    notes: [
      "Explicit export only. No SVG work happens during normal scan or throw selection cycles.",
      "This is a forecast storyboard from canonical sim input plus current local finalize, not a raw engine frame dump.",
      "Blackhole anchor and control markers are derived from public rules and current visible throws, not from hidden sim internals.",
    ],
    frames,
  };
}

export async function buildReplaySvgExportWithRuntime(params: {
  client: ReplaySvgClientLike;
  wasm: WasmVizRuntime;
  request: ReplaySvgRequest;
}): Promise<ReplaySvgExport> {
  const simInput = await params.client.getSimInput(params.request.gameId);
  const rawFinalizeBytes = await params.wasm.runToFinalize(simInput);
  const decoded = decodeGameResult(rawFinalizeBytes);
  return buildReplaySvgStoryboard({
    gameId: params.request.gameId,
    simInput,
    decoded,
    frames: params.request.frames,
  });
}
