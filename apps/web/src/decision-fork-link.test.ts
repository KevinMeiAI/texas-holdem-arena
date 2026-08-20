import { describe, expect, it } from "vitest";
import type { DecisionAuditTurn } from "./types";
import { decisionForkHref, isForkableDecisionTurn } from "./decision-fork-link";

function turn(overrides: Partial<DecisionAuditTurn> = {}): DecisionAuditTurn {
  return {
    decision_id: "00000000-0000-4000-8000-000000000001",
    player_id: "player-1",
    turn_index: 1,
    request_hash: "a".repeat(64),
    request: {},
    response_hash: "b".repeat(64),
    response: { parsed: { action: "call", decision_summary: "Continue." } },
    outcome: "SUCCESS",
    error_kind: null,
    provider_config_hash: "c".repeat(64),
    output_schema_version: "v1",
    output_schema_hash: "d".repeat(64),
    latency_ms: 1_000,
    usage: null,
    created_at: "2026-08-20T00:00:00.000Z",
    ...overrides,
  };
}

describe("decision hand fork links", () => {
  it("offers a fork only for a successful poker action", () => {
    expect(isForkableDecisionTurn(turn())).toBe(true);
    expect(isForkableDecisionTurn(turn({ response: { parsed: { query: "recent_hands" } } }))).toBe(false);
    expect(isForkableDecisionTurn(turn({ outcome: "PROTOCOL_ERROR" }))).toBe(false);
    expect(isForkableDecisionTurn(turn({ response: null }))).toBe(false);
  });

  it("preserves the exact tournament, hand, and decision in the admin link", () => {
    expect(decisionForkHref("event / final", 31, "decision?id=1")).toBe(
      "/admin/hand-forks?tournamentId=event+%2F+final&handNo=31&decisionId=decision%3Fid%3D1",
    );
  });
});
