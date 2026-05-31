import type { LlmProviderId } from "./types.js";

export type ManagerLlmDetectedProvider = {
  providerId: Extract<LlmProviderId, "ollama" | "local">;
  endpointUrl: string;
  model: string;
  label: string;
  source: string;
};

export type ManagerLlmAutoDetectResult = {
  selected: ManagerLlmDetectedProvider | null;
  candidates: ManagerLlmDetectedProvider[];
};

type PreferMode = "any" | "ollama" | "local";

async function fetchJsonWithTimeout(url: string, timeoutMs = 1500): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        accept: "application/json",
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function asNonEmptyString(value: unknown): string {
  const trimmed = String(value ?? "").trim();
  return trimmed;
}

function extractOpenAiModelIds(payload: any): string[] {
  const rows = Array.isArray(payload?.data)
    ? payload.data
    : (Array.isArray(payload) ? payload : []);
  return rows
    .map((row: any) => asNonEmptyString(row?.id ?? row?.model ?? row?.name))
    .filter(Boolean);
}

async function detectOllama(): Promise<ManagerLlmDetectedProvider | null> {
  const payload = await fetchJsonWithTimeout("http://127.0.0.1:11434/api/tags");
  const rows = Array.isArray(payload?.models) ? payload.models : [];
  const model = rows
    .map((row: any) => asNonEmptyString(row?.name ?? row?.model))
    .find(Boolean);
  if (!model) return null;
  return {
    providerId: "ollama",
    endpointUrl: "http://127.0.0.1:11434/api/chat",
    model,
    label: `Ollama (${model})`,
    source: "ollama_tags",
  };
}

async function detectOpenAiCompatible(endpointBase: string, label: string, source: string): Promise<ManagerLlmDetectedProvider | null> {
  const payload = await fetchJsonWithTimeout(`${endpointBase}/v1/models`);
  const model = extractOpenAiModelIds(payload)[0] ?? "";
  if (!model) return null;
  return {
    providerId: "local",
    endpointUrl: `${endpointBase}/v1/chat/completions`,
    model,
    label: `${label} (${model})`,
    source,
  };
}

async function detectLocalCompat(): Promise<ManagerLlmDetectedProvider[]> {
  const probes = [
    { endpointBase: "http://127.0.0.1:1234", label: "Local API", source: "local_openai_1234" },
    { endpointBase: "http://127.0.0.1:8000", label: "Local API", source: "local_openai_8000" },
  ];
  const results: ManagerLlmDetectedProvider[] = [];
  for (const probe of probes) {
    try {
      const detected = await detectOpenAiCompatible(probe.endpointBase, probe.label, probe.source);
      if (detected) results.push(detected);
    } catch {
      // Probe failures are expected when a local runtime is not running.
    }
  }
  return results;
}

function selectCandidate(candidates: ManagerLlmDetectedProvider[], prefer: PreferMode): ManagerLlmDetectedProvider | null {
  if (!candidates.length) return null;
  if (prefer === "ollama") {
    return candidates.find((candidate) => candidate.providerId === "ollama") ?? null;
  }
  if (prefer === "local") {
    return candidates.find((candidate) => candidate.providerId === "local") ?? null;
  }
  return candidates[0];
}

export async function autoDetectLocalManagerProvider(prefer: PreferMode = "any"): Promise<ManagerLlmAutoDetectResult> {
  const candidates: ManagerLlmDetectedProvider[] = [];

  if (prefer !== "local") {
    try {
      const ollama = await detectOllama();
      if (ollama) candidates.push(ollama);
    } catch {
      // no-op
    }
  }

  const localCandidates = await detectLocalCompat();
  if (localCandidates.length) candidates.push(...localCandidates);

  return {
    selected: selectCandidate(candidates, prefer),
    candidates,
  };
}