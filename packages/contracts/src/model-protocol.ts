import { z } from "zod";

const unicodeText = (maximum: number) => z.string().refine(
  (value) => Array.from(value).length <= maximum,
  `must contain at most ${maximum} Unicode characters`,
);

export const pokerActionSchema = z.enum(["fold", "check", "call", "bet", "raise", "all_in"]);

export const actionResponseSchema = z.object({
  type: z.literal("action"),
  action: pokerActionSchema,
  amount_to: z.number().int().positive().optional(),
  decision_summary: unicodeText(300).optional(),
}).strict().superRefine((value, context) => {
  const needsAmount = value.action === "bet" || value.action === "raise";
  if (needsAmount && value.amount_to === undefined) {
    context.addIssue({ code: "custom", path: ["amount_to"], message: "bet and raise require amount_to" });
  }
  if (!needsAmount && value.amount_to !== undefined) {
    context.addIssue({ code: "custom", path: ["amount_to"], message: "amount_to is only valid for bet or raise" });
  }
});

const playerActionsQuerySchema = z.object({
  kind: z.literal("player_actions"),
  player_id: z.string().min(1),
  streets: z.array(z.enum(["PREFLOP", "FLOP", "TURN", "RIVER"])).max(4).optional(),
  actions: z.array(pokerActionSchema).max(6).optional(),
  limit: z.number().int().min(1).max(80),
}).strict();

const handQuerySchema = z.object({
  kind: z.literal("hand"),
  hand_no: z.number().int().positive(),
  limit: z.number().int().min(1).max(80).default(80),
}).strict();

const recentHandsQuerySchema = z.object({
  kind: z.literal("recent_hands"),
  count: z.number().int().min(1).max(20),
  limit: z.number().int().min(1).max(80),
}).strict();

const publicStatsQuerySchema = z.object({
  kind: z.literal("public_stats"),
  player_id: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(80).default(40),
}).strict();

export const historyQuerySchema = z.discriminatedUnion("kind", [
  playerActionsQuerySchema,
  handQuerySchema,
  recentHandsQuerySchema,
  publicStatsQuerySchema,
]);

export const historyQueryResponseSchema = z.object({
  type: z.literal("history_query"),
  query: historyQuerySchema,
}).strict();

export const runoutVoteResponseSchema = z.object({
  type: z.literal("runout_vote"),
  accept_run_it_twice: z.boolean(),
  message: unicodeText(160).optional(),
}).strict();

export const actionDecisionResponseSchema = z.union([
  actionResponseSchema,
  historyQueryResponseSchema,
]);

export type ActionResponse = z.infer<typeof actionResponseSchema>;
export type HistoryQuery = z.infer<typeof historyQuerySchema>;
export type HistoryQueryResponse = z.infer<typeof historyQueryResponseSchema>;
export type RunoutVoteResponse = z.infer<typeof runoutVoteResponseSchema>;
export type ActionDecisionResponse = z.infer<typeof actionDecisionResponseSchema>;

export type ExpectedModelOutput = "ACTION_OR_HISTORY" | "RUNOUT_VOTE";

export function parseModelJson(text: string, expected: ExpectedModelOutput): ActionDecisionResponse | RunoutVoteResponse {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    throw new Error("Model response must be one JSON object with no surrounding text or code fence");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    throw new Error("Model response is not valid JSON");
  }
  if (expected === "RUNOUT_VOTE") return runoutVoteResponseSchema.parse(parsed);
  const result = actionDecisionResponseSchema.safeParse(parsed);
  if (result.success) return result.data;
  // A malformed optional self-summary must not invalidate an otherwise legal
  // poker action. Drop only that field; strict parsing still rejects every
  // other unknown or malformed field.
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)
    && (parsed as { type?: unknown }).type === "action"
    && Object.prototype.hasOwnProperty.call(parsed, "decision_summary")) {
    const { decision_summary: _discarded, ...withoutSummary } = parsed as Record<string, unknown>;
    const salvaged = actionResponseSchema.safeParse(withoutSummary);
    if (salvaged.success) return salvaged.data;
  }
  throw result.error;
}

export interface CanonicalModelRequest {
  requestId: string;
  expectedOutput: ExpectedModelOutput;
  systemPrompt: string;
  systemPromptHash: string;
  userPayload: unknown;
  timeoutMs: number;
}
