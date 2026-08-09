import type { LoadedArenaEvent } from "../../../../packages/contracts/src/events.js";
import type { PgEventStore } from "./event-store.js";

export interface RecoveryResult<State> {
  state: State;
  aggregateVersion: number;
  eventSequence: number;
  replayedEvents: number;
  eventHash: string;
}

export async function recoverAggregate<State>(
  store: PgEventStore,
  tournamentId: string,
  initialState: () => State,
  applyEvent: (state: State, event: LoadedArenaEvent) => State,
): Promise<RecoveryResult<State>> {
  const verification = await store.verifyTournamentChain(tournamentId);
  if (!verification.valid) {
    throw new Error(
      `Cannot recover tournament with invalid event chain at sequence ${verification.errorSequence ?? "unknown"}`,
    );
  }
  const snapshot = await store.loadLatestSnapshot(tournamentId);
  let state = snapshot ? snapshot.privateState as State : initialState();
  const afterSequence = snapshot?.eventSequence ?? 0;
  const remaining = await store.loadEvents(tournamentId, {
    afterSequence,
    includePrivate: true,
  });
  for (const event of remaining) state = applyEvent(state, event);
  const last = remaining.at(-1)?.event;
  return {
    state,
    aggregateVersion: last?.aggregateVersion ?? snapshot?.aggregateVersion ?? 0,
    eventSequence: last?.sequence ?? snapshot?.eventSequence ?? 0,
    replayedEvents: remaining.length,
    eventHash: verification.finalHash,
  };
}
