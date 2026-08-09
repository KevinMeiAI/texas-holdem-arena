import { describe, expect, it } from "vitest";
import type { CanonicalModelRequest } from "../../../../packages/contracts/src/model-protocol.js";
import { MockScriptedProvider } from "../../../../packages/providers/src/mock-scripted.js";
import {
  ProviderCallError,
  type ModelProvider,
  type ProviderDecision,
} from "../../../../packages/providers/src/provider.js";
import { runModelDecision } from "./decision-runner.js";

const request: CanonicalModelRequest = {
  requestId: "request-1",
  expectedOutput: "ACTION_OR_HISTORY",
  systemPrompt: "same",
  systemPromptHash: "a".repeat(64),
  userPayload: { legal_actions: { check: true } },
  timeoutMs: 100,
};

const config = {
  maxInfrastructureAttempts: 3,
  history: { maxQueries: 2, maxEventsPerQuery: 80, maxApproxTokens: 4_000 },
};

describe("uniform model decision policy", () => {
  it("corrects one protocol error and accepts the corrected action", async () => {
    const provider = new MockScriptedProvider([
      "not json",
      { type: "action", action: "check" },
    ]);
    const result = await runModelDecision({
      provider,
      request,
      validateAction: () => ({ action: "check" }),
      fallbackAction: () => ({ action: "fold" }),
    }, config);
    expect(result).toMatchObject({
      status: "ACTION",
      action: { action: "check" },
      usedFallback: false,
      protocolFailures: 1,
    });
  });

  it("uses check-else-fold fallback only after the second protocol failure", async () => {
    const result = await runModelDecision({
      provider: new MockScriptedProvider(["bad", "still bad"]),
      request,
      validateAction: () => ({ action: "check" }),
      fallbackAction: () => ({ action: "fold" }),
    }, config);
    expect(result).toMatchObject({
      status: "ACTION",
      action: { action: "fold" },
      usedFallback: true,
      protocolFailures: 2,
    });
  });

  it("serves at most the frozen history budget before an action", async () => {
    const result = await runModelDecision({
      provider: new MockScriptedProvider([
        { type: "history_query", query: { kind: "recent_hands", count: 1, limit: 10 } },
        { type: "history_query", query: { kind: "public_stats", limit: 10 } },
        { type: "action", action: "check" },
      ]),
      request,
      validateAction: () => ({ action: "check" }),
      fallbackAction: () => ({ action: "fold" }),
      executeHistoryQuery: async (query) => [{ query: query.kind }],
    }, config);
    expect(result).toMatchObject({ status: "ACTION", usedFallback: false });
    if (result.status === "ACTION") expect(result.historyResults).toHaveLength(2);
  });

  it("retries infrastructure failures without consuming protocol correction", async () => {
    let attempts = 0;
    const provider: ModelProvider = {
      kind: "mock-scripted",
      classifyError: (error) => error as ProviderCallError,
      decide: async (): Promise<ProviderDecision> => {
        attempts += 1;
        if (attempts < 3) throw new ProviderCallError("RATE_LIMIT", "limited", true, 429);
        return {
          parsed: { type: "action", action: "check" },
          rawText: '{"type":"action","action":"check"}',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          latencyMs: 1,
          providerRequestId: null,
        };
      },
    };
    const result = await runModelDecision({
      provider,
      request,
      validateAction: () => ({ action: "check" }),
      fallbackAction: () => ({ action: "fold" }),
    }, config);
    expect(result).toMatchObject({ status: "ACTION", protocolFailures: 0 });
    expect(attempts).toBe(3);
  });

  it("pauses instead of taking chips after exhausted infrastructure retries", async () => {
    const provider: ModelProvider = {
      kind: "mock-scripted",
      classifyError: (error) => error as ProviderCallError,
      decide: async () => {
        throw new ProviderCallError("SERVER", "down", true, 503);
      },
    };
    const result = await runModelDecision({
      provider,
      request,
      validateAction: () => ({ action: "check" }),
      fallbackAction: () => ({ action: "fold" }),
    }, config);
    expect(result).toMatchObject({ status: "PAUSED_INFRA", errorKind: "SERVER" });
    expect(result.calls).toHaveLength(3);
  });

  it("defaults an invalid runout negotiation to one board after one correction", async () => {
    const result = await runModelDecision({
      provider: new MockScriptedProvider(["bad", "bad again"]),
      request: { ...request, expectedOutput: "RUNOUT_VOTE" },
    }, config);
    expect(result).toMatchObject({
      status: "RUNOUT_VOTE",
      response: { accept_run_it_twice: false },
      usedFallback: true,
      protocolFailures: 2,
    });
  });
});
