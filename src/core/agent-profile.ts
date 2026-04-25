import type { RiskMode } from "../policy/schema.js";
import type { AgentSettings } from "./settings.js";

export type DoctrinePackId =
  | "baseline"
  | "nutjob"
  | "tough_nut"
  | "peanut"
  | "prof_deez_nutz";

export type GoalWeights = {
  profitMaxing: number;
  ladderMaxing: number;
  selfAwarenessMaxing: number;
  discoveryMapping: number;
};

type DoctrinePackPreset = {
  id: DoctrinePackId;
  label: string;
  summary: string;
  defaults: {
    riskMode?: RiskMode;
    customStrategy?: string | null;
    copySlammerWhenSameHoleType?: boolean;
  };
  goalWeights: GoalWeights;
  notes: string[];
};

export type ResolvedAgentProfile = {
  doctrinePack: DoctrinePackId;
  doctrineLabel: string;
  doctrineSummary: string;
  goalWeights: GoalWeights;
  goalWeightsPct: GoalWeights;
  effective: {
    riskMode: RiskMode;
    customStrategy: string | null;
    copySlammerWhenSameHoleType: boolean;
  };
  defaultsApplied: {
    riskMode: boolean;
    customStrategy: boolean;
    copySlammerWhenSameHoleType: boolean;
  };
  notes: string[];
};

const DEFAULT_DOCTRINE_PACK: DoctrinePackId = "baseline";

export const DEFAULT_GOAL_WEIGHTS: GoalWeights = {
  profitMaxing: 0.25,
  ladderMaxing: 0.25,
  selfAwarenessMaxing: 0.25,
  discoveryMapping: 0.25,
};

export const DOCTRINE_PACK_PRESETS: Record<DoctrinePackId, DoctrinePackPreset> = {
  baseline: {
    id: "baseline",
    label: "Baseline",
    summary: "Neutral starting state for Agent 1. Preserve the raw baseline truth before stronger doctrine takes over.",
    defaults: {
      riskMode: "balanced",
      customStrategy: null,
      copySlammerWhenSameHoleType: false,
    },
    goalWeights: { ...DEFAULT_GOAL_WEIGHTS },
    notes: [
      "Use when establishing an empirical baseline before stronger doctrine takes control.",
      "Leaves custom strategy open so the manager can name its own profile cleanly.",
    ],
  },
  nutjob: {
    id: "nutjob",
    label: "NutJob",
    summary: "Explore weird lines, test strange boards, and push discovery harder than comfort.",
    defaults: {
      riskMode: "aggressive",
      customStrategy: "nutjob_discovery",
      copySlammerWhenSameHoleType: false,
    },
    goalWeights: {
      profitMaxing: 0.14,
      ladderMaxing: 0.16,
      selfAwarenessMaxing: 0.18,
      discoveryMapping: 0.52,
    },
    notes: [
      "Bias toward novelty and board discovery.",
      "Best when the manager wants to map the space instead of polishing one local optimum.",
    ],
  },
  tough_nut: {
    id: "tough_nut",
    label: "ToughNut",
    summary: "Refuse to lose. Keep leaning on live boards that can still be saved, borrow proven winner lines when useful, and trade comfort for survival time.",
    defaults: {
      riskMode: "aggressive",
      customStrategy: "toughnut_never_lose",
      copySlammerWhenSameHoleType: true,
    },
    goalWeights: {
      profitMaxing: 0.52,
      ladderMaxing: 0.2,
      selfAwarenessMaxing: 0.2,
      discoveryMapping: 0.08,
    },
    notes: [
      "Built around not accepting a losing projection while the board is still alive.",
      "Defaults to the ToughNut never-lose hook while still enabling historical winner seeds.",
    ],
  },
  peanut: {
    id: "peanut",
    label: "Peanut",
    summary: "Play small, stay alive, and optimize for repeatable discipline before bravado.",
    defaults: {
      riskMode: "defensive",
      customStrategy: "peanut_safe_flow",
      copySlammerWhenSameHoleType: false,
    },
    goalWeights: {
      profitMaxing: 0.38,
      ladderMaxing: 0.18,
      selfAwarenessMaxing: 0.28,
      discoveryMapping: 0.16,
    },
    notes: [
      "Bias toward survivability and clean calibration.",
      "Useful when bankroll protection matters more than frontier exploration.",
    ],
  },
  prof_deez_nutz: {
    id: "prof_deez_nutz",
    label: "Prof DeezNutz",
    summary: "Meta-manager doctrine. Watch the whole board, compare personas, and compose hybrid strategies.",
    defaults: {
      riskMode: "balanced",
      customStrategy: "prof_meta_rotator",
      copySlammerWhenSameHoleType: false,
    },
    goalWeights: {
      profitMaxing: 0.24,
      ladderMaxing: 0.18,
      selfAwarenessMaxing: 0.22,
      discoveryMapping: 0.36,
    },
    notes: [
      "Best when the manager is reasoning across multiple sub-styles instead of committing to one.",
      "Designed for system-level learning and composition rather than one-dimensional aggression.",
    ],
  },
};

function cleanStrategyName(value: unknown): string | null {
  const trimmed = String(value ?? "").trim();
  return trimmed ? trimmed : null;
}

function normalizePackId(value: unknown): DoctrinePackId {
  const candidate = String(value ?? "").trim().toLowerCase();
  return (candidate in DOCTRINE_PACK_PRESETS)
    ? (candidate as DoctrinePackId)
    : DEFAULT_DOCTRINE_PACK;
}

function normalizeRiskMode(value: unknown): RiskMode | undefined {
  const candidate = String(value ?? "").trim().toLowerCase();
  if (candidate === "defensive" || candidate === "balanced" || candidate === "aggressive") {
    return candidate;
  }
  return undefined;
}

function normalizeWeight(value: unknown): number | undefined {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return undefined;
  return numeric;
}

export function normalizeGoalWeights(
  value: Partial<Record<keyof GoalWeights, unknown>> | null | undefined,
  fallback: GoalWeights = DEFAULT_GOAL_WEIGHTS,
): GoalWeights {
  const raw: GoalWeights = {
    profitMaxing: normalizeWeight(value?.profitMaxing) ?? fallback.profitMaxing,
    ladderMaxing: normalizeWeight(value?.ladderMaxing) ?? fallback.ladderMaxing,
    selfAwarenessMaxing: normalizeWeight(value?.selfAwarenessMaxing) ?? fallback.selfAwarenessMaxing,
    discoveryMapping: normalizeWeight(value?.discoveryMapping) ?? fallback.discoveryMapping,
  };

  const total = Object.values(raw).reduce((sum, entry) => sum + entry, 0);
  if (!(total > 0)) return { ...fallback };

  return {
    profitMaxing: raw.profitMaxing / total,
    ladderMaxing: raw.ladderMaxing / total,
    selfAwarenessMaxing: raw.selfAwarenessMaxing / total,
    discoveryMapping: raw.discoveryMapping / total,
  };
}

function toPctMap(weights: GoalWeights): GoalWeights {
  return {
    profitMaxing: weights.profitMaxing * 100,
    ladderMaxing: weights.ladderMaxing * 100,
    selfAwarenessMaxing: weights.selfAwarenessMaxing * 100,
    discoveryMapping: weights.discoveryMapping * 100,
  };
}

export function resolveAgentProfile(settings: Partial<AgentSettings> | null | undefined): ResolvedAgentProfile {
  const doctrinePack = normalizePackId(settings?.doctrinePack);
  const preset = DOCTRINE_PACK_PRESETS[doctrinePack];

  const explicitRiskMode = normalizeRiskMode(settings?.riskMode);
  const explicitCustomStrategy = cleanStrategyName(settings?.customStrategy);
  const explicitCopySlammers =
    typeof settings?.copySlammerWhenSameHoleType === "boolean"
      ? settings.copySlammerWhenSameHoleType
      : undefined;

  const effectiveRiskMode = explicitRiskMode ?? preset.defaults.riskMode ?? "balanced";
  const effectiveCustomStrategy = explicitCustomStrategy ?? preset.defaults.customStrategy ?? null;
  const inferredCopyFromStrategy = String(effectiveCustomStrategy || "").trim().toLowerCase() === "copy_slammers";
  const effectiveCopySlammers = explicitCopySlammers
    ?? preset.defaults.copySlammerWhenSameHoleType
    ?? inferredCopyFromStrategy;

  const goalWeights = normalizeGoalWeights(
    (settings?.goalWeights ?? null) as Partial<Record<keyof GoalWeights, unknown>> | null,
    preset.goalWeights,
  );

  return {
    doctrinePack,
    doctrineLabel: preset.label,
    doctrineSummary: preset.summary,
    goalWeights,
    goalWeightsPct: toPctMap(goalWeights),
    effective: {
      riskMode: effectiveRiskMode,
      customStrategy: effectiveCustomStrategy,
      copySlammerWhenSameHoleType: !!effectiveCopySlammers,
    },
    defaultsApplied: {
      riskMode: explicitRiskMode == null,
      customStrategy: explicitCustomStrategy == null,
      copySlammerWhenSameHoleType: explicitCopySlammers == null,
    },
    notes: [...preset.notes],
  };
}
