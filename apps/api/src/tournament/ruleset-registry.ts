import type { Card } from "../../../../packages/domain/src/cards.js";
import type { HandCommand } from "../../../../packages/domain/src/reducer.js";
import {
  createTournament,
  reduceTournament,
  startTournamentHand,
  type TournamentConfig,
  type TournamentState,
  type TournamentTransition,
} from "../../../../packages/domain/src/tournament.js";

export interface RulesetImplementation {
  version: string;
  createTournament(config: TournamentConfig): TournamentState;
  startHand(state: TournamentState, deck: readonly Card[]): TournamentTransition;
  reduce(state: TournamentState, command: HandCommand): TournamentTransition;
}

function frozenRuleset(version: string): RulesetImplementation {
  return Object.freeze({
    version,
    createTournament,
    startHand: startTournamentHand,
    reduce: reduceTournament,
  });
}

const RULESETS = new Map<string, RulesetImplementation>([
  ["arena-rules-v1", frozenRuleset("arena-rules-v1")],
  ["arena-rules-v2", frozenRuleset("arena-rules-v2")],
]);

export const CURRENT_RULESET_VERSION = "arena-rules-v2";

export function rulesetImplementation(version: string): RulesetImplementation {
  const ruleset = RULESETS.get(version);
  if (!ruleset) throw new Error(`Unsupported Arena ruleset implementation: ${version}`);
  return ruleset;
}
