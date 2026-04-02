import { readFile } from "node:fs/promises";
import type { AgentPolicy } from "../policy/schema.js";
import type {
  AgentControlThrow,
  GameListItem,
  Hex32,
  SimRunInput,
} from "../collider/types.js";
import {
  appendRunLog,
  appendThrowLog,
  makeDecisionId,
  type StoragePaths,
} from "../core/storage.js";
import type { WasmVizRuntime } from "../sim/wasm.js";
import { generateGridCandidates } from "../strategy/candidate-gen.js";
import { rankPlannedCandidates, chooseBestRanked, type SearchBudget } from "../strategy/choose.js";
import { isCandidateBlockedByBankroll } from "../strategy/bankroll.js";
import { runCandidateAcrossQueueScenarios } from "../sim/planner.js";
import { controlThrowToPlaceThrowArgs } from "../collider/throw-builder.js";
import { shuffleCandidates } from "../strategy/candidate-gen.js";
import { RecentShot } from "../strategy/score.js";
import { summarizePredictionFromPlan } from "./prediction-log.js";

export type ColliderClientLike = {
  listGames(statusMask?: number): Promise<GameListItem[]>;
  getGame(gameId: Hex32): Promise<unknown>;
  getSimInput(gameId: Hex32): Promise<SimRunInput>;
  getBalances(user: Hex32): Promise<Record<string, string>>;
  placeThrow(args: unknown): Promise<unknown>;
};

export type LoopConfig = {
  gameStatusMask: number;
  botUser: Hex32;
  defaultAsset: Hex32;
  defaultAmount: string;

  dryRun?: boolean;
  includeSlip1?: boolean;

  candidateBudget?: SearchBudget;

  candidateGen?: {
    xSteps?: number;
    ySteps?: number;
    angleDegs?: number[];
    speedPcts?: number[];
    spinPcts?: number[];
  };

  scoreConfig?: {
    preferredHoleTypes?: number[];
    blockedHoleTypes?: number[];
    robustnessWeight?: number;
    fragilityWeight?: number;
    recentShots?: RecentShot[];
  };

  sessionId: string;
  storage?: StoragePaths;
};

export type TopCandidateView = {
  rank: number;
  final: number;
  weightedTotal: number;
  worstCaseTotal: number;
  bestCaseTotal: number;
  fragilityPenalty: number;
  x: number;
  y: number;
  angleDeg: number;
  speedPct: number;
  spinPct: number;
};

export type RunOnceResult = {
  decisionId: string | null;
  gameId: Hex32 | null;
  winnerSubmitted: boolean;
  winnerPayload?: unknown;
  top: TopCandidateView[];
  stoppedBy?: string;
};

function parseStakeUsdLike(raw: string | number | null | undefined): number {
  const n = Number(raw ?? 0);
  if (!Number.isFinite(n)) return 0;
  return Math.abs(n) >= 100000 ? n / 1e8 : n;
}

function cleanHex(value: string): string {
  return String(value || "").replace(/^0x/i, "").toLowerCase();
}

function estimateAssetUsdPerBaseUnit(simInput: SimRunInput, assetHex: string): number | null {
  const target = cleanHex(assetHex);
  const match = (simInput.throws || []).find((t) => {
    const hex = Array.isArray(t.asset) ? t.asset.map((b) => Number(b).toString(16).padStart(2, "0")).join("") : cleanHex(String(t.asset || ""));
    return hex === target;
  });
  if (!match) return null;
  const amount = Number(match.amount || 0);
  const value = Number(match.value_usd_e8 || 0) / 1e8;
  if (!Number.isFinite(amount) || amount <= 0 || !Number.isFinite(value)) return null;
  return value / amount;
}

function estimateCandidateUsd(amountBase: string, assetHex: string, simInput: SimRunInput): number {
  const perBase = estimateAssetUsdPerBaseUnit(simInput, assetHex);
  const amount = Number(amountBase || 0);
  if (perBase == null || !Number.isFinite(amount)) return 0;
  return amount * perBase;
}

function estimateBaseAmountForUsd(
  simInput: SimRunInput,
  assetHex: string,
  usd: number,
  fallbackAmount: string,
): string {
  const perBase = estimateAssetUsdPerBaseUnit(simInput, assetHex);
  if (perBase == null || perBase <= 0) return String(fallbackAmount);
  const out = Math.max(1, Math.round(usd / perBase));
  return String(out);
}

function parseBoolish(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  const s = String(v ?? "").trim().toLowerCase();
  return ["true", "1", "yes", "on"].includes(s);
}

function normalizeAssetList(input: string[] | undefined): string[] {
  return (input ?? []).map((x) => cleanHex(x)).filter(Boolean);
}

function buildUsdTargets(policy: AgentPolicy, fallbackUsd: number): number[] {
  const minUsd = Number.isFinite(Number(policy.minThrowUsd)) ? Number(policy.minThrowUsd) : fallbackUsd;
  const maxUsd = Number.isFinite(Number(policy.maxThrowUsd)) ? Number(policy.maxThrowUsd) : minUsd;
  const lo = Math.max(0.000001, Math.min(minUsd, maxUsd));
  const hi = Math.max(lo, Math.max(minUsd, maxUsd));
  const mid = lo + (hi - lo) * 0.5;
  switch (policy.riskMode) {
    case "defensive":
      return [lo, mid].filter((v, i, arr) => arr.indexOf(v) === i);
    case "aggressive":
      return [mid, hi].filter((v, i, arr) => arr.indexOf(v) === i);
    default:
      return [lo, mid, hi].filter((v, i, arr) => arr.indexOf(v) === i);
  }
}


async function loadHistoricalWinningSeeds(
  storage: StoragePaths | undefined,
  assetHex: string,
  amount: string,
): Promise<AgentControlThrow[]> {
  if (!storage) return [];
  try {
    const txt = await readFile(storage.resultsFile, "utf8");
    const lines = txt.trim().split(/\r?\n/).filter(Boolean).slice(-300);
    const out: AgentControlThrow[] = [];
    for (const line of lines.reverse()) {
      let row: any;
      try { row = JSON.parse(line); } catch { continue; }
      const holeType = Number(row?.actual?.throwMatch?.hole_type ?? NaN);
      if (!Number.isFinite(holeType) || holeType !== 3) continue;
      const payload = row?.expected?.payload;
      if (!payload) continue;
      out.push({
        x: Number(payload.x),
        y: Number(payload.y),
        angleDeg: Number(payload.angle_rad) * 180 / Math.PI,
        speedPct: 65,
        spinPct: 0,
        asset: assetHex,
        amount,
      });
      if (out.length >= 12) break;
    }
    return out.filter((c) => [c.x,c.y,c.angleDeg,c.speedPct,c.spinPct].every(Number.isFinite));
  } catch {
    return [];
  }
}

function nextAcceptedHeightFromGame(game: unknown): number {
  const g = game as Record<string, unknown>;
  const lastThrowHeight = Number(g.last_throw_height ?? 0);
  return lastThrowHeight + 1;
}

function pickBestLiveGame(games: GameListItem[], policy: AgentPolicy): GameListItem | null {
  let best: GameListItem | null = null;

  for (const g of games) {
    const stakeUsd = parseStakeUsdLike(g.stake);

    if (policy.minGameStakeUsd != null && stakeUsd < policy.minGameStakeUsd) {
      continue;
    }
    if (policy.maxGameExposureUsd != null && stakeUsd > policy.maxGameExposureUsd) {
      continue;
    }

    if (!best || stakeUsd > parseStakeUsdLike(best.stake)) {
      best = g;
    }
  }

  return best;
}

function passesGameMinThrow(candidateAmount: string, gameMinThrow: string): boolean {
  try {
    return BigInt(candidateAmount) >= BigInt(gameMinThrow);
  } catch {
    return false;
  }
}

function samePlannedControl(
  a: AgentControlThrow,
  b: AgentControlThrow,
): boolean {
  return (
    a.x === b.x &&
    a.y === b.y &&
    a.angleDeg === b.angleDeg &&
    a.speedPct === b.speedPct &&
    a.spinPct === b.spinPct &&
    cleanHex(a.asset) === cleanHex(b.asset) &&
    String(a.amount) === String(b.amount)
  );
}

function printCycleSummary(
  game: GameListItem,
  top: TopCandidateView[],
  stoppedBy: string | undefined,
  submitted: boolean,
): void {
  const now = new Date().toLocaleTimeString();
  console.log(
    `[${now}] game ${game.game_id.slice(0, 10)}... | throws=${game.throws} | stake=${game.stake} | minThrow=${game.throw_min_value}`,
  );
  console.log(`search stopped=${stoppedBy ?? "unknown"} submitted=${submitted ? "yes" : "no"}`);

  for (const row of top.slice(0, 3)) {
    console.log(
      `  #${row.rank} x=${row.x} y=${row.y} ang=${row.angleDeg} spd=${row.speedPct} spin=${row.spinPct} final=${row.final.toFixed(2)} robust=${row.weightedTotal.toFixed(2)} frag=${row.fragilityPenalty.toFixed(2)}`,
    );
  }
}

export async function runAgentOnce(
  client: ColliderClientLike,
  wasm: WasmVizRuntime,
  policy: AgentPolicy,
  cfg: LoopConfig,
): Promise<RunOnceResult> {
  const games = await client.listGames(cfg.gameStatusMask);
  const chosenGame = pickBestLiveGame(games, policy);

  if (!chosenGame) {
    const empty: RunOnceResult = {
      decisionId: null,
      gameId: null,
      winnerSubmitted: false,
      top: [],
      stoppedBy: "no_game",
    };

    if (cfg.storage) {
      await appendRunLog(cfg.storage, {
        ts: new Date().toISOString(),
        sessionId: cfg.sessionId,
        mode: cfg.dryRun ? "dry-run" : "live",
        gameId: null,
        botUser: cfg.botUser,
        submitted: false,
        stoppedBy: "no_game",
        top: [],
      });
    }

    return empty;
  }

  const gameId = chosenGame.game_id;
  const game = await client.getGame(gameId);
  const simInput = await client.getSimInput(gameId);
  const balances = await client.getBalances(cfg.botUser);

  if (policy.targetBalanceUsd != null) {
    const walletUsd = Object.entries(balances || {}).reduce((sum, [assetHex, amount]) => {
      const usd = estimateCandidateUsd(String(amount || "0"), assetHex, simInput);
      return sum + (Number.isFinite(usd) ? usd : 0);
    }, 0);
    if (walletUsd >= policy.targetBalanceUsd) {
      if (cfg.storage) {
        await appendRunLog(cfg.storage, {
          ts: new Date().toISOString(),
          sessionId: cfg.sessionId,
          mode: cfg.dryRun ? "dry-run" : "live",
          gameId,
          botUser: cfg.botUser,
          submitted: false,
          stoppedBy: "target_balance_reached",
          game: {
            throws: chosenGame.throws,
            stake: chosenGame.stake,
            minThrowValue: chosenGame.throw_min_value,
            status: chosenGame.status,
          },
          search: {
            generatedCandidates: 0,
            eligibleCandidates: 0,
            examinedCount: 0,
            maxCandidates: cfg.candidateBudget?.maxCandidates,
            maxMillis: cfg.candidateBudget?.maxMillis,
            includeSlip1: cfg.includeSlip1,
          },
          top: [],
        });
      }
      return { decisionId: null, gameId, winnerSubmitted: false, top: [], stoppedBy: "target_balance_reached" };
    }
  }

  const ib = simInput.map.physicsConfig.input_bounds;
  const bounds = {
    min_x: ib[0],
    min_y: ib[1],
    max_x: ib[2],
    max_y: ib[3],
  };

  const allowedAssets = normalizeAssetList(policy.allowedAssets);
  const blockedAssets = new Set(normalizeAssetList(policy.blockedAssets));
  const keepAssets = new Set(normalizeAssetList(policy.keepAssets));
  const disposeAssets = new Set(normalizeAssetList(policy.disposeAssets));
  const candidateAssets = (allowedAssets.length ? allowedAssets : [cfg.defaultAsset]).filter((asset) => !blockedAssets.has(cleanHex(asset)));

  const reserveBase = BigInt(String(policy.reserveBalanceBase || "0") || "0");
  const defaultUsd = estimateCandidateUsd(cfg.defaultAmount, cfg.defaultAsset, simInput) || 1;
  const usdTargets = buildUsdTargets(policy, defaultUsd);

  const assetAmountPairs: Array<{ asset: string; amount: string }> = [];
  for (const asset of candidateAssets) {
    const bal = BigInt(String(balances?.[cleanHex(asset)] ?? balances?.[asset] ?? "0"));
    if (bal <= reserveBase) continue;
    const localAmounts = usdTargets.map((usd) => estimateBaseAmountForUsd(simInput, asset, usd, cfg.defaultAmount));
    for (const amount of new Set(localAmounts)) {
      try {
        if (bal - BigInt(amount) < reserveBase) continue;
      } catch {}
      assetAmountPairs.push({ asset, amount });
    }
  }

  assetAmountPairs.sort((a, b) => {
    const ka = keepAssets.has(cleanHex(a.asset)) ? 1 : 0;
    const kb = keepAssets.has(cleanHex(b.asset)) ? 1 : 0;
    const da = disposeAssets.has(cleanHex(a.asset)) ? -1 : 0;
    const db = disposeAssets.has(cleanHex(b.asset)) ? -1 : 0;
    return (da + ka) - (db + kb);
  });

  const rawCandidateGroups = await Promise.all(assetAmountPairs.map(async ({ asset, amount }) => {
    const grid = generateGridCandidates(bounds, {
      xSteps: cfg.candidateGen?.xSteps ?? 3,
      ySteps: cfg.candidateGen?.ySteps ?? 2,
      angleDegs: cfg.candidateGen?.angleDegs,
      speedPcts: cfg.candidateGen?.speedPcts,
      spinPcts: cfg.candidateGen?.spinPcts,
      asset,
      amount,
    });
    const copied = policy.copySlammerWhenSameHoleType ? await loadHistoricalWinningSeeds(cfg.storage, asset, amount) : [];
    return [...copied, ...grid];
  }));

  const rawCandidates = rawCandidateGroups.flat();

  const filtered: AgentControlThrow[] = rawCandidates.filter((c) => {
    if (!passesGameMinThrow(c.amount, chosenGame.throw_min_value)) {
      return false;
    }

    const candidateUsd = estimateCandidateUsd(c.amount, c.asset, simInput);
    if (policy.minThrowUsd != null && candidateUsd < policy.minThrowUsd) return false;
    if (policy.maxGameExposureUsd != null) {
      const currentStakeUsd = parseStakeUsdLike(chosenGame.stake);
      if (currentStakeUsd + candidateUsd > policy.maxGameExposureUsd) return false;
    }
    return !isCandidateBlockedByBankroll(candidateUsd, policy, {
      smallThrowsPlaced: 0,
      bigThrowsPlaced: 0,
    });
  });

  const maxCandidates = cfg.candidateBudget?.maxCandidates ?? filtered.length;
  const shuffled = shuffleCandidates(filtered);
  const limited = shuffled.slice(0, maxCandidates);

  const nextAcceptedHeight = nextAcceptedHeightFromGame(game);

  const planned = await Promise.all(
    limited.map((control) =>
      runCandidateAcrossQueueScenarios(
        wasm,
        gameId,
        cfg.botUser,
        simInput,
        control,
        {
          nextAcceptedHeight,
          includeSlip1: cfg.includeSlip1 ?? true,
        },
      ),
    ),
  );

  const ranked = rankPlannedCandidates(planned, cfg.scoreConfig);
  const chosen = chooseBestRanked(ranked, cfg.candidateBudget);

  const top: TopCandidateView[] = chosen.ranked.slice(0, 5).map((r, i) => ({
    rank: i + 1,
    final: r.score.final,
    weightedTotal: r.score.weightedTotal,
    worstCaseTotal: r.score.worstCaseTotal,
    bestCaseTotal: r.score.bestCaseTotal,
    fragilityPenalty: r.score.fragilityPenalty,
    x: r.candidate.x,
    y: r.candidate.y,
    angleDeg: r.candidate.angleDeg,
    speedPct: r.candidate.speedPct,
    spinPct: r.candidate.spinPct,
  }));

  if (!chosen.winner) {
    printCycleSummary(chosenGame, top, chosen.stoppedBy, false);

    if (cfg.storage) {
      await appendRunLog(cfg.storage, {
        ts: new Date().toISOString(),
        sessionId: cfg.sessionId,
        mode: cfg.dryRun ? "dry-run" : "live",
        gameId,
        botUser: cfg.botUser,
        submitted: false,
        stoppedBy: chosen.stoppedBy,
        game: {
          throws: chosenGame.throws,
          stake: chosenGame.stake,
          minThrowValue: chosenGame.throw_min_value,
          status: chosenGame.status,
        },
        search: {
          generatedCandidates: rawCandidates.length,
          eligibleCandidates: filtered.length,
          examinedCount: chosen.examinedCount,
          maxCandidates: cfg.candidateBudget?.maxCandidates,
          maxMillis: cfg.candidateBudget?.maxMillis,
          includeSlip1: cfg.includeSlip1,
        },
        top,
      });
    }

    return {
      decisionId: null,
      gameId,
      winnerSubmitted: false,
      top,
      stoppedBy: chosen.stoppedBy,
    };
  }

  const winnerPayload = controlThrowToPlaceThrowArgs(
    gameId,
    cfg.botUser,
    chosen.winner.candidate,
    simInput,
  );

  const decisionId = makeDecisionId();

  const chosenPlan =
    planned.find((p) => samePlannedControl(p.control, chosen.winner!.candidate)) ?? null;

  const prediction = chosenPlan
    ? summarizePredictionFromPlan(chosenPlan, cfg.botUser)
    : null;

  if (!cfg.dryRun) {
    console.log("SUBMIT winnerPayload:", JSON.stringify(winnerPayload, null, 2));
    await client.placeThrow(winnerPayload);
  }

  printCycleSummary(chosenGame, top, chosen.stoppedBy, !cfg.dryRun);

  if (cfg.storage) {
    await appendRunLog(cfg.storage, {
      ts: new Date().toISOString(),
      sessionId: cfg.sessionId,
      mode: cfg.dryRun ? "dry-run" : "live",
      gameId,
      botUser: cfg.botUser,
      submitted: !cfg.dryRun,
      stoppedBy: chosen.stoppedBy,
      game: {
        throws: chosenGame.throws,
        stake: chosenGame.stake,
        minThrowValue: chosenGame.throw_min_value,
        status: chosenGame.status,
      },
      search: {
        generatedCandidates: rawCandidates.length,
        eligibleCandidates: filtered.length,
        examinedCount: chosen.examinedCount,
        maxCandidates: cfg.candidateBudget?.maxCandidates,
        maxMillis: cfg.candidateBudget?.maxMillis,
        includeSlip1: cfg.includeSlip1,
      },
      top,
      chosenPayload: winnerPayload,
      prediction: prediction ? {
        pnlUsd: prediction.pnlUsd,
        bestPnlUsd: prediction.bestPnlUsd,
        worstPnlUsd: prediction.worstPnlUsd,
        scenarioCount: prediction.scenarioCount,
        winnerValuePct: prediction.winnerValuePct,
        holeType: prediction.holeType,
        valueUsd: prediction.valueUsd,
        valueUsdE8: prediction.valueUsdE8,
        massUsd: prediction.massUsd,
      } : undefined,
    });

    await appendThrowLog(cfg.storage, {
      ts: new Date().toISOString(),
      sessionId: cfg.sessionId,
      decisionId,
      gameId,
      botUser: cfg.botUser,
      submitted: !cfg.dryRun,
      dryRun: !!cfg.dryRun,
      payload: winnerPayload,
      score: {
        final: chosen.winner.score.final,
        weightedTotal: chosen.winner.score.weightedTotal,
        worstCaseTotal: chosen.winner.score.worstCaseTotal,
        bestCaseTotal: chosen.winner.score.bestCaseTotal,
        fragilityPenalty: chosen.winner.score.fragilityPenalty,
      },
      prediction: prediction ? {
        pnlUsd: prediction.pnlUsd,
        bestPnlUsd: prediction.bestPnlUsd,
        worstPnlUsd: prediction.worstPnlUsd,
        scenarioCount: prediction.scenarioCount,
        winnerScenarioCount: prediction.winnerScenarioCount,
        winnerValuePct: prediction.winnerValuePct,
        holeType: prediction.holeType,
        holeTypeCounts: prediction.holeTypeCounts,
        valueUsd: prediction.valueUsd,
        valueUsdE8: prediction.valueUsdE8,
        massUsd: prediction.massUsd,
      } : undefined,
    });
  }

  return {
    decisionId,
    gameId,
    winnerSubmitted: !cfg.dryRun,
    winnerPayload,
    top,
    stoppedBy: chosen.stoppedBy,
  };
}