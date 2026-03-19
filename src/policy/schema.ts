export type SmallBigRatioPolicy = {
  smallCount: number;
  bigCount: number;
  bigThresholdUsd: number;
};

export type AgentPolicy = {
  enabled: boolean;

  minGameStakeUsd?: number;
  maxSingleThrowUsd?: number;
  maxGameExposureUsd?: number;

  smallBigRatio?: SmallBigRatioPolicy;
  avoidAllIn?: boolean;

  copySlammerWhenSameHoleType?: boolean;

  allowedAssets?: string[];
  blockedAssets?: string[];

  maxThrowsPerGame?: number;
  maxThrowsPerSession?: number;
  minMillisBetweenLiveThrows?: number;
  reserveBalanceBase?: string;

  notes?: string[];
};

export const DEFAULT_POLICY: AgentPolicy = {
  enabled: true,
  avoidAllIn: true,
  maxThrowsPerGame: 3,
  maxThrowsPerSession: 50,
  minMillisBetweenLiveThrows: 20000,
  notes: [],
};