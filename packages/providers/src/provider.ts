import type {
  ActionDecisionResponse,
  CanonicalModelRequest,
} from "../../contracts/src/model-protocol.js";
import { parseModelJson, type ExpectedModelOutput } from "../../contracts/src/model-protocol.js";

export type ProviderKind = "openai-responses" | "anthropic-messages" | "google-gemini" | "openai-compatible" | "mock-scripted";
export type ProviderProfile = "auto" | "openai" | "anthropic" | "gemini" | "deepseek" | "kimi" | "zhipu" | "xai" | "generic";
export type OutputMode = "auto" | "json_schema" | "json_object" | "prompt";
export type ModelOutputMode = "inherit" | OutputMode;

export interface FrozenModelConfig {
  provider: ProviderKind;
  providerProfile: ProviderProfile;
  providerDefaultOutputMode: OutputMode;
  outputMode: ModelOutputMode;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  timeoutMs: number;
  parameters: Record<string, unknown>;
}

export interface ProviderUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}

export interface ProviderDecision {
  parsed: ActionDecisionResponse;
  rawText: string;
  usage: ProviderUsage;
  latencyMs: number;
  providerRequestId: string | null;
}

export type ProviderErrorKind =
  | "RATE_LIMIT"
  | "SERVER"
  | "NETWORK"
  | "TIMEOUT"
  | "AUTH"
  | "CONFIG"
  | "INVALID_RESPONSE";

export class ProviderCallError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
    readonly retryable: boolean,
    readonly status: number | null = null,
    readonly rawResponseText?: string,
  ) {
    super(message);
    this.name = "ProviderCallError";
  }
}

export interface ModelProvider {
  readonly kind: ProviderKind;
  decide(request: CanonicalModelRequest): Promise<ProviderDecision>;
  classifyError(error: unknown): ProviderCallError;
}

export function classifyProviderError(error: unknown): ProviderCallError {
  if (error instanceof ProviderCallError) return error;
  return new ProviderCallError(
    "NETWORK",
    error instanceof Error ? error.message : "Unknown provider network error",
    true,
  );
}

export function parseProviderOutput(text: string, expected: ExpectedModelOutput) {
  try {
    return parseModelJson(text, expected);
  } catch {
    throw new ProviderCallError("INVALID_RESPONSE", "Model returned invalid Arena JSON", false, null, text);
  }
}

export interface PreflightResult {
  ok: boolean;
  latencyMs: number;
  usage: ProviderUsage | null;
  errorKind: ProviderErrorKind | null;
  message: string;
}

export async function preflightProvider(
  provider: ModelProvider,
  request: CanonicalModelRequest,
  validate?: (decision: ProviderDecision) => string | null,
): Promise<PreflightResult> {
  try {
    const result = await provider.decide(request);
    const validationMessage = validate?.(result) ?? null;
    if (validationMessage) {
      throw new ProviderCallError("INVALID_RESPONSE", validationMessage, false);
    }
    return {
      ok: true,
      latencyMs: result.latencyMs,
      usage: result.usage,
      errorKind: null,
      message: "Provider returned valid Arena JSON",
    };
  } catch (error) {
    const classified = provider.classifyError(error);
    return {
      ok: false,
      latencyMs: 0,
      usage: null,
      errorKind: classified.kind,
      message: classified.message,
    };
  }
}
