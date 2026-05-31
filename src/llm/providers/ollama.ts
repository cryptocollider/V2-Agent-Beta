import type { ManagerProviderRequest, ManagerProviderResult } from "../types.js";

function extractOllamaText(payload: any): string {
  if (typeof payload?.message?.content === "string" && payload.message.content.trim()) {
    return payload.message.content.trim();
  }
  if (typeof payload?.response === "string" && payload.response.trim()) {
    return payload.response.trim();
  }
  return "";
}

export async function invokeOllamaProvider(request: ManagerProviderRequest): Promise<ManagerProviderResult> {
  const response = await fetch(request.config.endpointUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: request.config.model,
      messages: [
        { role: "system", content: request.systemPrompt },
        ...request.messages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
      ],
      format: "json",
      stream: false,
    }),
  });

  const json = await response.json().catch(() => null);
  if (!response.ok) {
    const errorMessage = String(json?.error || json?.message || `Ollama HTTP ${response.status}`);
    throw new Error(errorMessage);
  }

  const text = extractOllamaText(json);
  if (!text) throw new Error("Ollama returned an empty manager response.");

  return {
    provider: "ollama",
    model: String(json?.model || request.config.model),
    text,
    usage: json && typeof json === "object"
      ? {
        promptEvalCount: json.prompt_eval_count ?? null,
        evalCount: json.eval_count ?? null,
        totalDuration: json.total_duration ?? null,
        loadDuration: json.load_duration ?? null,
      }
      : null,
  };
}