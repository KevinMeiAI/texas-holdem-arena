import type { DecisionAuditTurn } from "./types";

const POKER_ACTIONS = new Set(["fold", "check", "call", "bet", "raise", "all_in"]);

export function isForkableDecisionTurn(turn: DecisionAuditTurn): boolean {
  const action = turn.response?.parsed?.action;
  return turn.outcome === "SUCCESS" && typeof action === "string" && POKER_ACTIONS.has(action);
}

export function decisionForkHref(tournamentId: string, handNo: number, decisionId: string): string {
  const query = new URLSearchParams({
    tournamentId,
    handNo: String(handNo),
    decisionId,
  });
  return `/admin/hand-forks?${query.toString()}`;
}
