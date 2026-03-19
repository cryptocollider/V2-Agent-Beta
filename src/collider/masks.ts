export const GAME_STATUS = {
  OPEN: 0,
  ARMED: 1,
  CLOSED: 2,
  FINALIZED: 3,
  SETTLED: 4,
} as const;

export type GameStatusCode = typeof GAME_STATUS[keyof typeof GAME_STATUS];

export const MASK_OPEN = 1 << GAME_STATUS.OPEN;
export const MASK_ARMED = 1 << GAME_STATUS.ARMED;
export const MASK_CLOSED = 1 << GAME_STATUS.CLOSED;
export const MASK_FINALIZED = 1 << GAME_STATUS.FINALIZED;
export const MASK_SETTLED = 1 << GAME_STATUS.SETTLED;

export const MASK_LIVE = MASK_OPEN | MASK_ARMED;
export const MASK_RECENT = MASK_OPEN | MASK_ARMED | MASK_CLOSED | MASK_FINALIZED;

export function gameStatusLabel(status: number): string {
  switch (status) {
    case GAME_STATUS.OPEN: return "OPEN";
    case GAME_STATUS.ARMED: return "ARMED";
    case GAME_STATUS.CLOSED: return "CLOSED";
    case GAME_STATUS.FINALIZED: return "FINALIZED";
    case GAME_STATUS.SETTLED: return "SETTLED";
    default: return `UNKNOWN(${status})`;
  }
}