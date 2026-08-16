import { describe, expect, it } from "vitest";
import { settlementPresentationAtSequence, spectatorTimeline } from "./spectator-event-timeline";
import type { ArenaEvent } from "./types";

function event(sequence: number, type: string, publicPayload: Record<string, unknown> = {}, actorId: string | null = null): ArenaEvent {
  return {
    tournamentId: "tournament",
    sequence,
    aggregateVersion: sequence,
    type,
    actorId,
    handNo: 7,
    publicPayload,
    eventHash: `hash-${sequence}`,
    createdAt: "2026-08-13T00:00:00.000Z",
  };
}

describe("spectatorTimeline", () => {
  it("keeps spectator events while hiding engine and model-call audit events", () => {
    const timeline = spectatorTimeline([
      event(1, "BETTING_ROUND_STARTED", { street: "PREFLOP" }),
      event(2, "MODEL_DECISION_RECORDED", { providerCalls: 2 }, "alpha"),
      event(3, "POT_CREATED", { pot: { amount: 400 } }),
      event(4, "FORCED_BET_POSTED", { playerId: "alpha", kind: "BIG_BLIND", amount: 100 }),
      event(5, "ACTION_APPLIED", { classification: "call", command: { action: "call" }, paid: 100 }, "beta"),
      event(6, "POT_AWARDED", { award: { playerId: "beta", amount: 400 } }),
    ]);

    expect(timeline.map(({ event: item }) => item.type)).toEqual([
      "FORCED_BET_POSTED",
      "ACTION_APPLIED",
      "POT_AWARDED",
    ]);
  });

  it("groups private deals and classifies player actions by poker meaning", () => {
    const timeline = spectatorTimeline([
      event(1, "HOLE_CARDS_DEALT", { playerId: "alpha" }),
      event(2, "HOLE_CARDS_DEALT", { playerId: "beta" }),
      event(3, "ACTION_APPLIED", { classification: "raise", command: { action: "all_in" } }, "alpha"),
      event(4, "ACTION_APPLIED", { classification: "call", command: { action: "all_in" } }, "beta"),
      event(5, "ACTION_APPLIED", { classification: "fold", command: { action: "fold" } }, "alpha"),
    ]);

    expect(timeline.map(({ event: item, tone }) => [item.type, tone])).toEqual([
      ["HOLE_CARDS_DEALT", "deal"],
      ["ACTION_APPLIED", "aggressive"],
      ["ACTION_APPLIED", "passive"],
      ["ACTION_APPLIED", "fold"],
    ]);
  });

  it("merges every pot into one spectator result when the same player wins them all", () => {
    const timeline = spectatorTimeline([
      event(10, "POT_AWARDED", { award: { potIndex: 0, playerId: "alpha", amount: 400 } }),
      event(11, "POT_AWARDED", { award: { potIndex: 1, playerId: "alpha", amount: 300 } }),
      event(12, "POT_AWARDED", { award: { potIndex: 2, playerId: "alpha", amount: 6_800 } }),
      event(13, "HAND_COMPLETED"),
    ]);

    const settlement = timeline.find(({ event: item }) => item.type === "POT_AWARDED");
    expect(timeline.filter(({ event: item }) => item.type === "POT_AWARDED")).toHaveLength(1);
    expect(settlement?.event).toMatchObject({
      sequence: 12,
      publicPayload: { award: { playerId: "alpha", amount: 7_500 }, mergedAwardCount: 3 },
    });
    expect(settlement?.sourceSequences).toEqual([10, 11, 12]);
    expect(settlementPresentationAtSequence(timeline, 12)).toEqual({
      sequence: 12,
      winnerPlayerIds: ["alpha"],
      amountsByPlayer: { alpha: 7_500 },
      isFinalAward: true,
    });
  });

  it("keeps side-pot awards separate when more than one player receives chips", () => {
    const timeline = spectatorTimeline([
      event(20, "POT_AWARDED", { award: { potIndex: 0, playerId: "alpha", amount: 800 } }),
      event(21, "POT_AWARDED", { award: { potIndex: 1, playerId: "beta", amount: 200 } }),
      event(22, "HAND_COMPLETED"),
    ]);

    expect(timeline.filter(({ event: item }) => item.type === "POT_AWARDED").map(({ event: item }) => item.sequence)).toEqual([20, 21]);
    expect(settlementPresentationAtSequence(timeline, 20)).toMatchObject({ winnerPlayerIds: ["alpha"], isFinalAward: false });
    expect(settlementPresentationAtSequence(timeline, 21)).toEqual({
      sequence: 21,
      winnerPlayerIds: ["alpha", "beta"],
      amountsByPlayer: { alpha: 800, beta: 200 },
      isFinalAward: true,
    });
  });
});
