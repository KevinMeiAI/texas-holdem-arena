import { ModelProtocolError, type ActionResponse } from "../../../../packages/contracts/src/model-protocol.js";
import type { ActionCommand } from "../../../../packages/domain/src/betting.js";
import { currentLegalActions, type HandState } from "../../../../packages/domain/src/reducer.js";

export class ModelProtocolViolation extends ModelProtocolError {
  constructor(code: ConstructorParameters<typeof ModelProtocolError>[0], message: string) {
    super(code, message);
    this.name = "ModelProtocolViolation";
  }
}

export function toDomainAction(hand: HandState, response: ActionResponse): ActionCommand {
  const legal = currentLegalActions(hand);
  if (!legal) throw new ModelProtocolViolation("ACTION_NOT_ALLOWED", "Hand is not accepting a poker action");
  const action = response.action;
  if (action === "fold" || action === "check" || action === "call" || action === "all_in") {
    if ((action === "fold" && !legal.fold)
      || (action === "check" && !legal.check)
      || (action === "call" && !legal.call)
      || (action === "all_in" && !legal.allIn)) {
      throw new ModelProtocolViolation("ACTION_NOT_ALLOWED", `${action} is not in the legal action set`);
    }
    return { action };
  }
  const bounds = action === "bet" ? legal.bet : legal.raise;
  if (!bounds || response.amount_to === undefined
    || response.amount_to < bounds.minAmountTo
    || response.amount_to > bounds.maxAmountTo) {
    throw new ModelProtocolViolation("AMOUNT_TO_OUT_OF_RANGE", `${action} amount_to is outside the legal range`);
  }
  return { action, amountTo: response.amount_to };
}

export function protocolFallbackAction(hand: HandState): ActionCommand {
  const legal = currentLegalActions(hand);
  if (!legal) throw new Error("Hand is not accepting a fallback action");
  if (legal.check) return { action: "check" };
  if (legal.fold) return { action: "fold" };
  throw new Error("Fallback policy found neither check nor fold");
}
