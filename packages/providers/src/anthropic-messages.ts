import { buildModelUserPrompt, type CanonicalModelRequest } from "../../contracts/src/index.js";
import { finiteToken, postJson, requiredString } from "./http.js";
import { resolveOutputPolicy } from "./output-policy.js";
import { classifyProviderError, parseProviderRequestOutput, ProviderCallError, type FrozenModelConfig, type ModelProvider, type ProviderDecision } from "./provider.js";
import { transportAudit } from "./transport-audit.js";

export class AnthropicMessagesProvider implements ModelProvider {
  readonly kind = "anthropic-messages" as const;

  constructor(private readonly config: FrozenModelConfig) {}

  classifyError = classifyProviderError;

  async decide(request: CanonicalModelRequest): Promise<ProviderDecision> {
    if (!this.config.apiKey) throw new ProviderCallError("CONFIG", "Anthropic API key is required", false);
    const outputPolicy = resolveOutputPolicy(this.config, request.expectedOutput, request.outputSchema);
    const outputConfig = outputPolicy.effectiveMode === "json_schema"
      ? { format: { type: "json_schema", schema: outputPolicy.schema!.schema } }
      : undefined;
    const started = Date.now();
    const renderedUserText = buildModelUserPrompt(request.userPayload, request.adapterProtocolVersion);
    const wireBody = {
      ...this.config.parameters,
      model: this.config.model,
      max_tokens: Number(this.config.parameters.max_tokens ?? 800),
      system: request.systemPrompt,
      messages: [{ role: "user", content: renderedUserText }],
      ...(outputConfig ? { output_config: outputConfig } : {}),
    };
    const response = await postJson(
      `${(this.config.baseUrl ?? "https://api.anthropic.com/v1").replace(/\/$/, "")}/messages`,
      { "x-api-key": this.config.apiKey, "anthropic-version": "2023-06-01" },
      wireBody,
      request.timeoutMs,
    );
    const body = response.body as {
      id?: unknown;
      model?: unknown;
      stop_reason?: unknown;
      content?: { type?: unknown; text?: unknown }[];
      usage?: { input_tokens?: unknown; output_tokens?: unknown };
    };
    const rawText = requiredString(body.content?.find((item) => item.type === "text")?.text, "content text");
    const inputTokens = finiteToken(body.usage?.input_tokens);
    const outputTokens = finiteToken(body.usage?.output_tokens);
    return {
      parsed: parseProviderRequestOutput(rawText, request),
      rawText,
      latencyMs: Date.now() - started,
      providerRequestId: typeof body.id === "string" ? body.id : null,
      transportAudit: transportAudit({
        adapterVersion: request.adapterProtocolVersion ?? "arena-adapters-v1",
        renderedUserText,
        wireBody,
        appliedOutputMode: outputPolicy.effectiveMode,
        schema: outputPolicy.schema,
        finishReason: body.stop_reason,
        responseModel: body.model,
      }),
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null,
      },
    };
  }
}
