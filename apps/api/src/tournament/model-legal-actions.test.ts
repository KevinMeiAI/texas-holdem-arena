import { describe, expect, it } from "vitest";
import { legalActions, type BettingRound } from "../../../../packages/domain/src/betting.js";
import { toModelLegalActions } from "./model-legal-actions.js";

function round(overrides: Partial<BettingRound> = {}): BettingRound {
  return {
    street: "FLOP",
    bigBlind: 100,
    currentBet: 200,
    lastFullRaiseSize: 200,
    players: [
      { id: "hero", seat: 0, stack: 1_000, committed: 0, folded: false, allIn: false, actedSinceFullRaise: false },
      { id: "villain", seat: 1, stack: 1_000, committed: 200, folded: false, allIn: false, actedSinceFullRaise: true },
    ],
    currentActorId: "hero",
    lastAggressorId: "villain",
    complete: false,
    uncontestedWinnerId: undefined,
    ...overrides,
  };
}

describe("model legal-action projection", () => {
  it("uses one snake_case allowed list and never exposes false actions", () => {
    expect(toModelLegalActions(legalActions(round()))).toEqual({
      allowed: ["fold", "call", "raise", "all_in"],
      call: { amount: 200, will_be_all_in: false },
      bet: null,
      raise: { min_amount_to: 400, max_amount_to: 1_000 },
      all_in: { resulting_street_commitment: 1_000, classification: "raise" },
    });
  });

  it("projects check and bet without camelCase domain keys", () => {
    const projected = toModelLegalActions(legalActions(round({ currentBet: 0 })));
    expect(projected).toMatchObject({ allowed: ["check", "bet", "all_in"], call: null, raise: null });
    expect(JSON.stringify(projected)).not.toMatch(/allIn|minAmountTo|maxAmountTo|"fold":false/);
  });
});
