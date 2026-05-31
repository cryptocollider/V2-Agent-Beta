import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_MANAGER_LLM_CONFIG,
  MANAGER_LLM_PROVIDER_IDS,
  type LlmProviderId,
  type ManagerLlmAction,
  type ManagerLlmChatMessage,
  type ManagerLlmConfig,
  type ManagerLlmProviderConfig,
  type ManagerLlmState,
  type PublicManagerLlmConfig,
  type PublicManagerLlmProviderConfig,
  type PublicManagerLlmState,
} from "./types.js";

const MANAGER_LLM_FILE = "manager-llm.json";
const MAX_HISTORY = 18;
const MAX_ACTIONS = 18;

let dataDir = "./data";
let managerLlmState: ManagerLlmState = buildDefaultManagerLlmState();

type ProviderConfigPatch = Partial<ManagerLlmProviderConfig> & {
  clearApiKey?: boolean;
};

export type ManagerLlmConfigPatch = {
  activeProvider?: unknown;
  autoApply?: unknown;
  providers?: Partial<Record<LlmProviderId, ProviderConfigPatch>>;
};

function clone<T>(value: T): T {
  return value == null ? value : JSON.parse(JSON.stringify(value)) as T;
}

function llmFile(): string {
  return path.join(dataDir, MANAGER_LLM_FILE);
}

function normalizeProviderId(value: unknown): LlmProviderId {
  const candidate = String(value ?? "").trim().toLowerCase();
  return (MANAGER_LLM_PROVIDER_IDS as readonly string[]).includes(candidate)
    ? candidate as LlmProviderId
    : DEFAULT_MANAGER_LLM_CONFIG.activeProvider;
}

function normalizeProviderConfig(
  value: Partial<ManagerLlmProviderConfig> | null | undefined,
  fallback: ManagerLlmProviderConfig,
): ManagerLlmProviderConfig {
  const model = String(value?.model ?? fallback.model).trim();
  const endpointUrl = String(value?.endpointUrl ?? fallback.endpointUrl).trim();
  const apiKey = String(value?.apiKey ?? "").trim();
  return {
    enabled: value?.enabled == null ? fallback.enabled : !!value.enabled,
    model: model || fallback.model,
    endpointUrl: endpointUrl || fallback.endpointUrl,
    apiKey: apiKey || null,
  };
}

function normalizeConfig(value: Partial<ManagerLlmConfig> | null | undefined): ManagerLlmConfig {
  const providers = Object.fromEntries(
    MANAGER_LLM_PROVIDER_IDS.map((providerId) => [
      providerId,
      normalizeProviderConfig(value?.providers?.[providerId], DEFAULT_MANAGER_LLM_CONFIG.providers[providerId]),
    ]),
  ) as Record<LlmProviderId, ManagerLlmProviderConfig>;
  return {
    activeProvider: normalizeProviderId(value?.activeProvider),
    autoApply: value?.autoApply == null ? DEFAULT_MANAGER_LLM_CONFIG.autoApply : !!value.autoApply,
    providers,
  };
}

function normalizeHistory(value: unknown): ManagerLlmChatMessage[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry, index) => {
      const role = String((entry as any)?.role ?? "").trim().toLowerCase();
      const content = String((entry as any)?.content ?? "").trim();
      if ((role !== "user" && role !== "assistant") || !content) return null;
      return {
        id: String((entry as any)?.id ?? `msg-${index + 1}`),
        role,
        content,
        createdAt: String((entry as any)?.createdAt ?? new Date().toISOString()),
      } as ManagerLlmChatMessage;
    })
    .filter((entry): entry is ManagerLlmChatMessage => !!entry)
    .slice(-MAX_HISTORY);
}

function normalizeActionKind(value: unknown): ManagerLlmAction["kind"] {
  const candidate = String(value ?? "").trim().toLowerCase();
  switch (candidate) {
    case "settings_patch":
    case "overlay":
    case "candidate_set":
    case "target_game":
    case "clear_target_game":
      return candidate;
    default:
      return "settings_patch";
  }
}

function normalizeAction(value: unknown, index: number): ManagerLlmAction | null {
  if (!value || typeof value !== "object") return null;
  const content = value as Record<string, unknown>;
  const title = String(content.title ?? "").trim();
  const why = String(content.why ?? "").trim();
  return {
    id: String(content.id ?? `action-${index + 1}`),
    kind: normalizeActionKind(content.kind),
    title: title || "Manager action",
    why,
    payload: content.payload && typeof content.payload === "object" ? clone(content.payload as Record<string, unknown>) : null,
    createdAt: String(content.createdAt ?? new Date().toISOString()),
    appliedAt: String(content.appliedAt ?? "").trim() || null,
    rejectedAt: String(content.rejectedAt ?? "").trim() || null,
    rejection: String(content.rejection ?? "").trim() || null,
    guidedAt: String(content.guidedAt ?? "").trim() || null,
    guideMessage: String(content.guideMessage ?? "").trim() || null,
    hiddenAt: String(content.hiddenAt ?? "").trim() || null,
    failedAt: String(content.failedAt ?? "").trim() || null,
    failure: String(content.failure ?? "").trim() || null,
  };
}

function normalizeActions(value: unknown): ManagerLlmAction[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry, index) => normalizeAction(entry, index))
    .filter((entry): entry is ManagerLlmAction => !!entry)
    .slice(-MAX_ACTIONS);
}

function buildDefaultManagerLlmState(): ManagerLlmState {
  return {
    config: normalizeConfig(DEFAULT_MANAGER_LLM_CONFIG),
    history: [],
    pendingActions: [],
    busy: false,
    lastError: null,
    lastUpdatedAt: null,
    lastProvider: null,
    lastSummary: null,
  };
}

function normalizeState(value: Partial<ManagerLlmState> | null | undefined): ManagerLlmState {
  return {
    ...buildDefaultManagerLlmState(),
    ...(value ?? {}),
    config: normalizeConfig(value?.config),
    history: normalizeHistory(value?.history),
    pendingActions: normalizeActions(value?.pendingActions),
    busy: !!value?.busy,
    lastError: String(value?.lastError ?? "").trim() || null,
    lastUpdatedAt: String(value?.lastUpdatedAt ?? "").trim() || null,
    lastProvider: value?.lastProvider ? normalizeProviderId(value.lastProvider) : null,
    lastSummary: String(value?.lastSummary ?? "").trim() || null,
  };
}

async function persistState(): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  await writeFile(llmFile(), JSON.stringify(managerLlmState, null, 2), "utf8");
}

async function updateState(mutator: (current: ManagerLlmState) => ManagerLlmState): Promise<ManagerLlmState> {
  managerLlmState = normalizeState(mutator(clone(managerLlmState)));
  await persistState();
  return getManagerLlmState();
}

function maskApiKey(apiKey: string | null): { apiKeyConfigured: boolean; apiKeyPreview: string | null } {
  const trimmed = String(apiKey ?? "").trim();
  if (!trimmed) return { apiKeyConfigured: false, apiKeyPreview: null };
  const tail = trimmed.slice(-4);
  return { apiKeyConfigured: true, apiKeyPreview: tail ? `...${tail}` : "saved" };
}

function toPublicProviderConfig(config: ManagerLlmProviderConfig): PublicManagerLlmProviderConfig {
  const masked = maskApiKey(config.apiKey);
  return {
    enabled: config.enabled,
    model: config.model,
    endpointUrl: config.endpointUrl,
    ...masked,
  };
}

function toPublicConfig(config: ManagerLlmConfig): PublicManagerLlmConfig {
  const providers = Object.fromEntries(
    MANAGER_LLM_PROVIDER_IDS.map((providerId) => [providerId, toPublicProviderConfig(config.providers[providerId])]),
  ) as Record<LlmProviderId, PublicManagerLlmProviderConfig>;
  return {
    activeProvider: config.activeProvider,
    autoApply: config.autoApply,
    providers,
  };
}

export async function initManagerLlmState(nextDataDir = "./data"): Promise<void> {
  dataDir = nextDataDir;
  await mkdir(dataDir, { recursive: true });
  try {
    const raw = await readFile(llmFile(), "utf8");
    managerLlmState = normalizeState(JSON.parse(raw) as Partial<ManagerLlmState>);
  } catch {
    managerLlmState = buildDefaultManagerLlmState();
    await persistState();
  }
}

export function getManagerLlmState(): ManagerLlmState {
  return clone(managerLlmState);
}

export function getPublicManagerLlmState(): PublicManagerLlmState {
  return {
    ...clone(managerLlmState),
    config: toPublicConfig(managerLlmState.config),
  };
}

export async function saveManagerLlmConfig(patch: ManagerLlmConfigPatch): Promise<PublicManagerLlmState> {
  await updateState((current) => {
    const next = clone(current);
    if (patch.activeProvider !== undefined) next.config.activeProvider = normalizeProviderId(patch.activeProvider);
    if (patch.autoApply !== undefined) next.config.autoApply = !!patch.autoApply;
    const providerPatches = patch.providers ?? {};
    MANAGER_LLM_PROVIDER_IDS.forEach((providerId) => {
      const providerPatch = providerPatches[providerId];
      if (!providerPatch) return;
      const currentProvider = next.config.providers[providerId];
      const apiKey = providerPatch.clearApiKey
        ? null
        : (providerPatch.apiKey == null
          ? currentProvider.apiKey
          : (String(providerPatch.apiKey).trim() || currentProvider.apiKey));
      next.config.providers[providerId] = normalizeProviderConfig({
        ...currentProvider,
        ...providerPatch,
        apiKey,
      }, DEFAULT_MANAGER_LLM_CONFIG.providers[providerId]);
    });
    next.lastUpdatedAt = new Date().toISOString();
    return next;
  });
  return getPublicManagerLlmState();
}

export async function appendManagerLlmMessage(
  role: ManagerLlmChatMessage["role"],
  content: string,
): Promise<PublicManagerLlmState> {
  const trimmed = String(content ?? "").trim();
  if (!trimmed) return getPublicManagerLlmState();
  await updateState((current) => ({
    ...current,
    history: [
      ...current.history,
      {
        id: `${role}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        role,
        content: trimmed,
        createdAt: new Date().toISOString(),
      },
    ].slice(-MAX_HISTORY),
    lastUpdatedAt: new Date().toISOString(),
  }));
  return getPublicManagerLlmState();
}

export async function addManagerLlmPendingActions(actions: ManagerLlmAction[]): Promise<PublicManagerLlmState> {
  await updateState((current) => ({
    ...current,
    pendingActions: [...current.pendingActions, ...actions].slice(-MAX_ACTIONS),
    lastUpdatedAt: new Date().toISOString(),
  }));
  return getPublicManagerLlmState();
}

export async function updateManagerLlmAction(
  actionId: string,
  patch: Partial<ManagerLlmAction>,
): Promise<ManagerLlmAction | null> {
  let updated: ManagerLlmAction | null = null;
  await updateState((current) => ({
    ...current,
    pendingActions: current.pendingActions.map((action) => {
      if (action.id !== actionId) return action;
      updated = normalizeAction({ ...action, ...patch }, 0);
      return updated ?? action;
    }),
    lastUpdatedAt: new Date().toISOString(),
  }));
  return updated ? clone(updated) : null;
}

export async function setManagerLlmBusy(busy: boolean): Promise<PublicManagerLlmState> {
  await updateState((current) => ({
    ...current,
    busy,
    lastUpdatedAt: new Date().toISOString(),
  }));
  return getPublicManagerLlmState();
}

export async function setManagerLlmError(error: string | null): Promise<PublicManagerLlmState> {
  await updateState((current) => ({
    ...current,
    lastError: String(error ?? "").trim() || null,
    lastUpdatedAt: new Date().toISOString(),
  }));
  return getPublicManagerLlmState();
}

export async function setManagerLlmResponseMeta(
  provider: LlmProviderId,
  summary: string | null,
): Promise<PublicManagerLlmState> {
  await updateState((current) => ({
    ...current,
    lastProvider: provider,
    lastSummary: String(summary ?? "").trim() || null,
    lastUpdatedAt: new Date().toISOString(),
  }));
  return getPublicManagerLlmState();
}

export async function resetManagerLlmSession(): Promise<PublicManagerLlmState> {
  await updateState((current) => ({
    ...current,
    history: [],
    pendingActions: [],
    busy: false,
    lastError: null,
    lastSummary: null,
    lastUpdatedAt: new Date().toISOString(),
  }));
  return getPublicManagerLlmState();
}
