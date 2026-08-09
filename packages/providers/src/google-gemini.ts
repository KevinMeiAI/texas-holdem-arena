import { buildModelUserPrompt, type CanonicalModelRequest } from "../../contracts/src/index.js";
import { finiteToken, postJson, requiredString } from "./http.js";
import { classifyProviderError, parseProviderOutput, ProviderCallError, type FrozenModelConfig, type ModelProvider, type ProviderDecision } from "./provider.js";

export class GoogleGeminiProvider implements ModelProvider {
  readonly kind = "google-gemini" as const;

  constructor(private readonly config: FrozenModelConfig) {}

  classifyError = classifyProviderError;

  async decide(request: CanonicalModelRequest): Promise<ProviderDecision> {
    if (!this.config.apiKey) throw new ProviderCallError("CONFIG", "Gemini API key is required", false);
    const started = Date.now();
    const base = (this.config.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta").replace(/\/$/, "");
    const response = await postJson(
      `${base}/models/${encodeURIComponent(this.config.model)}:generateContent?key=${encodeURIComponent(this.config.apiKey)}`,
      {},
      {
        systemInstruction: { parts: [{ text: request.systemPrompt }] },
        contents: [{ role: "user", parts: [{ text: buildModelUserPrompt(request.userPayload) }] }],
        generationConfig: { ...this.config.parameters, responseMimeType: "application/json" },
      },
      request.timeoutMs,
    );
    const body = response.body as {
      responseId?: unknown;
      candidates?: { content?: { parts?: { text?: unknown }[] } }[];
      usageMetadata?: {
        promptTokenCount?: unknown;
        candidatesTokenCount?: unknown;
        totalTokenCount?: unknown;
      };
    };
    const rawText = requiredString(body.candidates?.[0]?.content?.parts?.[0]?.text, "candidate text");
    return {
      parsed: parseProviderOutput(rawText, request.expectedOutput),
      rawText,
      latencyMs: Date.now() - started,
      providerRequestId: typeof body.responseId === "string" ? body.responseId : null,
      usage: {
        inputTokens: finiteToken(body.usageMetadata?.promptTokenCount),
        outputTokens: finiteToken(body.usageMetadata?.candidatesTokenCount),
        totalTokens: finiteToken(body.usageMetadata?.totalTokenCount),
      },
    };
  }
}
