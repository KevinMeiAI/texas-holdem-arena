import type {
  ActionResponse,
  CanonicalModelRequest,
  HistoryQuery,
} from "../../../../packages/contracts/src/model-protocol.js";
import { ModelProtocolError, type ProtocolErrorCode } from "../../../../packages/contracts/src/model-protocol.js";
import type { ActionCommand } from "../../../../packages/domain/src/betting.js";
import {
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
  checkpointTurn?: (checkpoint: DecisionTurnCheckpoint) => Promise<void>;
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
  pendingOutput?: DecisionPendingOutput | null;
  pendingInfrastructureFailure?: DecisionPendingInfrastructureFailure | null;
  infrastructureAttempts?: number;
}

export interface DecisionPendingOutput {
  turnIndex: number;
  parsed: ProviderDecision["parsed"];
  rawText: string;
  latencyMs: number;
  usage: ProviderDecision["usage"];
  providerRequestId: string | null;
  transportAudit?: ProviderDecision["transportAudit"];
}

export interface DecisionPendingInfrastructureFailure {
  turnIndex: number;
  errorKind: ProviderErrorKind;
  message: string;
  retryable: boolean;
  exhausted: boolean;
  retryDelayMs: number;
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
    transportAudit?: ProviderDecision["transportAudit"];
  };
}

export interface DecisionTurnCheckpoint {
  turn: DecisionTurnAudit;
  resumeState: DecisionResumeState;
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
  const queriesRemaining = budget.state.maxQueries - budget.state.usedQueries;
  return {
    ...request,
    userPayload: strictControl ? {
      arena_control: {
        mode: correction ? "protocol_correction" : "decision",
        correction_attempt: correction ? 1 : 0,
        max_correction_attempts: 1,
        error_codes: correction ? [correction] : [],
        history_budget_remaining: {
          queries: queriesRemaining,
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
        queries: queriesRemaining,
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
  let pendingOutput: DecisionPendingOutput | null = input.resumeState?.pendingOutput ?? null;
  let pendingInfrastructureFailure: DecisionPendingInfrastructureFailure | null =
    input.resumeState?.pendingInfrastructureFailure ?? null;
  let infrastructureAttempts = input.resumeState?.infrastructureAttempts ?? 0;
  if (!Number.isSafeInteger(infrastructureAttempts) || infrastructureAttempts < 0) {
    throw new Error("Decision resume infrastructureAttempts must be a non-negative integer");
  }
  if (pendingOutput && pendingInfrastructureFailure) {
    throw new Error("Decision resume state cannot contain two pending provider outcomes");
  }
  if (pendingOutput && pendingHistoryQuery) {
    throw new Error("Decision resume state cannot contain pending output and history simultaneously");
  }
  const assertPendingTurn = (
    turnIndex: number,
    expectedOutcome: CallAudit["outcome"],
  ): void => {
    const call = calls[turnIndex - 1];
    if (!call || call.attempt !== turnIndex || call.outcome !== expectedOutcome) {
      throw new Error("Decision resume pending outcome does not match its call audit");
    }
  };
  if (pendingOutput) assertPendingTurn(pendingOutput.turnIndex, "SUCCESS");
  if (pendingInfrastructureFailure) {
    assertPendingTurn(pendingInfrastructureFailure.turnIndex, "INFRA_ERROR");
  }
  const currentResumeState = (): DecisionResumeState => ({
    historyResults: [...historyResults],
    protocolFailures,
    correction,
    calls: [...calls],
    pendingHistoryQuery,
    pendingOutput,
    pendingInfrastructureFailure,
    infrastructureAttempts,
  });
  const saveResumeState = async () => input.saveResumeState?.(currentResumeState());
  const checkpointTurn = async (turn: DecisionTurnAudit): Promise<void> => {
    const resumeState = currentResumeState();
    if (input.checkpointTurn) {
      await input.checkpointTurn({ turn, resumeState });
      return;
    }
    await input.auditTurn?.(turn);
    await input.saveResumeState?.(resumeState);
  };

  while (true) {
    if (protocolFailures > 1
      && !pendingOutput
      && !pendingHistoryQuery
      && !pendingInfrastructureFailure) {
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

    if (pendingInfrastructureFailure) {
      const failure = pendingInfrastructureFailure;
      if (failure.exhausted || !failure.retryable) {
        if (!input.checkpointTurn) {
          pendingInfrastructureFailure = null;
          infrastructureAttempts = 0;
          await saveResumeState();
        }
        return {
          status: "PAUSED_INFRA",
          errorKind: failure.errorKind,
          message: failure.message,
          protocolFailures,
          historyResults,
          calls,
        };
      }
      pendingInfrastructureFailure = null;
      await saveResumeState();
      if (failure.retryDelayMs > 0) await wait(failure.retryDelayMs);
    }

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

    if (!pendingOutput) {
      const turnRequest = withFeedback(input.request, historyResults, correction, budget);
      let providerError: unknown = null;
      let decision: ProviderDecision | null = null;
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
        infrastructureAttempts = 0;
        pendingInfrastructureFailure = null;
        pendingOutput = {
          turnIndex: call.attempt,
          parsed: decision.parsed,
          rawText: decision.rawText,
          latencyMs: decision.latencyMs,
          usage: decision.usage,
          providerRequestId: decision.providerRequestId,
          ...(decision.transportAudit ? { transportAudit: decision.transportAudit } : {}),
        };
        await checkpointTurn({
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
            ...(decision.transportAudit ? { transportAudit: decision.transportAudit } : {}),
          },
        });
      } else {
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
        const turn: DecisionTurnAudit = {
          turnIndex: call.attempt,
          request: turnRequest,
          outcome: call.outcome,
          errorKind: call.errorKind,
          latencyMs: null,
          usage: null,
          ...(classified.rawResponseText !== undefined ? {
            response: {
              rawText: classified.rawResponseText,
              providerRequestId: null,
            },
          } : {}),
        };
        if (classified.kind === "INVALID_RESPONSE") {
          pendingOutput = null;
          pendingInfrastructureFailure = null;
          infrastructureAttempts = 0;
          protocolFailures += 1;
          correction = input.request.parserPolicy === "arena-parser-strict-v1"
            ? classified.message.match(/^[A-Z][A-Z_]+$/)?.[0] ?? "INVALID_JSON"
            : classified.message;
          await checkpointTurn(turn);
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
          continue;
        }
        infrastructureAttempts += 1;
        const exhausted = !classified.retryable
          || infrastructureAttempts >= config.maxInfrastructureAttempts;
        pendingInfrastructureFailure = {
          turnIndex: call.attempt,
          errorKind: classified.kind,
          message: classified.message,
          retryable: classified.retryable,
          exhausted,
          retryDelayMs: exhausted
            ? 0
            : config.infrastructureRetryDelaysMs[infrastructureAttempts - 1] ?? 0,
        };
        await checkpointTurn(turn);
        continue;
      }
    }

    const decision: ProviderDecision = {
      parsed: pendingOutput.parsed,
      rawText: pendingOutput.rawText,
      usage: pendingOutput.usage,
      latencyMs: pendingOutput.latencyMs,
      providerRequestId: pendingOutput.providerRequestId,
      ...(pendingOutput.transportAudit ? { transportAudit: pendingOutput.transportAudit } : {}),
    };
    try {
      if (decision.parsed.type === "history_query") {
        if (!input.executeHistoryQuery) throw new Error("History queries are not available");
        if (budget.state.maxQueries === 0) {
          throw new ModelProtocolError("HISTORY_QUERY_INVALID", "History queries are disabled for this track");
        }
        pendingHistoryQuery = decision.parsed.query;
        pendingOutput = null;
        await saveResumeState();
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
      pendingOutput = null;
      infrastructureAttempts = 0;
      protocolFailures += 1;
      correction = correctionCode(error);
      await saveResumeState();
      if (protocolFailures <= 1) {
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
