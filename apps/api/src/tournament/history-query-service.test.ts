import { describe, expect, it } from "vitest";
import {
  calculatePublicStats,
  summarizeHistoryHand,
  type HistoryPublicEvent,
} from "./history-query-service.js";

function event(
  sequence: number,
  type: string,
  publicPayload: unknown,
  actorId: string | null = null,
): HistoryPublicEvent {
  return { sequence, handNo: 1, type, actorId, publicPayload };
}

describe("normalized public poker history", () => {
  it("keeps completion and outcome visible when an action list is truncated", () => {
    const rows = [
      event(1, "FORCED_BET_POSTED", { playerId: "a", kind: "SMALL_BLIND", amount: 5, live: true }),
      event(2, "ACTION_APPLIED", { street: "PREFLOP", command: { action: "call" }, classification: "call", paid: 5, amountTo: 10 }, "a"),
      event(3, "ACTION_APPLIED", { street: "PREFLOP", command: { action: "check" }, classification: "check", paid: 0, amountTo: 10 }, "b"),
      event(4, "STREET_DEALT", { street: "FLOP", cards: [{ rank: 14, suit: "s" }, { rank: 10, suit: "h" }, { rank: 2, suit: "c" }] }),
      event(5, "ACTION_APPLIED", { street: "FLOP", command: { action: "bet", amountTo: 10 }, classification: "bet", paid: 10, amountTo: 10 }, "b"),
      event(6, "HAND_COMPLETED", { result: { winnerPlayerIds: ["b"] } }),
    ];
    const summary = summarizeHistoryHand(rows, 2);
    expect(summary).toMatchObject({
      kind: "hand_summary",
      hand_no: 1,
      complete: true,
      total_action_count: 3,
      actions_truncated: true,
      omitted_action_count: 1,
      action_window: "HEAD_AND_TAIL",
      board: [{ street: "FLOP", cards: ["As", "Th", "2c"] }],
      result: { result: { winnerPlayerIds: ["b"] } },
    });
    expect((summary?.actions as { sequence: number }[]).map((action) => action.sequence)).toEqual([2, 5]);
  });

  it("separates all-in calls from aggression and reports sample denominators", () => {
    const rows = [
      event(1, "HOLE_CARDS_DEALT", { playerId: "a" }),
      event(2, "HOLE_CARDS_DEALT", { playerId: "b" }),
      event(3, "ACTION_APPLIED", { street: "PREFLOP", command: { action: "all_in" }, classification: "call", paid: 90, amountTo: 100 }, "a"),
      event(4, "ACTION_APPLIED", { street: "PREFLOP", command: { action: "all_in" }, classification: "raise", paid: 90, amountTo: 100 }, "b"),
    ];
    const stats = calculatePublicStats(rows);
    expect(stats).toEqual(expect.arrayContaining([
      expect.objectContaining({
        player_id: "a",
        hands_observed: 1,
        vpip_hands: 1,
        pfr_hands: 0,
        all_in_calls: 1,
        all_in_aggressive: 0,
        facing_bet_decisions: 1,
        sample_warning: true,
      }),
      expect.objectContaining({
        player_id: "b",
        pfr_hands: 1,
        all_in_calls: 0,
        all_in_aggressive: 1,
      }),
    ]));
  });

  it("marks legacy all-ins as unknown instead of assuming aggression", () => {
    const stats = calculatePublicStats([
      event(1, "HOLE_CARDS_DEALT", { playerId: "a" }),
      event(2, "ACTION_APPLIED", { street: "PREFLOP", command: { action: "all_in" }, paid: 100, amountTo: 100 }, "a"),
    ]);
    expect(stats[0]).toMatchObject({
      player_id: "a",
      legacy_all_in_unknown: 1,
      pfr_hands: 0,
      all_in_aggressive: 0,
    });
  });
});
