import { invokeAnthropicProvider } from "./providers/anthropic.js";
import { invokeGoogleProvider } from "./providers/google.js";
import { invokeHuggingFaceProvider } from "./providers/huggingface.js";
import { invokeLocalProvider } from "./providers/local.js";
import { invokeOllamaProvider } from "./providers/ollama.js";
import { invokeOpenAiProvider } from "./providers/openai.js";
import { invokeOpenRouterProvider } from "./providers/openrouter.js";
import { invokeVeniceProvider } from "./providers/venice.js";
import type { LlmProviderId, ManagerProviderRequest, ManagerProviderResult } from "./types.js";

export async function invokeManagerProvider(
  provider: LlmProviderId,
  request: ManagerProviderRequest,
): Promise<ManagerProviderResult> {
  switch (provider) {
    case "venice":
      return invokeVeniceProvider(request);
    case "openai":
      return invokeOpenAiProvider(request);
    case "openrouter":
      return invokeOpenRouterProvider(request);
    case "google":
      return invokeGoogleProvider(request);
    case "anthropic":
      return invokeAnthropicProvider(request);
    case "ollama":
      return invokeOllamaProvider(request);
    case "huggingface":
      return invokeHuggingFaceProvider(request);
    case "local":
      return invokeLocalProvider(request);
    default:
      throw new Error(`Unsupported provider: ${provider satisfies never}`);
  }
}
