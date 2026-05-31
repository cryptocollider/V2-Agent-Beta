import type { ManagerProviderRequest, ManagerProviderResult } from "../types.js";

function extractAnthropicText(payload: any): string {
  const content = Array.isArray(payload?.content) ? payload.content : [];
  return content
    .map((entry: any) => (entry?.type === "text" && typeof entry?.text === "string") ? entry.text : "")
    .filter(Boolean)
    .join("\n")
    .trim();
}

export async function invokeAnthropicProvider(request: ManagerProviderRequest): Promise<ManagerProviderResult> {
  const response = await fetch(request.config.endpointUrl, {
    method: "POST",
    headers: {
      "x-api-key": String(request.config.apiKey || ""),
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: request.config.model,
      max_tokens: 1400,
      system: request.systemPrompt,
      messages: request.messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
    }),
  });

  const json = await response.json().catch(() => null);
  if (!response.ok) {
    const errorMessage = String(json?.error?.message || json?.error?.type || `Anthropic HTTP ${response.status}`);
    throw new Error(errorMessage);
  }

  const text = extractAnthropicText(json);
  if (!text) throw new Error("Anthropic returned an empty manager response.");

  return {
    provider: "anthropic",
    model: String(json?.model || request.config.model),
    text,
    usage: json?.usage && typeof json.usage === "object" ? json.usage : null,
  };
}
