import type { CanonicalModelRequest } from "../../contracts/src/index.js";
import { classifyProviderError, parseProviderRequestOutput, ProviderCallError, type ModelProvider, type ProviderDecision } from "./provider.js";

export class MockScriptedProvider implements ModelProvider {
  readonly kind = "mock-scripted" as const;
  readonly #responses: string[];

  constructor(responses: readonly (string | object)[]) {
    this.#responses = responses.map((response) => (
      typeof response === "string" ? response : JSON.stringify(response)
    ));
  }

  classifyError = classifyProviderError;

  async decide(request: CanonicalModelRequest): Promise<ProviderDecision> {
    const rawText = this.#responses.shift();
    if (!rawText) throw new ProviderCallError("INVALID_RESPONSE", "Mock script is exhausted", false);
    return {
      parsed: parseProviderRequestOutput(rawText, request),
      rawText,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      latencyMs: 0,
      providerRequestId: `mock:${request.requestId}`,
    };
  }
}

function findArenaState(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return {};
  const object = payload as Record<string, unknown>;
  const arenaState = object.arena_state;
  return arenaState && typeof arenaState === "object" && !Array.isArray(arenaState)
    ? arenaState as Record<string, unknown>
    : object;
}

function findArenaControl(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return {};
  const control = (payload as Record<string, unknown>).arena_control;
  return control && typeof control === "object" && !Array.isArray(control)
    ? control as Record<string, unknown>
    : {};
}

/** Deterministic no-cost player for local acceptance and recovery tests. */
export class MockPolicyProvider implements ModelProvider {
  readonly kind = "mock-scripted" as const;

  classifyError = classifyProviderError;

  async decide(request: CanonicalModelRequest): Promise<ProviderDecision> {
    const state = findArenaState(request.userPayload);
    const control = findArenaControl(request.userPayload);
    const legal = state.legal_actions as Record<string, unknown> | null | undefined;
    let response: object;
    const allowed = Array.isArray(legal?.allowed) ? legal.allowed : [];
    if (control.preflight_task === "history_query") {
      response = { type: "history_query", action: null, amount_to: null, decision_summary: null, query: { kind: "recent_hands", count: 1, limit: 10 } };
    } else if (allowed.length === 1 && allowed[0] === "raise") {
      const raise = legal?.raise as { min_amount_to?: unknown } | undefined;
      response = { type: "action", action: "raise", amount_to: raise?.min_amount_to, decision_summary: "Use the exact legal bound.", query: null };
    } else if (allowed.includes("check") || legal?.check) response = { type: "action", action: "check", decision_summary: "No bet to call." };
    else if (allowed.includes("call") || legal?.call) response = { type: "action", action: "call", decision_summary: "Continue at the offered price." };
    else if (allowed.includes("all_in") || legal?.allIn) response = { type: "action", action: "all_in", decision_summary: "Only stack-sized action remains." };
    else response = { type: "action", action: "fold", decision_summary: "No continuing action is available." };
    if (request.parserPolicy === "arena-parser-strict-v1") {
      response = { ...response, amount_to: null, query: null };
    }
    const rawText = JSON.stringify(response);
    return {
      parsed: parseProviderRequestOutput(rawText, request),
      rawText,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      latencyMs: 0,
      providerRequestId: `mock-policy:${request.requestId}`,
    };
  }
}
