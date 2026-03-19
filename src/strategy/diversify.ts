export type RecentShot = {
  ts: number;
  gameId: string;
  x: number;
  y: number;
  angleDeg: number;
  speedPct: number;
  spinPct: number;
  submitted: boolean;
};

export type DiversityConfig = {
  enabled?: boolean;
  sameGameWindowMs?: number;
  globalWindowMs?: number;
  sameGamePenaltyWeight?: number;
  globalPenaltyWeight?: number;
};

export type CandidateLike = {
  x: number;
  y: number;
  angleDeg: number;
  speedPct: number;
  spinPct: number;
};

export function shuffleArray<T>(arr: T[]): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function normDist(a: CandidateLike, b: CandidateLike): number {
  const dx = Math.abs(a.x - b.x) / 2000;
  const dy = Math.abs(a.y - b.y) / 1000;
  const da = Math.abs(a.angleDeg - b.angleDeg) / 180;
  const ds = Math.abs(a.speedPct - b.speedPct) / 100;
  const dspin = Math.abs(a.spinPct - b.spinPct) / 100;
  return (dx + dy + da + ds + dspin) / 5;
}

function similarityScore(a: CandidateLike, b: CandidateLike): number {
  return Math.max(0, 1 - normDist(a, b));
}

export function diversityPenalty(
  candidate: CandidateLike,
  gameId: string,
  recentShots: RecentShot[],
  cfg: DiversityConfig = {},
  now = Date.now(),
): number {
  if (!cfg.enabled || recentShots.length === 0) return 0;

  const sameGameWindowMs = cfg.sameGameWindowMs ?? 20 * 60_000;
  const globalWindowMs = cfg.globalWindowMs ?? 10 * 60_000;
  const sameGamePenaltyWeight = cfg.sameGamePenaltyWeight ?? 500;
  const globalPenaltyWeight = cfg.globalPenaltyWeight ?? 120;

  let penalty = 0;

  for (const shot of recentShots) {
    const age = now - shot.ts;
    const sim = similarityScore(candidate, shot);
    if (sim <= 0) continue;

    if (shot.gameId === gameId && age <= sameGameWindowMs) {
      const decay = 1 - age / sameGameWindowMs;
      penalty += sim * decay * sameGamePenaltyWeight;
    } else if (age <= globalWindowMs) {
      const decay = 1 - age / globalWindowMs;
      penalty += sim * decay * globalPenaltyWeight;
    }
  }

  return penalty;
}