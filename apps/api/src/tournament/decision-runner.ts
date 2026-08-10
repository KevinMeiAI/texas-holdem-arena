import type {
  ActionResponse,
  CanonicalModelRequest,
  HistoryQuery,
  RunoutVoteResponse,
} from "../../../../packages/contracts/src/model-protocol.js";
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
  history: {
    maxQueries: number;
    maxEventsPerQuery: number;
    maxApproxTokens: number;
  };
}

export interface DecisionRunnerInput {
  provider: ModelProvider;
  request: CanonicalModelRequest;
  validateAction?: (response: ActionResponse) => ActionCommand;
  fallbackAction?: () => ActionCommand;
  executeHistoryQuery?: (query: HistoryQuery) => Promise<unknown[]>;
}

export interface CallAudit {
  attempt: number;
  outcome: "SUCCESS" | "PROTOCOL_ERROR" | "INFRA_ERROR";
  errorKind: ProviderErrorKind | null;
  latencyMs: number | null;
  usage: ProviderDecision["usage"] | null;
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
    status: "RUNOUT_VOTE";
    response: RunoutVoteResponse;
    usedFallback: boolean;
    protocolFailures: number;
    historyResults: [];
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
  return {
    ...request,
    userPayload: {
      arena_state: request.userPayload,
      history_results: [...historyResults],
      history_budget_remaining: {
        queries: budget.state.maxQueries - budget.state.usedQueries,
        approximate_tokens: budget.state.maxApproxTokens - budget.state.usedApproxTokens,
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

export async function runModelDecision(
  input: DecisionRunnerInput,
  config: DecisionRunnerConfig,
): Promise<DecisionRunnerResult> {
  if (!Number.isSafeInteger(config.maxInfrastructureAttempts) || config.maxInfrastructureAttempts < 1) {
    throw new Error("maxInfrastructureAttempts must be positive");
  }
  const budget = new HistoryBudget(config.history);
  const historyResults: HistoryQueryResult[] = [];
  const calls: CallAudit[] = [];
  let protocolFailures = 0;
  let correction: string | null = null;

  while (true) {
    let decision: ProviderDecision | null = null;
    for (let infrastructureAttempt = 1; infrastructureAttempt <= config.maxInfrastructureAttempts; infrastructureAttempt += 1) {
      try {
        decision = await input.provider.decide(withFeedback(
          input.request,
          historyResults,
          correction,
          budget,
        ));
        calls.push({
          attempt: calls.length + 1,
          outcome: "SUCCESS",
          errorKind: null,
          latencyMs: decision.latencyMs,
          usage: decision.usage,
        });
        break;
      } catch (error) {
        const classified = input.provider.classifyError(error);
        if (classified.kind === "INVALID_RESPONSE") {
          calls.push({
            attempt: calls.length + 1,
            outcome: "PROTOCOL_ERROR",
            errorKind: classified.kind,
            latencyMs: null,
            usage: null,
          });
          correction = classified.message;
          break;
        }
        calls.push({
          attempt: calls.length + 1,
          outcome: "INFRA_ERROR",
          errorKind: classified.kind,
          latencyMs: null,
          usage: null,
        });
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
      }
    }

    try {
      if (!decision) throw new ProviderCallError("INVALID_RESPONSE", correction ?? "Invalid model response", false);
      if (input.request.expectedOutput === "RUNOUT_VOTE") {
        if (decision.parsed.type !== "runout_vote") throw new Error("Expected a runout_vote response");
        return {
          status: "RUNOUT_VOTE",
          response: decision.parsed,
          usedFallback: false,
          protocolFailures,
          historyResults: [],
          calls,
        };
      }
      if (decision.parsed.type === "history_query") {
        if (!input.executeHistoryQuery) throw new Error("History queries are not available");
        const events = await input.executeHistoryQuery(decision.parsed.query);
        historyResults.push(budget.consume(decision.parsed.query, events));
        correction = null;
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
        correction = error instanceof Error ? error.message : "Protocol validation failed";
        continue;
      }
      if (input.request.expectedOutput === "RUNOUT_VOTE") {
        return {
          status: "RUNOUT_VOTE",
          response: { type: "runout_vote", accept_run_it_twice: false, message: "" },
          usedFallback: true,
          protocolFailures,
          historyResults: [],
          calls,
        };
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
