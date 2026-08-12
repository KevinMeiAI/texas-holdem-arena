import { createHash } from "node:crypto";
import type { ExpectedModelOutput } from "./model-protocol.js";

export const ARENA_OUTPUT_SCHEMA_VERSION = "arena-output-v2";

type JsonSchema = Record<string, unknown>;

const nullable = (schema: JsonSchema): JsonSchema => ({
  anyOf: [schema, { type: "null" }],
});

const pokerAction = {
  type: "string",
  enum: ["fold", "check", "call", "bet", "raise", "all_in"],
};

const handQuery = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["hand"] },
    hand_no: { type: "integer", minimum: 1 },
    limit: { type: "integer", minimum: 1, maximum: 80 },
  },
  required: ["kind", "hand_no", "limit"],
  additionalProperties: false,
};

const recentHandsQuery = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["recent_hands"] },
    count: { type: "integer", minimum: 1, maximum: 20 },
    limit: { type: "integer", minimum: 1, maximum: 80 },
  },
  required: ["kind", "count", "limit"],
  additionalProperties: false,
};

const playerActionsQuery = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["player_actions"] },
    player_id: { type: "string" },
    streets: nullable({
      type: "array",
      items: { type: "string", enum: ["PREFLOP", "FLOP", "TURN", "RIVER"] },
      maxItems: 4,
    }),
    actions: nullable({ type: "array", items: pokerAction, maxItems: 6 }),
    limit: { type: "integer", minimum: 1, maximum: 80 },
  },
  required: ["kind", "player_id", "streets", "actions", "limit"],
  additionalProperties: false,
};

const publicStatsQuery = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["public_stats"] },
    player_id: nullable({ type: "string" }),
    limit: { type: "integer", minimum: 1, maximum: 80 },
  },
  required: ["kind", "player_id", "limit"],
  additionalProperties: false,
};

const actionOrHistorySchema = {
  type: "object",
  properties: {
    type: { type: "string", enum: ["action", "history_query"] },
    action: nullable(pokerAction),
    amount_to: {
      ...nullable({ type: "integer", minimum: 1 }),
      description: "Must be null for fold, check, call, and all_in; use a positive integer only for bet or raise.",
    },
    decision_summary: nullable({ type: "string" }),
    query: {
      anyOf: [handQuery, recentHandsQuery, playerActionsQuery, publicStatsQuery, { type: "null" }],
    },
  },
  required: ["type", "action", "amount_to", "decision_summary", "query"],
  additionalProperties: false,
};

export interface ArenaOutputSchema {
  version: string;
  name: string;
  schema: JsonSchema;
  sha256: string;
}

export function arenaOutputSchema(
  expected: ExpectedModelOutput,
  version = ARENA_OUTPUT_SCHEMA_VERSION,
): ArenaOutputSchema {
  if (version !== "arena-output-v2") throw new Error(`Unsupported Arena output schema version: ${version}`);
  const name = "arena_action_or_history";
  const schema = actionOrHistorySchema;
  const serialized = JSON.stringify(schema);
  return {
    version,
    name,
    schema,
    sha256: createHash("sha256").update(serialized, "utf8").digest("hex"),
  };
}
