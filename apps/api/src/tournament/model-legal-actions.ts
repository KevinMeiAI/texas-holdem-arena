import type { BettingAction, LegalActions } from "../../../../packages/domain/src/betting.js";

export interface ModelLegalActions {
  allowed: BettingAction[];
  call: { amount: number; will_be_all_in: boolean } | null;
  bet: { min_amount_to: number; max_amount_to: number } | null;
  raise: { min_amount_to: number; max_amount_to: number } | null;
  all_in: {
    resulting_street_commitment: number;
    classification: "call" | "bet" | "raise" | "short_raise";
  } | null;
}

const ACTION_ORDER: readonly BettingAction[] = ["fold", "check", "call", "bet", "raise", "all_in"];

export function toModelLegalActions(legal: LegalActions | null): ModelLegalActions | null {
  if (!legal) return null;
  const allowed = ACTION_ORDER.filter((action) => {
    if (action === "all_in") return legal.allIn !== undefined;
    return legal[action] !== false && legal[action] !== undefined;
  });
  return {
    allowed,
    call: legal.call ? { amount: legal.call.amount, will_be_all_in: legal.call.allIn } : null,
    bet: legal.bet ? {
      min_amount_to: legal.bet.minAmountTo,
      max_amount_to: legal.bet.maxAmountTo,
    } : null,
    raise: legal.raise ? {
      min_amount_to: legal.raise.minAmountTo,
      max_amount_to: legal.raise.maxAmountTo,
    } : null,
    all_in: legal.allIn ? {
      resulting_street_commitment: legal.allIn.amountTo,
      classification: legal.allIn.classification,
    } : null,
  };
}
