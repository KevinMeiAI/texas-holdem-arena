import { buildModelUserPrompt, type CanonicalModelRequest } from "../../contracts/src/index.js";
import { finiteToken, postJson, requiredString } from "./http.js";
import { resolveOutputPolicy } from "./output-policy.js";
import { classifyProviderError, parseProviderRequestOutput, ProviderCallError, type FrozenModelConfig, type ModelProvider, type ProviderDecision } from "./provider.js";
import { transportAudit } from "./transport-audit.js";

export class GoogleGeminiProvider implements ModelProvider {
  readonly kind = "google-gemini" as const;

  constructor(private readonly config: FrozenModelConfig) {}

  classifyError = classifyProviderError;

  async decide(request: CanonicalModelRequest): Promise<ProviderDecision> {
    if (!this.config.apiKey) throw new ProviderCallError("CONFIG", "Gemini API key is required", false);
    const outputPolicy = resolveOutputPolicy(this.config, request.expectedOutput, request.outputSchema);
    const structuredConfig = outputPolicy.effectiveMode === "json_schema"
      ? {
          responseMimeType: "application/json",
          responseSchema: outputPolicy.schema!.schema,
        }
      : outputPolicy.effectiveMode === "json_object"
        ? { responseMimeType: "application/json" }
        : {};
    const started = Date.now();
    const base = (this.config.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta").replace(/\/$/, "");
    const renderedUserText = buildModelUserPrompt(request.userPayload, request.adapterProtocolVersion);
    const wireBody = {
      systemInstruction: { parts: [{ text: request.systemPrompt }] },
      contents: [{ role: "user", parts: [{ text: renderedUserText }] }],
      generationConfig: { ...this.config.parameters, ...structuredConfig },
    };
    const response = await postJson(
      `${base}/models/${encodeURIComponent(this.config.model)}:generateContent?key=${encodeURIComponent(this.config.apiKey)}`,
      {},
      wireBody,
      request.timeoutMs,
    );
    const body = response.body as {
      responseId?: unknown;
      modelVersion?: unknown;
      candidates?: { finishReason?: unknown; finishMessage?: unknown; content?: { parts?: { text?: unknown }[] } }[];
      usageMetadata?: {
        promptTokenCount?: unknown;
        candidatesTokenCount?: unknown;
        totalTokenCount?: unknown;
      };
    };
    const rawText = requiredString(body.candidates?.[0]?.content?.parts?.[0]?.text, "candidate text");
    return {
      parsed: parseProviderRequestOutput(rawText, request),
      rawText,
      latencyMs: Date.now() - started,
      providerRequestId: typeof body.responseId === "string" ? body.responseId : null,
      transportAudit: transportAudit({
        adapterVersion: request.adapterProtocolVersion ?? "arena-adapters-v1",
        renderedUserText,
        wireBody,
        appliedOutputMode: outputPolicy.effectiveMode,
        schema: outputPolicy.schema,
        finishReason: body.candidates?.[0]?.finishReason,
        refusal: body.candidates?.[0]?.finishMessage,
        responseModel: body.modelVersion,
      }),
      usage: {
        inputTokens: finiteToken(body.usageMetadata?.promptTokenCount),
        outputTokens: finiteToken(body.usageMetadata?.candidatesTokenCount),
        totalTokens: finiteToken(body.usageMetadata?.totalTokenCount),
      },
    };
  }
}
