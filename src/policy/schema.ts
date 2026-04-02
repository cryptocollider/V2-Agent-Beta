export type SmallBigRatioPolicy = {
  smallCount: number;
  bigCount: number;
  bigThresholdUsd: number;
};

export type RiskMode = "defensive" | "balanced" | "aggressive";

export type AgentPolicy = {
  enabled: boolean;

  minGameStakeUsd?: number;
  maxSingleThrowUsd?: number;
  maxGameExposureUsd?: number;
  minThrowUsd?: number;
  maxThrowUsd?: number;

  smallBigRatio?: SmallBigRatioPolicy;
  avoidAllIn?: boolean;
  riskMode?: RiskMode;

  copySlammerWhenSameHoleType?: boolean;

  allowedAssets?: string[];
  blockedAssets?: string[];
  keepAssets?: string[];
  disposeAssets?: string[];

  maxThrowsPerGame?: number;
  maxThrowsPerSession?: number;
  minMillisBetweenLiveThrows?: number;
  reserveBalanceBase?: string;
  targetBalanceUsd?: number;
  targetProfitUsd?: number;

  notes?: string[];
};

export const DEFAULT_POLICY: AgentPolicy = {
  enabled: true,
  avoidAllIn: true,
  maxThrowsPerGame: 23,
  maxThrowsPerSession: 500,
  minMillisBetweenLiveThrows: 20000,
  notes: [],
};