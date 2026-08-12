import type {
  ActionResponse,
  CanonicalModelRequest,
  HistoryQuery,
} from "../../../../packages/contracts/src/model-protocol.js";
import { ModelProtocolError, type ProtocolErrorCode } from "../../../../packages/contracts/src/model-protocol.js";
import type { ActionCommand } from "../../../../packages/domain/src/betting.js";
import {
  ProviderCallError,
  type ModelProvider,
  type ProviderDecision,
  type ProviderErrorKind,
} from "../../../../packages/providers/src/provider.js";
import { HistoryBudget, type HistoryQueryResult } from "./history-budget.js";

export interface DecisionRunnerConfig {
  maxInfrastructureAttempts: number;
  infrastructureRetryDelaysMs: readonly number[];
  history: {
    maxQueries: number;
    maxRecordsPerQuery: number;
    maxApproxTokens: number;
    maxBytes?: number;
  };
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export interface DecisionRunnerInput {
  provider: ModelProvider;
  request: CanonicalModelRequest;
  validateAction?: (response: ActionResponse) => ActionCommand;
  fallbackAction?: () => ActionCommand;
  executeHistoryQuery?: (query: HistoryQuery) => Promise<unknown[]>;
  historyProtocolVersion?: "arena-history-legacy-v1" | "arena-history-v2";
  resumeState?: DecisionResumeState | null;
  saveResumeState?: (state: DecisionResumeState) => Promise<void>;
  auditTurn?: (turn: DecisionTurnAudit) => Promise<void>;
}

export interface CallAudit {
  attempt: number;
  outcome: "SUCCESS" | "PROTOCOL_ERROR" | "INFRA_ERROR";
  errorKind: ProviderErrorKind | null;
  latencyMs: number | null;
  usage: ProviderDecision["usage"] | null;
}

export interface DecisionResumeState {
  historyResults: HistoryQueryResult[];
  protocolFailures: number;
  correction: string | null;
  calls: CallAudit[];
  pendingHistoryQuery?: HistoryQuery | null;
}

export interface DecisionTurnAudit {
  turnIndex: number;
  request: CanonicalModelRequest;
  outcome: CallAudit["outcome"];
  errorKind: ProviderErrorKind | null;
  latencyMs: number | null;
  usage: ProviderDecision["usage"] | null;
  response?: {
    rawText: string;
    parsed?: ProviderDecision["parsed"];
    providerRequestId: string | null;
  };
}

export type DecisionRunnerResult =
  | {
    status: "ACTION";
    action: ActionCommand;
    response: ActionResponse | null;
    usedFallback: boolean;
    protocolFailures: number;
    historyResults: HistoryQueryResult[];
    calls: CallAudit[];
  }
  | {
    status: "PAUSED_INFRA";
    errorKind: ProviderErrorKind;
    message: string;
    protocolFailures: number;
    historyResults: HistoryQueryResult[];
    calls: CallAudit[];
  };

function withFeedback(
  request: CanonicalModelRequest,
  historyResults: readonly HistoryQueryResult[],
  correction: string | null,
  budget: HistoryBudget,
): CanonicalModelRequest {
  const strictControl = request.parserPolicy === "arena-parser-strict-v1";
  return {
    ...request,
    userPayload: strictControl ? {
      arena_control: {
        mode: correction ? "protocol_correction" : "decision",
        correction_attempt: correction ? 1 : 0,
        max_correction_attempts: 1,
        error_codes: correction ? [correction] : [],
        history_budget_remaining: {
          queries: budget.state.maxQueries - budget.state.usedQueries,
          approximate_tokens: budget.state.maxApproxTokens - budget.state.usedApproxTokens,
          max_records_per_query: budget.state.maxRecordsPerQuery,
        },
      },
      arena_state: request.userPayload,
      history_results: [...historyResults],
    } : {
      arena_state: request.userPayload,
      history_results: [...historyResults],
      history_budget_remaining: {
        queries: budget.state.maxQueries - budget.state.usedQueries,
        approximate_tokens: budget.state.maxApproxTokens - budget.state.usedApproxTokens,
        max_records_per_query: budget.state.maxRecordsPerQuery,
      },
      ...(correction ? {
        protocol_correction: {
          message: correction,
          instruction: "Return one corrected JSON object now. This is the only correction attempt.",
        },
      } : {}),
    },
  };
}

function correctionCode(error: unknown): ProtocolErrorCode {
  return error instanceof ModelProtocolError ? error.code : "WIRE_SCHEMA_VIOLATION";
}

export async function runModelDecision(
  input: DecisionRunnerInput,
  config: DecisionRunnerConfig,
): Promise<DecisionRunnerResult> {
  if (!Number.isSafeInteger(config.maxInfrastructureAttempts) || config.maxInfrastructureAttempts < 1) {
    throw new Error("maxInfrastructureAttempts must be positive");
  }
  if (config.infrastructureRetryDelaysMs.some((delay) => !Number.isSafeInteger(delay) || delay < 0)) {
    throw new Error("infrastructureRetryDelaysMs must contain non-negative integers");
  }
  const budget = new HistoryBudget(config.history);
  const historyResults: HistoryQueryResult[] = [];
  for (const result of input.resumeState?.historyResults ?? []) {
    const reconstructed = input.historyProtocolVersion === "arena-history-v2"
      ? budget.consumeBounded(result.query, result.records)
      : budget.consume(result.query, result.records);
    historyResults.push({ ...reconstructed, ...result, records: reconstructed.records });
  }
  const calls: CallAudit[] = [...(input.resumeState?.calls ?? [])];
  let protocolFailures = input.resumeState?.protocolFailures ?? 0;
  let correction: string | null = input.resumeState?.correction ?? null;
  let pendingHistoryQuery: HistoryQuery | null = input.resumeState?.pendingHistoryQuery ?? null;
  const saveResumeState = async () => input.saveResumeState?.({
    historyResults: [...historyResults],
    protocolFailures,
    correction,
    calls: [...calls],
    pendingHistoryQuery,
  });

  while (true) {
    if (pendingHistoryQuery) {
      try {
        if (!input.executeHistoryQuery) throw new Error("History queries are not available");
        const records = await input.executeHistoryQuery(pendingHistoryQuery);
        historyResults.push(input.historyProtocolVersion === "arena-history-v2"
          ? budget.consumeBounded(pendingHistoryQuery, records)
          : budget.consume(pendingHistoryQuery, records));
        pendingHistoryQuery = null;
        correction = null;
        await saveResumeState();
      } catch (error) {
        if (error instanceof ModelProtocolError) {
          pendingHistoryQuery = null;
          protocolFailures += 1;
          correction = error.code;
          await saveResumeState();
          if (protocolFailures <= 1) continue;
          if (!input.fallbackAction) throw new Error("Poker fallback action is not configured");
          return {
            status: "ACTION",
            action: input.fallbackAction(),
            response: null,
            usedFallback: true,
            protocolFailures,
            historyResults,
            calls,
          };
        }
        await saveResumeState();
        return {
          status: "PAUSED_INFRA",
          errorKind: "SERVER",
          message: "Arena history service is unavailable",
          protocolFailures,
          historyResults,
          calls,
        };
      }
    }
    let decision: ProviderDecision | null = null;
    for (let infrastructureAttempt = 1; infrastructureAttempt <= config.maxInfrastructureAttempts; infrastructureAttempt += 1) {
      const turnRequest = withFeedback(input.request, historyResults, correction, budget);
      let providerError: unknown = null;
      try {
        decision = await input.provider.decide(turnRequest);
      } catch (error) {
        providerError = error;
      }
      if (decision) {
        const call: CallAudit = {
          attempt: calls.length + 1,
          outcome: "SUCCESS",
          errorKind: null,
          latencyMs: decision.latencyMs,
          usage: decision.usage,
        };
        calls.push(call);
        await input.auditTurn?.({
          turnIndex: call.attempt,
          request: turnRequest,
          outcome: call.outcome,
          errorKind: null,
          latencyMs: call.latencyMs,
          usage: call.usage,
          response: {
            rawText: decision.rawText,
            parsed: decision.parsed,
            providerRequestId: decision.providerRequestId,
          },
        });
        await saveResumeState();
        break;
      }
      const classified = input.provider.classifyError(providerError);
      const call: CallAudit = classified.kind === "INVALID_RESPONSE" ? {
        attempt: calls.length + 1,
        outcome: "PROTOCOL_ERROR",
        errorKind: classified.kind,
        latencyMs: null,
        usage: null,
      } : {
        attempt: calls.length + 1,
        outcome: "INFRA_ERROR",
        errorKind: classified.kind,
        latencyMs: null,
        usage: null,
      };
      calls.push(call);
      await input.auditTurn?.({
        turnIndex: call.attempt,
        request: turnRequest,
        outcome: call.outcome,
        errorKind: call.errorKind,
        latencyMs: null,
        usage: null,
        ...(classified.rawResponseText ? {
          response: {
            rawText: classified.rawResponseText,
            providerRequestId: null,
          },
        } : {}),
      });
      if (classified.kind === "INVALID_RESPONSE") {
        if (input.request.parserPolicy === "arena-parser-strict-v1") {
          correction = classified.message.match(/^[A-Z][A-Z_]+$/)?.[0] ?? "INVALID_JSON";
          protocolFailures += 1;
          if (protocolFailures > 1) {
            if (!input.fallbackAction) throw new Error("Poker fallback action is not configured");
            return {
              status: "ACTION",
              action: input.fallbackAction(),
              response: null,
              usedFallback: true,
              protocolFailures,
              historyResults,
              calls,
            };
          }
        } else {
          correction = classified.message;
        }
        await saveResumeState();
        break;
      }
      await saveResumeState();
      if (!classified.retryable || infrastructureAttempt === config.maxInfrastructureAttempts) {
        return {
          status: "PAUSED_INFRA",
          errorKind: classified.kind,
          message: classified.message,
          protocolFailures,
          historyResults,
          calls,
        };
      }
      const retryDelayMs = config.infrastructureRetryDelaysMs[infrastructureAttempt - 1] ?? 0;
      if (retryDelayMs > 0) await wait(retryDelayMs);
    }

    try {
      if (!decision) {
        if (input.request.parserPolicy === "arena-parser-strict-v1") continue;
        throw new ProviderCallError("INVALID_RESPONSE", correction ?? "Invalid model response", false);
      }
      if (decision.parsed.type === "history_query") {
        if (!input.executeHistoryQuery) throw new Error("History queries are not available");
        pendingHistoryQuery = decision.parsed.query;
        await saveResumeState();
        try {
          const records = await input.executeHistoryQuery(pendingHistoryQuery);
          historyResults.push(input.historyProtocolVersion === "arena-history-v2"
            ? budget.consumeBounded(pendingHistoryQuery, records)
            : budget.consume(pendingHistoryQuery, records));
          pendingHistoryQuery = null;
          correction = null;
          await saveResumeState();
        } catch (error) {
          if (error instanceof ModelProtocolError) {
            pendingHistoryQuery = null;
            throw error;
          }
          if (input.historyProtocolVersion !== "arena-history-v2") throw error;
          await saveResumeState();
          return {
            status: "PAUSED_INFRA",
            errorKind: "SERVER",
            message: "Arena history service is unavailable",
            protocolFailures,
            historyResults,
            calls,
          };
        }
        continue;
      }
      if (decision.parsed.type !== "action" || !input.validateAction) {
        throw new Error("Expected a validated poker action");
      }
      return {
        status: "ACTION",
        action: input.validateAction(decision.parsed),
        response: decision.parsed,
        usedFallback: false,
        protocolFailures,
        historyResults,
        calls,
      };
    } catch (error) {
      protocolFailures += 1;
      if (protocolFailures <= 1) {
        correction = correctionCode(error);
        await saveResumeState();
        continue;
      }
      if (!input.fallbackAction) throw new Error("Poker fallback action is not configured");
      return {
        status: "ACTION",
        action: input.fallbackAction(),
        response: null,
        usedFallback: true,
        protocolFailures,
        historyResults,
        calls,
      };
    }
  }
}
