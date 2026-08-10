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

export interface DecisionAuditTurn {
  decision_id: string;
  player_id: string;
  turn_index: number;
  request_hash: string;
  request: Record<string, unknown>;
  response_hash: string | null;
  response: { rawText?: string; parsed?: Record<string, unknown>; providerRequestId?: string | null } | null;
  outcome: "SUCCESS" | "PROTOCOL_ERROR" | "INFRA_ERROR";
  error_kind: string | null;
  provider_config_hash: string;
  output_schema_version: string;
  output_schema_hash: string;
  latency_ms: number | null;
  usage: Record<string, unknown> | null;
  created_at: string;
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
  providerProfile: string;
  defaultOutputMode: string;
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
  providerProfile: string;
  providerDefaultOutputMode: string;
  modelId: string;
  parameters: Record<string, unknown>;
  outputMode: string;
  effectiveOutputMode: string;
  effectiveProviderProfile: string;
  outputModeSupported: boolean;
  outputModeMessage: string | null;
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

export interface StackHistoryPoint {
  handNo: number;
  stacks: Record<string, number>;
}
