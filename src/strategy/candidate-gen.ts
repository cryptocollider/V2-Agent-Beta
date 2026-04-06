export type CandidateSource = "grid" | "copy-seed" | "history" | "manager";

export type Candidate = {
  x: number;
  y: number;
  angleDeg: number;
  speedPct: number;
  spinPct: number;
  asset: string;
  amount: string;
  source: CandidateSource;
  tags: string[];
};

export type InputBounds = {
  min_x: number;
  max_x: number;
  min_y: number;
  max_y: number;
};

export type CandidateGenOptions = {
  xSteps?: number;
  ySteps?: number;
  angleDegs?: number[];
  speedPcts?: number[];
  spinPcts?: number[];
  asset: string;
  amount: string;
};

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lineSpace(min: number, max: number, steps: number): number[] {
  if (steps <= 1) return [(min + max) / 2];
  const out: number[] = [];
  for (let i = 0; i < steps; i++) {
    out.push(lerp(min, max, i / (steps - 1)));
  }
  return out;
}

export function generateGridCandidates(
  bounds: InputBounds,
  opts: CandidateGenOptions,
): Candidate[] {
  const xSteps = Math.max(1, opts.xSteps ?? 3);
  const ySteps = Math.max(1, opts.ySteps ?? 2);

  const angleDegs = opts.angleDegs ?? [-75, -60, -45, -30, -15, 0, 15, 30, 45, 60, 75];
  const speedPcts = opts.speedPcts ?? [35, 50, 65, 80, 95];
  const spinPcts = opts.spinPcts ?? [-50, -25, 0, 25, 50];

  const xs = lineSpace(bounds.min_x, bounds.max_x, xSteps);
  const ys = lineSpace(bounds.min_y, bounds.max_y, ySteps);

  const out: Candidate[] = [];

  for (const x of xs) {
    for (const y of ys) {
      for (const angleDeg of angleDegs) {
        for (const speedPct of speedPcts) {
          for (const spinPct of spinPcts) {
            out.push({
              x,
              y,
              angleDeg,
              speedPct,
              spinPct,
              asset: opts.asset,
              amount: opts.amount,
              source: "grid",
              tags: [],
            });
          }
        }
      }
    }
  }

  return out;
}

export function shuffleCandidates<T>(arr: T[], seed = Date.now()): T[] {
  const out = arr.slice();
  let s = seed >>> 0;

  function rand() {
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 0xffffffff;
  }

  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }

  return out;
}
