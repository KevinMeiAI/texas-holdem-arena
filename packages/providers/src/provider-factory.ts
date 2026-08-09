import { AnthropicMessagesProvider } from "./anthropic-messages.js";
import { GoogleGeminiProvider } from "./google-gemini.js";
import { MockPolicyProvider } from "./mock-scripted.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";
import { OpenAIResponsesProvider } from "./openai-responses.js";
import type { FrozenModelConfig, ModelProvider } from "./provider.js";

export function createProvider(config: FrozenModelConfig): ModelProvider {
  switch (config.provider) {
    case "openai-responses": return new OpenAIResponsesProvider(config);
    case "anthropic-messages": return new AnthropicMessagesProvider(config);
    case "google-gemini": return new GoogleGeminiProvider(config);
    case "openai-compatible": return new OpenAICompatibleProvider(config);
    case "mock-scripted": return new MockPolicyProvider();
  }
}
