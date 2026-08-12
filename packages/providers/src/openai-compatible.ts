import { buildModelUserPrompt, type CanonicalModelRequest } from "../../contracts/src/index.js";
import { finiteToken, postJson, requiredString } from "./http.js";
import { resolveOutputPolicy } from "./output-policy.js";
import { classifyProviderError, parseProviderRequestOutput, ProviderCallError, type FrozenModelConfig, type ModelProvider, type ProviderDecision } from "./provider.js";

export class OpenAICompatibleProvider implements ModelProvider {
  readonly kind = "openai-compatible" as const;

  constructor(private readonly config: FrozenModelConfig) {}

  classifyError = classifyProviderError;

  async decide(request: CanonicalModelRequest): Promise<ProviderDecision> {
    if (!this.config.baseUrl) throw new ProviderCallError("CONFIG", "OpenAI-compatible base URL is required", false);
    const outputPolicy = resolveOutputPolicy(this.config, request.expectedOutput, request.outputSchema);
    const responseFormat = outputPolicy.effectiveMode === "json_schema"
      ? {
          type: "json_schema",
          json_schema: {
            name: outputPolicy.schema!.name,
            schema: outputPolicy.schema!.schema,
            strict: true,
          },
        }
      : outputPolicy.effectiveMode === "json_object"
        ? { type: "json_object" }
        : undefined;
    const started = Date.now();
    const response = await postJson(
      `${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`,
      this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {},
      {
        ...this.config.parameters,
        model: this.config.model,
        messages: [
          { role: "system", content: request.systemPrompt },
          { role: "user", content: buildModelUserPrompt(request.userPayload, request.adapterProtocolVersion) },
        ],
        ...(responseFormat ? { response_format: responseFormat } : {}),
      },
      request.timeoutMs,
    );
    const body = response.body as {
      id?: unknown;
      choices?: { message?: { content?: unknown } }[];
      usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown };
    };
    const rawText = requiredString(body.choices?.[0]?.message?.content, "choice content");
    return {
      parsed: parseProviderRequestOutput(rawText, request),
      rawText,
      latencyMs: Date.now() - started,
      providerRequestId: typeof body.id === "string" ? body.id : null,
      usage: {
        inputTokens: finiteToken(body.usage?.prompt_tokens),
        outputTokens: finiteToken(body.usage?.completion_tokens),
        totalTokens: finiteToken(body.usage?.total_tokens),
      },
    };
  }
}
