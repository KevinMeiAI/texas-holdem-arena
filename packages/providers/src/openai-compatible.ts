import { buildModelUserPrompt, type CanonicalModelRequest } from "../../contracts/src/index.js";
import { finiteToken, postJson, requiredString } from "./http.js";
import { resolveOutputPolicy } from "./output-policy.js";
import { classifyProviderError, parseProviderRequestOutput, ProviderCallError, type FrozenModelConfig, type ModelProvider, type ProviderDecision } from "./provider.js";
import { transportAudit } from "./transport-audit.js";

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
    const renderedUserText = buildModelUserPrompt(request.userPayload, request.adapterProtocolVersion);
    const wireBody = {
      ...this.config.parameters,
      model: this.config.model,
      messages: [
        { role: "system", content: request.systemPrompt },
        { role: "user", content: renderedUserText },
      ],
      ...(responseFormat ? { response_format: responseFormat } : {}),
    };
    const response = await postJson(
      `${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`,
      this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {},
      wireBody,
      request.timeoutMs,
    );
    const body = response.body as {
      id?: unknown;
      model?: unknown;
      system_fingerprint?: unknown;
      choices?: { finish_reason?: unknown; message?: { content?: unknown; refusal?: unknown } }[];
      usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown };
    };
    const rawText = requiredString(body.choices?.[0]?.message?.content, "choice content");
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
        finishReason: body.choices?.[0]?.finish_reason,
        refusal: body.choices?.[0]?.message?.refusal,
        responseModel: body.model,
        systemFingerprint: body.system_fingerprint,
      }),
      usage: {
        inputTokens: finiteToken(body.usage?.prompt_tokens),
        outputTokens: finiteToken(body.usage?.completion_tokens),
        totalTokens: finiteToken(body.usage?.total_tokens),
      },
    };
  }
}
