import { describe, expect, it, vi } from "vitest";
import type { CanonicalModelRequest } from "../../../../packages/contracts/src/model-protocol.js";
import { MockScriptedProvider } from "../../../../packages/providers/src/mock-scripted.js";
import {
  ProviderCallError,
  type ModelProvider,
  type ProviderDecision,
} from "../../../../packages/providers/src/provider.js";
import { runModelDecision } from "./decision-runner.js";
import type { DecisionResumeState } from "./decision-runner.js";

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
  infrastructureRetryDelaysMs: [0, 0],
  history: { maxQueries: 2, maxRecordsPerQuery: 80, maxApproxTokens: 4_000 },
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

  it("places strict correction codes in trusted arena_control", async () => {
    const payloads: unknown[] = [];
    const strictRequest = {
      ...request,
      parserPolicy: "arena-parser-strict-v1" as const,
      adapterProtocolVersion: "arena-adapters-v2",
    };
    let call = 0;
    const provider: ModelProvider = {
      kind: "mock-scripted",
      classifyError: (error) => error as ProviderCallError,
      decide: async (nextRequest) => {
        payloads.push(nextRequest.userPayload);
        call += 1;
        if (call === 1) throw new ProviderCallError("INVALID_RESPONSE", "AMOUNT_TO_MUST_BE_NULL", false);
        return {
          parsed: { type: "action", action: "check" },
          rawText: "{}",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          latencyMs: 1,
          providerRequestId: null,
        };
      },
    };
    const result = await runModelDecision({
      provider,
      request: strictRequest,
      validateAction: () => ({ action: "check" }),
      fallbackAction: () => ({ action: "fold" }),
    }, config);
    expect(result).toMatchObject({ status: "ACTION", protocolFailures: 1 });
    expect(payloads[1]).toMatchObject({
      arena_control: {
        mode: "protocol_correction",
        error_codes: ["AMOUNT_TO_MUST_BE_NULL"],
      },
    });
    expect(payloads[1]).not.toHaveProperty("protocol_correction");
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

  it("returns history results and remaining budget in the next model request", async () => {
    const payloads: unknown[] = [];
    let call = 0;
    const provider: ModelProvider = {
      kind: "mock-scripted",
      classifyError: (error) => error as ProviderCallError,
      decide: async (nextRequest): Promise<ProviderDecision> => {
        payloads.push(nextRequest.userPayload);
        call += 1;
        const parsed = call === 1
          ? { type: "history_query" as const, query: { kind: "recent_hands" as const, count: 1, limit: 10 } }
          : { type: "action" as const, action: "check" as const };
        return {
          parsed,
          rawText: JSON.stringify(parsed),
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
      executeHistoryQuery: async () => [{ handNo: 1, type: "ACTION_APPLIED" }],
    }, config);
    expect(result).toMatchObject({ status: "ACTION", usedFallback: false });
    expect(payloads[0]).toMatchObject({
      arena_state: request.userPayload,
      history_results: [],
      history_budget_remaining: { queries: 2, approximate_tokens: 4_000, max_records_per_query: 80 },
    });
    expect(payloads[1]).toMatchObject({
      arena_state: request.userPayload,
      history_results: [{
        query: { kind: "recent_hands", count: 1, limit: 10 },
        records: [{ handNo: 1, type: "ACTION_APPLIED" }],
      }],
      history_budget_remaining: { queries: 1 },
    });
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

  it("waits for the configured infrastructure retry intervals", async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      const provider: ModelProvider = {
        kind: "mock-scripted",
        classifyError: (error) => error as ProviderCallError,
        decide: async (): Promise<ProviderDecision> => {
          attempts += 1;
          if (attempts < 3) throw new ProviderCallError("TIMEOUT", "slow", true);
          return {
            parsed: { type: "action", action: "check" },
            rawText: '{"type":"action","action":"check"}',
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            latencyMs: 1,
            providerRequestId: null,
          };
        },
      };
      const pending = runModelDecision({
        provider,
        request,
        validateAction: () => ({ action: "check" }),
        fallbackAction: () => ({ action: "fold" }),
      }, { ...config, infrastructureRetryDelaysMs: [2_000, 8_000] });

      await vi.advanceTimersByTimeAsync(1_999);
      expect(attempts).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(attempts).toBe(2);
      await vi.advanceTimersByTimeAsync(7_999);
      expect(attempts).toBe(2);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toMatchObject({ status: "ACTION" });
      expect(attempts).toBe(3);
    } finally {
      vi.useRealTimers();
    }
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

  it("resumes with the same history conversation after an infrastructure pause", async () => {
    let saved: DecisionResumeState | null = null;
    let firstCall = true;
    const interrupted: ModelProvider = {
      kind: "mock-scripted",
      classifyError: (error) => error as ProviderCallError,
      decide: async (): Promise<ProviderDecision> => {
        if (firstCall) {
          firstCall = false;
          const parsed = { type: "history_query" as const, query: { kind: "recent_hands" as const, count: 1, limit: 10 } };
          return {
            parsed,
            rawText: JSON.stringify(parsed),
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            latencyMs: 1,
            providerRequestId: "history-call",
          };
        }
        throw new ProviderCallError("SERVER", "interrupted", true, 503);
      },
    };
    const paused = await runModelDecision({
      provider: interrupted,
      request,
      validateAction: () => ({ action: "check" }),
      fallbackAction: () => ({ action: "fold" }),
      executeHistoryQuery: async () => [{ kind: "hand_summary", hand_no: 1, complete: true }],
      saveResumeState: async (state) => { saved = structuredClone(state); },
    }, config);
    expect(paused).toMatchObject({ status: "PAUSED_INFRA" });
    expect(saved).toMatchObject({
      historyResults: [{ records: [{ kind: "hand_summary", hand_no: 1, complete: true }] }],
    });
    expect((saved as DecisionResumeState | null)?.calls).toHaveLength(4);
    expect((saved as DecisionResumeState | null)?.calls[0]?.outcome).toBe("SUCCESS");
    expect((saved as DecisionResumeState | null)?.calls.at(-1)?.outcome).toBe("INFRA_ERROR");

    const resumedPayloads: unknown[] = [];
    const resumedProvider: ModelProvider = {
      kind: "mock-scripted",
      classifyError: (error) => error as ProviderCallError,
      decide: async (nextRequest): Promise<ProviderDecision> => {
        resumedPayloads.push(nextRequest.userPayload);
        return {
          parsed: { type: "action", action: "check" },
          rawText: '{"type":"action","action":"check"}',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          latencyMs: 1,
          providerRequestId: "resumed-call",
        };
      },
    };
    const resumed = await runModelDecision({
      provider: resumedProvider,
      request,
      resumeState: saved,
      validateAction: () => ({ action: "check" }),
      fallbackAction: () => ({ action: "fold" }),
      executeHistoryQuery: async () => { throw new Error("History query must not run again"); },
    }, config);
    expect(resumed).toMatchObject({ status: "ACTION", action: { action: "check" } });
    expect(resumedPayloads[0]).toMatchObject({
      history_results: [{ records: [{ kind: "hand_summary", hand_no: 1, complete: true }] }],
      history_budget_remaining: { queries: 1 },
    });
    if (resumed.status === "ACTION") expect(resumed.calls.at(-1)?.attempt).toBe(5);
  });

  it("pauses v2 history infrastructure without charging a protocol failure and resumes the same query", async () => {
    let saved: DecisionResumeState | null = null;
    let queryAttempts = 0;
    const provider = new MockScriptedProvider([
      { type: "history_query", action: null, amount_to: null, decision_summary: null, query: { kind: "recent_hands", count: 1, limit: 10 } },
    ]);
    const strictRequest = {
      ...request,
      parserPolicy: "arena-parser-strict-v1" as const,
      adapterProtocolVersion: "arena-adapters-v2",
    };
    const paused = await runModelDecision({
      provider,
      request: strictRequest,
      historyProtocolVersion: "arena-history-v2",
      validateAction: () => ({ action: "check" }),
      fallbackAction: () => ({ action: "fold" }),
      executeHistoryQuery: async () => {
        queryAttempts += 1;
        throw new Error("database unavailable");
      },
      saveResumeState: async (state) => { saved = structuredClone(state); },
    }, config);
    expect(paused).toMatchObject({ status: "PAUSED_INFRA", errorKind: "SERVER", protocolFailures: 0 });
    expect(saved).toMatchObject({ pendingHistoryQuery: { kind: "recent_hands", count: 1, limit: 10 } });

    const resumed = await runModelDecision({
      provider: new MockScriptedProvider([
        { type: "action", action: "check", amount_to: null, decision_summary: null, query: null },
      ]),
      request: strictRequest,
      resumeState: saved,
      historyProtocolVersion: "arena-history-v2",
      validateAction: () => ({ action: "check" }),
      fallbackAction: () => ({ action: "fold" }),
      executeHistoryQuery: async () => {
        queryAttempts += 1;
        return [{ kind: "hand_summary", hand_no: 1, complete: true }];
      },
    }, config);
    expect(resumed).toMatchObject({ status: "ACTION", protocolFailures: 0, usedFallback: false });
    expect(queryAttempts).toBe(2);
  });

  it("truncates an oversized v2 history result without consuming correction", async () => {
    const result = await runModelDecision({
      provider: new MockScriptedProvider([
        { type: "history_query", action: null, amount_to: null, decision_summary: null, query: { kind: "recent_hands", count: 1, limit: 10 } },
        { type: "action", action: "check", amount_to: null, decision_summary: null, query: null },
      ]),
      request: { ...request, parserPolicy: "arena-parser-strict-v1", adapterProtocolVersion: "arena-adapters-v2" },
      historyProtocolVersion: "arena-history-v2",
      validateAction: () => ({ action: "check" }),
      fallbackAction: () => ({ action: "fold" }),
      executeHistoryQuery: async () => [{ kind: "hand_summary", actions: Array.from({ length: 1_000 }, (_, index) => ({ index })) }],
    }, { ...config, history: { ...config.history, maxBytes: 180 } });
    expect(result).toMatchObject({ status: "ACTION", protocolFailures: 0, usedFallback: false });
    if (result.status === "ACTION") {
      expect(result.historyResults[0]).toMatchObject({ truncated: true, truncationReason: "BYTE_BUDGET" });
    }
  });
});
