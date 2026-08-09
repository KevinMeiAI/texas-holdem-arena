export type RunoutVoteSource = "model" | "timeout" | "invalid_fallback";

export interface RunoutVote {
  playerId: string;
  acceptRunItTwice: boolean;
  message: string;
  source: RunoutVoteSource;
}

export interface RunoutVoteState {
  order: string[];
  votes: RunoutVote[];
  currentVoterId: string | null;
  complete: boolean;
  runCount: 1 | 2 | null;
}

export interface RunoutVoteCommand {
  acceptRunItTwice: boolean;
  message?: string;
  source?: RunoutVoteSource;
}

export function createRunoutVote(order: readonly string[]): RunoutVoteState {
  if (order.length < 2 || new Set(order).size !== order.length) {
    throw new Error("Runout voting requires at least two unique players");
  }
  return {
    order: [...order],
    votes: [],
    currentVoterId: order[0] ?? null,
    complete: false,
    runCount: null,
  };
}

export function castRunoutVote(
  state: RunoutVoteState,
  playerId: string,
  command: RunoutVoteCommand,
): RunoutVoteState {
  if (state.complete || state.currentVoterId !== playerId) {
    throw new Error("Player is not the current runout voter");
  }
  const message = command.message ?? "";
  if (Array.from(message).length > 160) {
    throw new Error("Runout vote message cannot exceed 160 Unicode characters");
  }
  const votes = [...state.votes, {
    playerId,
    acceptRunItTwice: command.acceptRunItTwice,
    message,
    source: command.source ?? "model",
  }];
  const nextVoterId = state.order[votes.length] ?? null;
  const complete = nextVoterId === null;
  return {
    ...state,
    votes,
    currentVoterId: nextVoterId,
    complete,
    runCount: complete
      ? (votes.every((vote) => vote.acceptRunItTwice) ? 2 : 1)
      : null,
  };
}
