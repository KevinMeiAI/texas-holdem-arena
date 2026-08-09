import { buildModelUserPrompt, type CanonicalModelRequest } from "../../contracts/src/index.js";
import { finiteToken, postJson, requiredString } from "./http.js";
import { classifyProviderError, parseProviderOutput, ProviderCallError, type FrozenModelConfig, type ModelProvider, type ProviderDecision } from "./provider.js";

export class AnthropicMessagesProvider implements ModelProvider {
  readonly kind = "anthropic-messages" as const;

  constructor(private readonly config: FrozenModelConfig) {}

  classifyError = classifyProviderError;

  async decide(request: CanonicalModelRequest): Promise<ProviderDecision> {
    if (!this.config.apiKey) throw new ProviderCallError("CONFIG", "Anthropic API key is required", false);
    const started = Date.now();
    const response = await postJson(
      `${(this.config.baseUrl ?? "https://api.anthropic.com/v1").replace(/\/$/, "")}/messages`,
      { "x-api-key": this.config.apiKey, "anthropic-version": "2023-06-01" },
      {
        ...this.config.parameters,
        model: this.config.model,
        max_tokens: Number(this.config.parameters.max_tokens ?? 800),
        system: request.systemPrompt,
        messages: [{ role: "user", content: buildModelUserPrompt(request.userPayload) }],
      },
      request.timeoutMs,
    );
    const body = response.body as {
      id?: unknown;
      content?: { type?: unknown; text?: unknown }[];
      usage?: { input_tokens?: unknown; output_tokens?: unknown };
    };
    const rawText = requiredString(body.content?.find((item) => item.type === "text")?.text, "content text");
    const inputTokens = finiteToken(body.usage?.input_tokens);
    const outputTokens = finiteToken(body.usage?.output_tokens);
    return {
      parsed: parseProviderOutput(rawText, request.expectedOutput),
      rawText,
      latencyMs: Date.now() - started,
      providerRequestId: typeof body.id === "string" ? body.id : null,
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null,
      },
    };
  }
}
