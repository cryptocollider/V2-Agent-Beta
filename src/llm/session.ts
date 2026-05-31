import { invokeManagerProvider } from "./registry.js";
import {
  managerLlmProviderNeedsApiKey,
  type LlmProviderId,
  type ManagerChatProposal,
  type ManagerLlmAction,
  type ManagerLlmActionKind,
  type ManagerLlmChatMessage,
  type ManagerLlmConfig,
  type ManagerStateSnapshotForLlm,
  type ParsedManagerChatResponse,
} from "./types.js";

function extractJsonObject(raw: string): string {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) throw new Error("Empty manager response.");
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    const candidate = fenced[1].trim();
    if (candidate.startsWith("{") && candidate.endsWith("}")) return candidate;
  }

  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) return trimmed.slice(first, last + 1);

  throw new Error("Manager response did not contain a JSON object.");
}

function normalizeActionKind(value: unknown): ManagerLlmActionKind | null {
  const candidate = String(value ?? "").trim().toLowerCase();
  switch (candidate) {
    case "settings_patch":
    case "overlay":
    case "candidate_set":
    case "target_game":
    case "clear_target_game":
      return candidate;
    default:
      return null;
  }
}

function pickProposalPayload(kind: ManagerLlmActionKind, raw: Record<string, unknown>): Record<string, unknown> | null {
  if (raw.payload && typeof raw.payload === "object") return JSON.parse(JSON.stringify(raw.payload)) as Record<string, unknown>;
  if (kind === "settings_patch" && raw.settingsPatch && typeof raw.settingsPatch === "object") {
    return JSON.parse(JSON.stringify(raw.settingsPatch)) as Record<string, unknown>;
  }
  if (kind === "overlay" && raw.overlay && typeof raw.overlay === "object") {
    return JSON.parse(JSON.stringify(raw.overlay)) as Record<string, unknown>;
  }
  if (kind === "candidate_set" && raw.managerCandidateSet && typeof raw.managerCandidateSet === "object") {
    return JSON.parse(JSON.stringify(raw.managerCandidateSet)) as Record<string, unknown>;
  }
  if (kind === "target_game") {
    const gameId = String(raw.gameId ?? raw.targetGameId ?? "").trim();
    return gameId ? { gameId } : null;
  }
  return null;
}

function normalizeProposals(value: unknown): ManagerChatProposal[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const raw = entry as Record<string, unknown>;
    const kind = normalizeActionKind(raw.kind);
    if (!kind) return [];
    const title = String(raw.title ?? "").trim() || "Manager proposal";
    const why = String(raw.why ?? raw.reason ?? "").trim();
    return [{
      kind,
      title,
      why,
      payload: pickProposalPayload(kind, raw),
    }];
  });
}

function buildSupportSeed(): string {
  return [
    "You are the embedded Agent 1 manager for Collider V2.",
    "Your first job is to remove friction for the human: explain state, unblock setup, reduce confusion, and suggest the smallest safe next step.",
    "Your second job is to guide Agent 1 toward stronger strategy, bankroll control, asset selection, game selection, portfolio posture, and later collaboration or team-forming ideas.",
    "You do not control raw execution. Agent 1 remains the deterministic truth surface.",
    "You may only propose bounded actions through these kinds: settings_patch, overlay, candidate_set, target_game, clear_target_game.",
    "Never claim you executed an action unless it has been applied outside the model.",
    "Use exact labels from the manager state whenever possible.",
    "Keep replies concise, direct, and helpful.",
    "Return strict JSON only with this shape:",
    '{"reply":"short human-facing reply","summary":"one-line operator summary","proposals":[{"kind":"settings_patch","title":"...","why":"...","payload":{}}]}',
    "If no action is needed, return proposals as an empty array.",
  ].join("\n");
}

function compactManagerState(snapshot: ManagerStateSnapshotForLlm): Record<string, unknown> {
  const settings = snapshot.settings ?? {};
  const latestCandidates = snapshot.latestCandidates ?? null;
  const candidateRows = Array.isArray((latestCandidates as any)?.candidates)
    ? ((latestCandidates as any).candidates as any[]).slice(0, 3).map((candidate) => ({
      candidateHash: candidate?.candidateHash ?? null,
      holeType: candidate?.prediction?.holeType ?? candidate?.basePrediction?.holeType ?? null,
      predictedPnlUsd: candidate?.prediction?.pnlUsd ?? candidate?.basePrediction?.pnlUsd ?? null,
      adjustedScore: candidate?.adjustedScore ?? null,
      baseScore: candidate?.baseScore ?? null,
      amount: candidate?.payload?.amount ?? null,
      asset: candidate?.payload?.asset ?? null,
    }))
    : [];
  const unifiedMaxThrowUsd = settings.maxThrowUsd ?? settings.maxSingleThrowUsd ?? null;
  return {
    generatedAt: snapshot.generatedAt,
    profile: snapshot.profile ?? null,
    onboarding: snapshot.onboarding ?? null,
    control: snapshot.control ?? null,
    settings: {
      user: settings.user ?? null,
      asset: settings.asset ?? null,
      amount: settings.amount ?? null,
      riskMode: settings.riskMode ?? null,
      doctrinePack: settings.doctrinePack ?? null,
      customStrategy: settings.customStrategy ?? null,
      goalWeights: settings.goalWeights ?? null,
      minGameStakeUsd: settings.minGameStakeUsd ?? null,
      minThrowUsd: settings.minThrowUsd ?? null,
      maxThrowUsd: unifiedMaxThrowUsd,
      maxSingleThrowUsd: unifiedMaxThrowUsd,
      maxGameExposureUsd: settings.maxGameExposureUsd ?? null,
      targetBalanceUsd: settings.targetBalanceUsd ?? null,
      targetProfitUsd: settings.targetProfitUsd ?? null,
      allowedAssets: settings.allowedAssets ?? [],
      blockedAssets: settings.blockedAssets ?? [],
      keepAssets: settings.keepAssets ?? [],
      disposeAssets: settings.disposeAssets ?? [],
      humanLearning: settings.humanLearning ?? null,
    },
    audit: snapshot.audit ?? null,
    latestEligibility: snapshot.latestEligibility ?? null,
    eligibilityCode: snapshot.eligibilityCode ?? null,
    latestCandidates: latestCandidates
      ? {
        ts: (latestCandidates as any).ts ?? null,
        gameId: (latestCandidates as any).gameId ?? null,
        stoppedBy: (latestCandidates as any).stoppedBy ?? null,
        winnerCandidateHash: (latestCandidates as any).winnerCandidateHash ?? null,
        candidates: candidateRows,
      }
      : null,
    overlay: snapshot.overlay ?? null,
    managerCandidateSet: snapshot.managerCandidateSet ?? null,
    honestPerformance: snapshot.honestPerformance ?? null,
  };
}

export function parseManagerChatResponse(rawText: string): ParsedManagerChatResponse {
  const parsed = JSON.parse(extractJsonObject(rawText)) as Record<string, unknown>;
  const reply = String(parsed.reply ?? parsed.message ?? parsed.response ?? "").trim();
  if (!reply) throw new Error("Manager response JSON is missing a reply.");
  return {
    reply,
    summary: String(parsed.summary ?? "").trim() || null,
    proposals: normalizeProposals(parsed.proposals),
  };
}

function buildActionId(kind: ManagerLlmActionKind, index: number): string {
  return `${kind}-${Date.now()}-${index + 1}`;
}

function toPersistedActions(proposals: ManagerChatProposal[]): ManagerLlmAction[] {
  const createdAt = new Date().toISOString();
  return proposals.map((proposal, index) => ({
    id: buildActionId(proposal.kind, index),
    kind: proposal.kind,
    title: proposal.title,
    why: proposal.why,
    payload: proposal.payload,
    createdAt,
    appliedAt: null,
    rejectedAt: null,
    rejection: null,
    guidedAt: null,
    guideMessage: null,
    hiddenAt: null,
    failedAt: null,
    failure: null,
  }));
}

export async function runManagerConversation(args: {
  provider: LlmProviderId;
  config: ManagerLlmConfig;
  history: ManagerLlmChatMessage[];
  snapshot: ManagerStateSnapshotForLlm;
}): Promise<{ reply: string; summary: string | null; actions: ManagerLlmAction[] }> {
  const providerConfig = args.config.providers[args.provider];
  if (!providerConfig.enabled) throw new Error(`${args.provider} is disabled.`);
  if (managerLlmProviderNeedsApiKey(args.provider) && !providerConfig.apiKey) {
    throw new Error(`${args.provider} is missing an API key.`);
  }
  if (!providerConfig.model) throw new Error(`${args.provider} is missing a model id.`);

  const systemPrompt = [
    buildSupportSeed(),
    "",
    "Current Agent 1 manager snapshot (JSON):",
    JSON.stringify(compactManagerState(args.snapshot), null, 2),
  ].join("\n");

  const providerResult = await invokeManagerProvider(args.provider, {
    config: providerConfig,
    systemPrompt,
    messages: args.history.slice(-10).map((message) => ({
      role: message.role,
      content: message.content,
    })),
  });

  const parsed = parseManagerChatResponse(providerResult.text);
  return {
    reply: parsed.reply,
    summary: parsed.summary,
    actions: toPersistedActions(parsed.proposals),
  };
}
