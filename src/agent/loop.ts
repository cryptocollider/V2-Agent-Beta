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

function asNumberStringUsd(amountBase: string): number {
  const n = Number(amountBase);
  return Number.isFinite(n) ? n : 0;
}

function nextAcceptedHeightFromGame(game: unknown): number {
  const g = game as Record<string, unknown>;
  const lastThrowHeight = Number(g.last_throw_height ?? 0);
  return lastThrowHeight + 1;
}

function pickBestLiveGame(games: GameListItem[], policy: AgentPolicy): GameListItem | null {
  let best: GameListItem | null = null;

  for (const g of games) {
    const stakeUsd = Number(g.stake ?? 0);

    if (policy.minGameStakeUsd != null && stakeUsd < policy.minGameStakeUsd) {
      continue;
    }

    if (!best || Number(g.stake ?? 0) > Number(best.stake ?? 0)) {
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
  await client.getBalances(cfg.botUser);

  const ib = simInput.map.physicsConfig.input_bounds;
  const bounds = {
    min_x: ib[0],
    min_y: ib[1],
    max_x: ib[2],
    max_y: ib[3],
  };

  const rawCandidates = generateGridCandidates(bounds, {
    xSteps: cfg.candidateGen?.xSteps ?? 3,
    ySteps: cfg.candidateGen?.ySteps ?? 2,
    angleDegs: cfg.candidateGen?.angleDegs,
    speedPcts: cfg.candidateGen?.speedPcts,
    spinPcts: cfg.candidateGen?.spinPcts,
    asset: cfg.defaultAsset,
    amount: cfg.defaultAmount,
  });

  const filtered: AgentControlThrow[] = rawCandidates.filter((c) => {
    if (!passesGameMinThrow(c.amount, chosenGame.throw_min_value)) {
      return false;
    }

    const candidateUsd = asNumberStringUsd(c.amount);
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