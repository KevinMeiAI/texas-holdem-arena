import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { cardCode, createDeck } from "../../../../packages/domain/src/cards.js";
import { createTournament, reduceTournament, startTournamentHand } from "../../../../packages/domain/src/tournament.js";
import { ARENA_PROMPT_VERSION } from "../../../../packages/contracts/src/system-prompt.js";
import type { ProjectedArenaEvent } from "../../../../packages/contracts/src/visibility.js";
import { HistoryBudget } from "./history-budget.js";
import { buildModelContext } from "./model-context.js";

function seatSubsets(seats: readonly number[]): number[][] {
  const result: number[][] = [];
  for (let mask = 0; mask < 2 ** seats.length; mask += 1) {
    const subset = seats.filter((_, index) => (mask & (1 << index)) !== 0);
    if (subset.length >= 2) result.push(subset);
  }
  return result;
}

describe("model-self context projection", () => {
  it("includes the hero hand but never an opponent's private cards or deck", () => {
    let state = createTournament({
      seatCount: 2,
      players: [{ id: "hero", seat: 0 }, { id: "villain", seat: 1 }],
      initialStack: 1_000,
      initialButton: 0,
      handsPerLevel: 10,
      blindLevels: [{ smallBlind: 5, bigBlind: 10, bigBlindAnte: 0 }],
    });
    state = startTournamentHand(state, createDeck()).state;
    const hand = state.currentHand!;
    const heroCodes = hand.players.find((player) => player.id === "hero")!.holeCards.map(cardCode);
    const villainCodes = hand.players.find((player) => player.id === "villain")!.holeCards.map(cardCode);
    const budget = new HistoryBudget({ maxQueries: 2, maxRecordsPerQuery: 80, maxApproxTokens: 4_000 });
    const serialized = JSON.stringify(buildModelContext({
      tournamentId: "11111111-1111-4111-8111-111111111111",
      rulesetVersion: "arena-rules-v1",
      promptVersion: ARENA_PROMPT_VERSION,
      state,
      playerId: "hero",
      currentHandEvents: [],
      historyBudget: budget.state,
    }));
    for (const code of heroCodes) expect(serialized).toContain(code);
    for (const code of villainCodes) expect(serialized).not.toContain(code);
    expect(serialized).not.toContain("nextCardIndex");
    expect(serialized).not.toContain("burnCards");
  });

  it("describes heads-up position and both street action orders explicitly", () => {
    let state = createTournament({
      seatCount: 6,
      players: [{ id: "hero", seat: 1 }, { id: "villain", seat: 4 }],
      initialStack: 1_000,
      initialButton: 1,
      handsPerLevel: 10,
      blindLevels: [{ smallBlind: 5, bigBlind: 10, bigBlindAnte: 0 }],
    });
    state = startTournamentHand(state, createDeck()).state;
    const context = buildModelContext({
      tournamentId: "11111111-1111-4111-8111-111111111111",
      rulesetVersion: "arena-rules-v1",
      promptVersion: ARENA_PROMPT_VERSION,
      state,
      playerId: "hero",
      currentHandEvents: [],
      historyBudget: new HistoryBudget({ maxQueries: 2, maxRecordsPerQuery: 80, maxApproxTokens: 4_000 }).state,
    }) as { schema_version: string; positions: Record<string, unknown> };
    expect(context.schema_version).toBe("model-context-v3");
    expect(context.positions).toMatchObject({
      button_seat: 1,
      small_blind_seat: 1,
      big_blind_seat: 4,
      heads_up: true,
      dead_button: false,
      hero_position: "BTN/SB",
      preflop_action_order: ["hero", "villain"],
      postflop_action_order: ["villain", "hero"],
    });
  });

  it("provides exact pot, effective-stack, blind-clock and compact action context", () => {
    let state = createTournament({
      seatCount: 2,
      players: [{ id: "hero", seat: 0 }, { id: "villain", seat: 1 }],
      initialStack: 1_000,
      initialButton: 0,
      handsPerLevel: 10,
      blindLevels: [{ smallBlind: 5, bigBlind: 10, bigBlindAnte: 0 }],
    });
    state = startTournamentHand(state, createDeck()).state;
    state = reduceTournament(state, {
      type: "ACTION",
      playerId: "hero",
      action: { action: "call" },
    }).state;
    const base = {
      tournamentId: "11111111-1111-4111-8111-111111111111",
      aggregateVersion: 1,
      handNo: 1,
      eventHash: "a".repeat(64),
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const currentHandEvents: ProjectedArenaEvent[] = [
      { ...base, sequence: 1, type: "FORCED_BET_POSTED", actorId: null, publicPayload: { playerId: "hero", kind: "SMALL_BLIND", amount: 5, live: true } },
      { ...base, sequence: 2, type: "FORCED_BET_POSTED", actorId: null, publicPayload: { playerId: "villain", kind: "BIG_BLIND", amount: 10, live: true } },
      { ...base, sequence: 3, type: "BETTING_ROUND_STARTED", actorId: null, publicPayload: { street: "PREFLOP", actorId: "hero", currentBet: 10 } },
      { ...base, sequence: 4, type: "ACTION_APPLIED", actorId: "hero", publicPayload: { street: "PREFLOP", command: { action: "call" }, paid: 5, amountTo: 10 } },
    ];
    const context = buildModelContext({
      tournamentId: base.tournamentId,
      rulesetVersion: "arena-rules-v2",
      promptVersion: ARENA_PROMPT_VERSION,
      state,
      playerId: "villain",
      currentHandEvents,
      historyBudget: new HistoryBudget({ maxQueries: 2, maxRecordsPerQuery: 80, maxApproxTokens: 4_000 }).state,
    }) as {
      schema_version: string;
      tournament: Record<string, unknown>;
      pot: Record<string, unknown>;
      betting: Record<string, unknown>;
      action_history: Record<string, unknown>[];
      current_hand_events?: unknown;
      history_budget?: unknown;
    };
    expect(context.schema_version).toBe("model-context-v3");
    expect(context.tournament).toMatchObject({
      objective: "CHAMPION_ONLY",
      runout_policy: "SINGLE_BOARD",
      players_remaining: 2,
      total_chips: 2_000,
      blind_level_number: 1,
      hands_until_next_level: 10,
      next_blind_level: { level_number: 2, small_blind: 10, big_blind: 20, big_blind_ante: 0 },
    });
    expect(context.pot).toMatchObject({
      total_before_action: 20,
      total_after_call: null,
      effective_stack_by_opponent: { hero: 990 },
      provisional_layers_if_closed_now: [{ index: 0, amount: 20, eligible_player_ids: ["hero", "villain"] }],
    });
    expect(context.betting).toMatchObject({ last_aggressor_id: null });
    expect(context.action_history.at(-1)).toMatchObject({
      type: "action",
      player_id: "hero",
      action: "call",
      paid: 5,
      amount_to: 10,
      pot_after: 20,
      stack_after: 990,
    });
    expect(context.current_hand_events).toBeUndefined();
    expect(context.history_budget).toBeUndefined();
    expect(JSON.stringify(context)).not.toContain("eventHash");
    expect(JSON.stringify(context)).not.toContain("createdAt");
    expect(createHash("sha256").update(JSON.stringify(context), "utf8").digest("hex"))
      .toBe("ad9ce0feff35a7ccad1be732965880cbcfc56fdabb88d5d92b052e09a0f762c7");
  });

  it("preserves the frozen v1 context contract for an in-progress legacy tournament", () => {
    let state = createTournament({
      seatCount: 3,
      players: [{ id: "hero", seat: 0 }, { id: "middle", seat: 1 }, { id: "villain", seat: 2 }],
      initialStack: 1_000,
      initialButton: 0,
      handsPerLevel: 10,
      blindLevels: [{ smallBlind: 5, bigBlind: 10, bigBlindAnte: 0 }],
    });
    state = startTournamentHand(state, createDeck()).state;
    const context = buildModelContext({
      tournamentId: "11111111-1111-4111-8111-111111111111",
      rulesetVersion: "arena-rules-v1",
      promptVersion: "arena-system-v1",
      state,
      playerId: "hero",
      currentHandEvents: [],
      historyBudget: new HistoryBudget({ maxQueries: 2, maxRecordsPerQuery: 80, maxApproxTokens: 4_000 }).state,
    }) as { schema_version: string; positions: unknown };
    expect(context).toMatchObject({
      schema_version: "model-context-v1",
      positions: state.currentHand!.positions,
    });
  });

  it("labels multiway positions around an empty dead button", () => {
    let state = createTournament({
      seatCount: 6,
      players: [
        { id: "cutoff", seat: 0 },
        { id: "small", seat: 2 },
        { id: "big", seat: 3 },
        { id: "hijack", seat: 5 },
      ],
      initialStack: 1_000,
      initialButton: 1,
      handsPerLevel: 10,
      blindLevels: [{ smallBlind: 5, bigBlind: 10, bigBlindAnte: 0 }],
    });
    state = startTournamentHand(state, createDeck()).state;
    const context = buildModelContext({
      tournamentId: "11111111-1111-4111-8111-111111111111",
      rulesetVersion: "arena-rules-v1",
      promptVersion: ARENA_PROMPT_VERSION,
      state,
      playerId: "hijack",
      currentHandEvents: [],
      historyBudget: new HistoryBudget({ maxQueries: 2, maxRecordsPerQuery: 80, maxApproxTokens: 4_000 }).state,
    }) as { positions: {
      dead_button: boolean;
      hero_position: string;
      by_player: { player_id: string; position: string; preflop_order_index: number; postflop_order_index: number }[];
      preflop_action_order: string[];
      postflop_action_order: string[];
    } };
    expect(context.positions).toMatchObject({
      dead_button: true,
      hero_position: "HJ",
      preflop_action_order: ["hijack", "cutoff", "small", "big"],
      postflop_action_order: ["small", "big", "hijack", "cutoff"],
    });
    expect(context.positions.by_player).toEqual(expect.arrayContaining([
      expect.objectContaining({ player_id: "hijack", position: "HJ", preflop_order_index: 1, postflop_order_index: 3 }),
      expect.objectContaining({ player_id: "cutoff", position: "CO", preflop_order_index: 2, postflop_order_index: 4 }),
      expect.objectContaining({ player_id: "small", position: "SB" }),
      expect.objectContaining({ player_id: "big", position: "BB" }),
    ]));
  });

  it("produces complete position labels and action orders for every 2-9 seat combination", () => {
    const budget = new HistoryBudget({ maxQueries: 2, maxRecordsPerQuery: 80, maxApproxTokens: 4_000 }).state;
    for (let seatCount = 2; seatCount <= 9; seatCount += 1) {
      const seats = Array.from({ length: seatCount }, (_, seat) => seat);
      for (const activeSeats of seatSubsets(seats)) {
        for (const button of seats) {
          if (activeSeats.length === 2 && !activeSeats.includes(button)) continue;
          let state = createTournament({
            seatCount,
            players: activeSeats.map((seat) => ({ id: `p${seat}`, seat })),
            initialStack: 1_000,
            initialButton: button,
            handsPerLevel: 10,
            blindLevels: [{ smallBlind: 5, bigBlind: 10, bigBlindAnte: 0 }],
          });
          state = startTournamentHand(state, createDeck()).state;
          const context = buildModelContext({
            tournamentId: "11111111-1111-4111-8111-111111111111",
            rulesetVersion: "arena-rules-v1",
            promptVersion: ARENA_PROMPT_VERSION,
            state,
            playerId: `p${activeSeats[0]}`,
            currentHandEvents: [],
            historyBudget: budget,
          }) as { positions: {
            hero_position: string;
            by_player: { player_id: string; position: string; preflop_order_index: number; postflop_order_index: number }[];
            preflop_action_order: string[];
            postflop_action_order: string[];
          } };
          const expectedIds = activeSeats.map((seat) => `p${seat}`).sort();
          expect(context.positions.hero_position).not.toBe("UNKNOWN");
          expect(context.positions.by_player.map((player) => player.player_id).sort()).toEqual(expectedIds);
          expect(context.positions.by_player.every((player) => player.position !== "UNKNOWN")).toBe(true);
          expect([...context.positions.preflop_action_order].sort()).toEqual(expectedIds);
          expect([...context.positions.postflop_action_order].sort()).toEqual(expectedIds);
          expect(context.positions.by_player.map((player) => player.preflop_order_index).sort((a, b) => a - b))
            .toEqual(activeSeats.map((_, index) => index + 1));
          expect(context.positions.by_player.map((player) => player.postflop_order_index).sort((a, b) => a - b))
            .toEqual(activeSeats.map((_, index) => index + 1));
        }
      }
    }
  }, 30_000);
});
