import {DOCTRINE_SEEDS,DOCTRINE_KNOWLEDGE_VERSION,doctrineSeed,type DoctrineSeed} from './doctrine-knowledge.js';
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
  knowledgeVersion: string;
  doctrineSeed: DoctrineSeed;
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
    summary: DOCTRINE_SEEDS.nutjob.thesis,
    defaults: {
      riskMode: "aggressive",
      customStrategy: "nutjob_discovery",
      copySlammerWhenSameHoleType: false,
    },
    goalWeights: {"profitMaxing":0.1,"ladderMaxing":0.1,"selfAwarenessMaxing":0.15,"discoveryMapping":0.65},
    notes: [...DOCTRINE_SEEDS.nutjob.beliefs, DOCTRINE_SEEDS.nutjob.search, DOCTRINE_SEEDS.nutjob.recovery],
  },
  tough_nut: {
    id: "tough_nut",
    label: "ToughNut",
    summary: DOCTRINE_SEEDS.tough_nut.thesis,
    defaults: {
      riskMode: "balanced",
      customStrategy: "toughnut_never_lose",
      copySlammerWhenSameHoleType: true,
    },
    goalWeights: {"profitMaxing":0.65,"ladderMaxing":0.1,"selfAwarenessMaxing":0.2,"discoveryMapping":0.05},
    notes: [...DOCTRINE_SEEDS.tough_nut.beliefs, DOCTRINE_SEEDS.tough_nut.search, DOCTRINE_SEEDS.tough_nut.recovery],
  },
  peanut: {
    id: "peanut",
    label: "Peanut",
    summary: DOCTRINE_SEEDS.peanut.thesis,
    defaults: {
      riskMode: "defensive",
      customStrategy: "peanut_safe_flow",
      copySlammerWhenSameHoleType: false,
    },
    goalWeights: {"profitMaxing":0.15,"ladderMaxing":0.65,"selfAwarenessMaxing":0.15,"discoveryMapping":0.05},
    notes: [...DOCTRINE_SEEDS.peanut.beliefs, DOCTRINE_SEEDS.peanut.search, DOCTRINE_SEEDS.peanut.recovery],
  },
  prof_deez_nutz: {
    id: "prof_deez_nutz",
    label: "Prof DeezNutz",
    summary: DOCTRINE_SEEDS.prof_deez_nutz.thesis,
    defaults: {
      riskMode: "balanced",
      customStrategy: "prof_meta_rotator",
      copySlammerWhenSameHoleType: false,
    },
    goalWeights: {"profitMaxing":0.15,"ladderMaxing":0.1,"selfAwarenessMaxing":0.65,"discoveryMapping":0.1},
    notes: [...DOCTRINE_SEEDS.prof_deez_nutz.beliefs, DOCTRINE_SEEDS.prof_deez_nutz.search, DOCTRINE_SEEDS.prof_deez_nutz.recovery],
  },
};

function cleanStrategyName(value: unknown): string | null {
  const trimmed = String(value ?? "").trim();
  return trimmed ? trimmed : null;
}

function normalizePackId(value: unknown): DoctrinePackId {
  const candidate = String(value ?? "").trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(DOCTRINE_PACK_PRESETS,candidate)
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
    knowledgeVersion: DOCTRINE_KNOWLEDGE_VERSION,
    doctrineSeed: doctrineSeed(doctrinePack),
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
