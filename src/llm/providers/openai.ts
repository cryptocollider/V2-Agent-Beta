import type { ManagerProviderRequest, ManagerProviderResult } from "../types.js";

function extractOpenAiText(payload: any): string {
  if (typeof payload?.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text.trim();
  }

  const texts: string[] = [];
  const output = Array.isArray(payload?.output) ? payload.output : [];
  for (const item of output) {
    if (!item || typeof item !== "object" || item.type !== "message") continue;
    const content = Array.isArray(item.content) ? item.content : [];
    for (const part of content) {
      if (typeof part?.text === "string" && (part.type === "output_text" || part.type === "text")) {
        texts.push(part.text);
      } else if (typeof part?.refusal === "string" && part.type === "refusal") {
        texts.push(part.refusal);
      }
    }
  }
  return texts.join("\n").trim();
}

export async function invokeOpenAiProvider(request: ManagerProviderRequest): Promise<ManagerProviderResult> {
  const response = await fetch(request.config.endpointUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${request.config.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: request.config.model,
      input: [
        { role: "system", content: request.systemPrompt },
        ...request.messages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
      ],
    }),
  });

  const json = await response.json().catch(() => null);
  if (!response.ok) {
    const errorMessage = String(json?.error?.message || json?.error || `OpenAI HTTP ${response.status}`);
    throw new Error(errorMessage);
  }

  const text = extractOpenAiText(json);
  if (!text) throw new Error("OpenAI returned an empty manager response.");

  return {
    provider: "openai",
    model: String(json?.model || request.config.model),
    text,
    usage: json?.usage && typeof json.usage === "object" ? json.usage : null,
  };
}
