import { buildModelUserPrompt, type CanonicalModelRequest } from "../../contracts/src/index.js";
import { finiteToken, postJson, requiredString } from "./http.js";
import { resolveOutputPolicy } from "./output-policy.js";
import {
  classifyProviderError,
  parseProviderOutput,
  ProviderCallError,
  type FrozenModelConfig,
  type ModelProvider,
  type ProviderDecision,
} from "./provider.js";

function outputText(body: unknown): string {
  const object = body as { output_text?: unknown; output?: { content?: { text?: unknown }[] }[] };
  if (typeof object.output_text === "string") return object.output_text;
  for (const item of object.output ?? []) {
    for (const content of item.content ?? []) {
      if (typeof content.text === "string") return content.text;
    }
  }
  return requiredString(undefined, "output text");
}

export class OpenAIResponsesProvider implements ModelProvider {
  readonly kind = "openai-responses" as const;

  constructor(private readonly config: FrozenModelConfig) {}

  classifyError = classifyProviderError;

  async decide(request: CanonicalModelRequest): Promise<ProviderDecision> {
    if (!this.config.apiKey) throw new ProviderCallError("CONFIG", "OpenAI API key is required", false);
    const outputPolicy = resolveOutputPolicy(this.config, request.expectedOutput, request.outputSchema);
    const text = outputPolicy.effectiveMode === "json_schema"
      ? {
          format: {
            type: "json_schema",
            name: outputPolicy.schema!.name,
            schema: outputPolicy.schema!.schema,
            strict: true,
          },
        }
      : outputPolicy.effectiveMode === "json_object"
        ? { format: { type: "json_object" } }
        : undefined;
    const started = Date.now();
    const response = await postJson(
      `${(this.config.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "")}/responses`,
      { authorization: `Bearer ${this.config.apiKey}` },
      {
        ...this.config.parameters,
        model: this.config.model,
        input: [
          { role: "system", content: [{ type: "input_text", text: request.systemPrompt }] },
          { role: "user", content: [{ type: "input_text", text: buildModelUserPrompt(request.userPayload) }] },
        ],
        ...(text ? { text } : {}),
      },
      request.timeoutMs,
    );
    const body = response.body as {
      id?: unknown;
      usage?: { input_tokens?: unknown; output_tokens?: unknown; total_tokens?: unknown };
    };
    const rawText = outputText(response.body);
    return {
      parsed: parseProviderOutput(rawText, request.expectedOutput),
      rawText,
      latencyMs: Date.now() - started,
      providerRequestId: typeof body.id === "string" ? body.id : null,
      usage: {
        inputTokens: finiteToken(body.usage?.input_tokens),
        outputTokens: finiteToken(body.usage?.output_tokens),
        totalTokens: finiteToken(body.usage?.total_tokens),
      },
    };
  }
}
