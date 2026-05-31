import type { ManagerProviderRequest, ManagerProviderResult } from "../types.js";

function extractVeniceText(payload: any): string {
  const choices = Array.isArray(payload?.choices) ? payload.choices : [];
  for (const choice of choices) {
    const message = choice?.message;
    if (typeof message?.content === "string" && message.content.trim()) {
      return message.content.trim();
    }
  }
  return "";
}

export async function invokeVeniceProvider(request: ManagerProviderRequest): Promise<ManagerProviderResult> {
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
      response_format: {
        type: "json_object",
      },
      stream: false,
    }),
  });

  const json = await response.json().catch(() => null);
  if (!response.ok) {
    const errorMessage = String(json?.error?.message || json?.error || `Venice HTTP ${response.status}`);
    throw new Error(errorMessage);
  }

  const text = extractVeniceText(json);
  if (!text) throw new Error("Venice returned an empty manager response.");

  return {
    provider: "venice",
    model: String(json?.model || request.config.model),
    text,
    usage: json?.usage && typeof json.usage === "object" ? json.usage : null,
  };
}
