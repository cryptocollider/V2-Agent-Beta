import type { AgentSettings } from "../core/settings.js";

export const MANAGER_LLM_PROVIDER_IDS = [
  "venice",
  "openai",
  "openrouter",
  "google",
  "anthropic",
  "ollama",
  "huggingface",
  "local",
] as const;

export type LlmProviderId = (typeof MANAGER_LLM_PROVIDER_IDS)[number];

const MANAGER_LLM_KEYLESS_PROVIDER_SET = new Set<LlmProviderId>(["ollama", "local"]);

export function managerLlmProviderNeedsApiKey(provider: LlmProviderId): boolean {
  return !MANAGER_LLM_KEYLESS_PROVIDER_SET.has(provider);
}

export type ManagerLlmProviderConfig = {
  enabled: boolean;
  model: string;
  endpointUrl: string;
  apiKey: string | null;
};

export type ManagerLlmConfig = {
  activeProvider: LlmProviderId;
  autoApply: boolean;
  providers: Record<LlmProviderId, ManagerLlmProviderConfig>;
};

export type ManagerLlmChatRole = "user" | "assistant";

export type ManagerLlmChatMessage = {
  id: string;
  role: ManagerLlmChatRole;
  content: string;
  createdAt: string;
};

export type ManagerLlmActionKind =
  | "settings_patch"
  | "overlay"
  | "candidate_set"
  | "target_game"
  | "clear_target_game";

export type ManagerLlmAction = {
  id: string;
  kind: ManagerLlmActionKind;
  title: string;
  why: string;
  payload: Record<string, unknown> | null;
  createdAt: string;
  appliedAt: string | null;
  rejectedAt: string | null;
  rejection: string | null;
  guidedAt: string | null;
  guideMessage: string | null;
  hiddenAt: string | null;
  failedAt: string | null;
  failure: string | null;
};

export type ManagerLlmState = {
  config: ManagerLlmConfig;
  history: ManagerLlmChatMessage[];
  pendingActions: ManagerLlmAction[];
  busy: boolean;
  lastError: string | null;
  lastUpdatedAt: string | null;
  lastProvider: LlmProviderId | null;
  lastSummary: string | null;
};

export type PublicManagerLlmProviderConfig = Omit<ManagerLlmProviderConfig, "apiKey"> & {
  apiKeyConfigured: boolean;
  apiKeyPreview: string | null;
};

export type PublicManagerLlmConfig = {
  activeProvider: LlmProviderId;
  autoApply: boolean;
  providers: Record<LlmProviderId, PublicManagerLlmProviderConfig>;
};

export type PublicManagerLlmState = Omit<ManagerLlmState, "config"> & {
  config: PublicManagerLlmConfig;
};

export type ManagerChatProposal = {
  kind: ManagerLlmActionKind;
  title: string;
  why: string;
  payload: Record<string, unknown> | null;
};

export type ParsedManagerChatResponse = {
  reply: string;
  summary: string | null;
  proposals: ManagerChatProposal[];
};

export type ProviderConversationMessage = {
  role: ManagerLlmChatRole;
  content: string;
};

export type ManagerProviderRequest = {
  config: ManagerLlmProviderConfig;
  systemPrompt: string;
  messages: ProviderConversationMessage[];
};

export type ManagerProviderResult = {
  provider: LlmProviderId;
  model: string;
  text: string;
  usage: Record<string, unknown> | null;
};

export type ManagerStateSnapshotForLlm = {
  generatedAt: string;
  settings: Partial<AgentSettings> & Record<string, unknown>;
  runtime: Record<string, unknown> | null;
  onboarding: Record<string, unknown> | null;
  profile: Record<string, unknown> | null;
  control: Record<string, unknown> | null;
  audit: Record<string, unknown> | null;
  latestEligibility: Record<string, unknown> | null;
  eligibilityCode: string | null;
  latestCandidates: Record<string, unknown> | null;
  overlay: Record<string, unknown> | null;
  managerCandidateSet: Record<string, unknown> | null;
  honestPerformance: Record<string, unknown> | null;
};

// Starter model ids are intentionally editable in the monitor dock.
export const DEFAULT_MANAGER_LLM_CONFIG: ManagerLlmConfig = {
  activeProvider: "venice",
  autoApply: false,
  providers: {
    venice: {
      enabled: false,
      model: "zai-org-glm-4.7",
      endpointUrl: "https://api.venice.ai/api/v1/chat/completions",
      apiKey: null,
    },
    openai: {
      enabled: false,
      model: "gpt-5.4-mini",
      endpointUrl: "https://api.openai.com/v1/responses",
      apiKey: null,
    },
    openrouter: {
      enabled: false,
      model: "meta-llama/llama-3.3-8b-instruct:free",
      endpointUrl: "https://openrouter.ai/api/v1/chat/completions",
      apiKey: null,
    },
    google: {
      enabled: false,
      model: "gemini-2.0-flash",
      endpointUrl: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      apiKey: null,
    },
    anthropic: {
      enabled: false,
      model: "claude-sonnet-4-20250514",
      endpointUrl: "https://api.anthropic.com/v1/messages",
      apiKey: null,
    },
    ollama: {
      enabled: false,
      model: "llama3.1:8b",
      endpointUrl: "http://127.0.0.1:11434/api/chat",
      apiKey: null,
    },
    huggingface: {
      enabled: false,
      model: "openai/gpt-oss-120b",
      endpointUrl: "https://router.huggingface.co/v1/chat/completions",
      apiKey: null,
    },
    local: {
      enabled: false,
      model: "local-model",
      endpointUrl: "http://127.0.0.1:1234/v1/chat/completions",
      apiKey: null,
    },
  },
};
