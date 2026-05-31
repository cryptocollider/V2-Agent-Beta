import type { ManagerProviderRequest, ManagerProviderResult } from "../types.js";

function extractChatText(payload: any): string {
  const choices = Array.isArray(payload?.choices) ? payload.choices : [];
  for (const choice of choices) {
    const content = choice?.message?.content;
    if (typeof content === "string" && content.trim()) {
      return content.trim();
    }
    if (Array.isArray(content)) {
      const text = content
        .map((part) => (typeof part?.text === "string" ? part.text : ""))
        .filter(Boolean)
        .join("\n")
        .trim();
      if (text) return text;
    }
  }
  return "";
}

export async function invokeHuggingFaceProvider(request: ManagerProviderRequest): Promise<ManagerProviderResult> {
  const response = await fetch(request.config.endpointUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${request.config.apiKey}`,
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
      stream: false,
    }),
  });

  const json = await response.json().catch(() => null);
  if (!response.ok) {
    const errorMessage = String(json?.error?.message || json?.error || `Hugging Face HTTP ${response.status}`);
    throw new Error(errorMessage);
  }

  const text = extractChatText(json);
  if (!text) throw new Error("Hugging Face returned an empty manager response.");

  return {
    provider: "huggingface",
    model: String(json?.model || request.config.model),
    text,
    usage: json?.usage && typeof json.usage === "object" ? json.usage : null,
  };
}