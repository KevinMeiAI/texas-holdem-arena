export interface ArenaPlayer {
  id: string;
  displayName: string;
  seat: number;
  stack: number;
  status: string;
  finishingPosition: number | null;
  folded: boolean;
  allIn: boolean;
  streetCommitted: number;
  totalCommitted: number;
}

export interface ArenaHand {
  handNo: number;
  phase: string;
  positions: { button: number; smallBlind: number; bigBlind: number; headsUp: boolean };
  blinds: { smallBlind: number; bigBlind: number; bigBlindAnte: number };
  boards: string[][];
  pots: { index: number; amount: number; eligible: string[] }[];
  awards: { potIndex: number; boardIndex: number; playerId: string; amount: number }[];
  currentActorId: string | null;
  currentVoterId: string | null;
}

export interface ArenaState {
  tournamentId: string;
  name: string;
  rulesetVersion: string;
  promptHash: string;
  status: "READY" | "RUNNING" | "PAUSED_INFRA" | "COMPLETED" | "CANCELLED";
  completedHands: number;
  championPlayerId: string | null;
  seedCommitment: string;
  seedRevealed: boolean;
  masterSeedBase64?: string;
  players: ArenaPlayer[];
  hand: ArenaHand | null;
}

export interface ArenaEvent {
  tournamentId: string;
  sequence: number;
  aggregateVersion: number;
  type: string;
  actorId: string | null;
  handNo: number | null;
  publicPayload: Record<string, unknown>;
  privatePayload?: Record<string, unknown>;
  eventHash: string;
  createdAt: string;
}

export interface TournamentSummary {
  id: string;
  name: string;
  status: ArenaState["status"];
  rulesetVersion: string;
  promptHash: string | null;
  championPlayerId: string | null;
  publicState: ArenaState;
  createdAt: string;
  updatedAt: string;
}

export interface LeaderboardEntry {
  modelId: string;
  displayName: string;
  tournaments: number;
  championships: number;
  championshipRate: number;
  averageFinish: number;
  sampleWarning: boolean;
}

export interface ProviderConnection {
  id: string;
  label: string;
  providerType: string;
  baseUrl: string | null;
  hasApiKey: boolean;
  keyLastFour: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ModelConfig {
  id: string;
  displayName: string;
  providerConnectionId: string;
  providerLabel: string;
  providerType: string;
  modelId: string;
  parameters: Record<string, unknown>;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AdminSession {
  adminUserId: string;
  email: string;
  expiresAt: string;
}

export interface HandSummary {
  handNo: number;
  eventCount: number;
  completed: boolean;
}
