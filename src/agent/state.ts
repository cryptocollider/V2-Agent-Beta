import type { AgentPolicy } from "../policy/schema.js";
import type { PositioningState } from "../strategy/bankroll.js";

export type AgentState = {
  botUser: string;
  balances: Record<string, string>;
  openGames: Map<string, unknown>;
  watchedGames: Set<string>;
  recentEvents: unknown[];

  perGameThrowCounts: Record<string, number>;

  positioning: PositioningState;

  policy: AgentPolicy;
};

export function createInitialAgentState(botUser: string, policy: AgentPolicy): AgentState {
  return {
    botUser,
    balances: {},
    openGames: new Map(),
    watchedGames: new Set(),
    recentEvents: [],
    perGameThrowCounts: {},
    positioning: {
      smallThrowsPlaced: 0,
      bigThrowsPlaced: 0,
    },
    policy,
  };
}