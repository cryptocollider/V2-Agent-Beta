import type { AgentSettings } from "../core/settings.js";

export type SettingImplementationState = "implemented" | "partial" | "missing";

export type SettingsAuditKey = keyof Pick<
  AgentSettings,
  | "asset"
  | "amount"
  | "maxCandidates"
  | "maxMs"
  | "pollMs"
  | "maxThrowsPerGame"
  | "maxThrowsPerSession"
  | "minMillisBetweenLiveThrows"
  | "minGameStakeUsd"
  | "maxSingleThrowUsd"
  | "maxGameExposureUsd"
  | "minThrowUsd"
  | "maxThrowUsd"
  | "riskMode"
  | "copySlammerWhenSameHoleType"
  | "allowedAssets"
  | "blockedAssets"
  | "reserveBalanceBase"
  | "targetBalanceUsd"
  | "targetProfitUsd"
  | "keepAssets"
  | "disposeAssets"
>;

export type SettingsAuditEntry = {
  key: SettingsAuditKey;
  state: SettingImplementationState;
  currentValue: unknown;
  summary: string;
  evidence: string[];
  gaps: string[];
};

export type SettingsAuditReport = {
  ts: string;
  counts: Record<SettingImplementationState, number>;
  matrix: SettingsAuditEntry[];
};

type AuditTemplate = Omit<SettingsAuditEntry, "currentValue">;

const AUDIT_TEMPLATES: AuditTemplate[] = [
  {
    key: "asset",
    state: "implemented",
    summary: "Configured default asset is used as the baseline candidate asset when allowed-assets is empty.",
    evidence: ["runtime-settings", "loop defaultAsset", "monitor settings API"],
    gaps: [],
  },
  {
    key: "amount",
    state: "implemented",
    summary: "Configured default amount is used as the baseline amount and as the fallback anchor for amount generation.",
    evidence: ["runtime-settings", "loop defaultAmount", "monitor settings API"],
    gaps: [],
  },
  {
    key: "maxCandidates",
    state: "implemented",
    summary: "Candidate search budget caps the number of candidates examined per cycle.",
    evidence: ["candidateBudget.maxCandidates", "chooseBestRanked", "runs search log"],
    gaps: [],
  },
  {
    key: "maxMs",
    state: "implemented",
    summary: "Candidate search budget caps the time spent examining ranked candidates per cycle.",
    evidence: ["candidateBudget.maxMillis", "chooseBestRanked", "runs search log"],
    gaps: [],
  },
  {
    key: "pollMs",
    state: "implemented",
    summary: "Session polling interval is read live from runtime settings.",
    evidence: ["session sleep loop", "monitor settings API"],
    gaps: [],
  },
  {
    key: "maxThrowsPerGame",
    state: "implemented",
    summary: "Per-game session throw cap is enforced before candidate search.",
    evidence: ["session filteredClient.listGames", "recent game touch map"],
    gaps: [],
  },
  {
    key: "maxThrowsPerSession",
    state: "implemented",
    summary: "Session throw cap pauses live throwing when reached.",
    evidence: ["session auto pause", "control state lastAction"],
    gaps: [],
  },
  {
    key: "minMillisBetweenLiveThrows",
    state: "implemented",
    summary: "Live throw cooldown is enforced between successful submissions.",
    evidence: ["session lastLiveThrowAt gate"],
    gaps: [],
  },
  {
    key: "minGameStakeUsd",
    state: "implemented",
    summary: "Games below the configured stake threshold are excluded before selection.",
    evidence: ["game eligibility filter"],
    gaps: [],
  },
  {
    key: "maxSingleThrowUsd",
    state: "implemented",
    summary: "Candidates above the configured single-throw cap are rejected.",
    evidence: ["bankroll max single throw check", "candidate filter diagnostics"],
    gaps: [],
  },
  {
    key: "maxGameExposureUsd",
    state: "implemented",
    summary: "Games and candidates that would exceed configured total game exposure are rejected.",
    evidence: ["game eligibility filter", "candidate exposure check"],
    gaps: [],
  },
  {
    key: "minThrowUsd",
    state: "implemented",
    summary: "Candidates below the configured minimum USD throw value are rejected.",
    evidence: ["USD target generation", "candidate filter diagnostics"],
    gaps: [],
  },
  {
    key: "maxThrowUsd",
    state: "partial",
    summary: "Maximum throw USD shapes generated target sizes and now hard-rejects oversized candidates.",
    evidence: ["USD target generation", "candidate filter diagnostics"],
    gaps: ["If the current game has no priced throws yet, sizing now falls back to the latest internally observed asset price from recent sim inputs. External oracle validation is still pending."],
  },
  {
    key: "riskMode",
    state: "partial",
    summary: "Risk mode biases the generated USD targets but does not yet change deeper tactical search behavior.",
    evidence: ["USD target generation"],
    gaps: ["No map/opponent/search-depth behavior change yet."],
  },
  {
    key: "copySlammerWhenSameHoleType",
    state: "partial",
    summary: "Copy mode seeds historical winning trajectories into the candidate pool when enabled.",
    evidence: ["historical result seed loader"],
    gaps: ["It does not yet clone current same-hole-type live slammers directly from live game state."],
  },
  {
    key: "allowedAssets",
    state: "implemented",
    summary: "Allowed assets restrict which assets can enter candidate generation.",
    evidence: ["asset planning filter"],
    gaps: [],
  },
  {
    key: "blockedAssets",
    state: "implemented",
    summary: "Blocked assets are removed before amount generation and candidate creation.",
    evidence: ["asset planning filter"],
    gaps: [],
  },
  {
    key: "reserveBalanceBase",
    state: "implemented",
    summary: "Reserve balance is enforced before amount generation and before each candidate amount is accepted.",
    evidence: ["asset planning balance gate"],
    gaps: [],
  },
  {
    key: "targetBalanceUsd",
    state: "implemented",
    summary: "Live play halts when known wallet value meets the configured target balance.",
    evidence: ["target balance gate"],
    gaps: ["Only balances with a known price basis contribute to the known USD total."],
  },
  {
    key: "targetProfitUsd",
    state: "implemented",
    summary: "Live play pauses after realized profit reaches the configured threshold.",
    evidence: ["session cumulative realized profit gate"],
    gaps: [],
  },
  {
    key: "keepAssets",
    state: "partial",
    summary: "Keep-assets currently acts as a soft asset ordering preference in candidate generation.",
    evidence: ["asset pair ordering"],
    gaps: ["No dedicated routing, retention, or rebalance logic yet."],
  },
  {
    key: "disposeAssets",
    state: "partial",
    summary: "Dispose-assets currently acts as a soft asset ordering preference in candidate generation.",
    evidence: ["asset pair ordering"],
    gaps: ["No dedicated disposal or conversion flow yet."],
  },
];

export function buildSettingsAuditReport(settings: Partial<AgentSettings>): SettingsAuditReport {
  const matrix = AUDIT_TEMPLATES.map((entry) => ({
    ...entry,
    currentValue: settings[entry.key],
  }));

  const counts: Record<SettingImplementationState, number> = {
    implemented: 0,
    partial: 0,
    missing: 0,
  };

  for (const entry of matrix) {
    counts[entry.state] += 1;
  }

  return {
    ts: new Date().toISOString(),
    counts,
    matrix,
  };
}
