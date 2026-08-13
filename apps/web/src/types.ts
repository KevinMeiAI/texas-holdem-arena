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
  protocolBundleId?: string;
  benchmarkTrackId?: string;
  benchmarkCohortId?: string;
  systemPromptVersionId?: string | null;
  benchmarkSeriesId?: string | null;
  benchmarkRotation?: number | null;
  promptHash: string;
  status: "READY" | "RUNNING" | "PAUSED_INFRA" | "COMPLETED" | "CANCELLED";
  completedHands: number;
  decisionTimeoutMs?: number;
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
  adapter_version?: string | null;
  rendered_user_text_hash?: string | null;
  redacted_wire_body_hash?: string | null;
  applied_output_mode?: string | null;
  applied_schema_hash?: string | null;
  finish_reason?: string | null;
  refusal?: string | null;
  response_model?: string | null;
  system_fingerprint?: string | null;
  created_at: string;
}

export interface TournamentSummary {
  id: string;
  name: string;
  status: ArenaState["status"];
  rulesetVersion: string;
  promptHash: string | null;
  protocolBundleId?: string;
  systemPromptVersionId?: string | null;
  benchmarkTrackId?: string;
  benchmarkCohortId?: string;
  benchmarkSeriesId?: string | null;
  benchmarkRotation?: number | null;
  championPlayerId: string | null;
  publicState: ArenaState;
  createdAt: string;
  updatedAt: string;
}

export interface BenchmarkSeriesSummary {
  id: string;
  name: string;
  status: "READY" | "RUNNING" | "COMPLETED" | "CANCELLED";
  protocolBundleId: string;
  rulesetVersion: string;
  benchmarkTrackId: string;
  benchmarkCohortId: string;
  competitorLabels: Record<string, string>;
  dealScheduleId: string;
  dealScheduleVersion: string;
  dealScheduleCommitment: string;
  rotationPolicyVersion: string;
  rotationCount: number;
  nextRotation: number;
  revealedDealScheduleSeed: string | null;
  systemPromptVersionId: string | null;
  tournaments: { id: string; rotation: number; status: ArenaState["status"]; createdAt: string }[];
  createdAt: string;
  updatedAt: string;
}

export interface SystemPromptVersion {
  id: string;
  name: string;
  runtimeVersion: string;
  protocolBundleId: string;
  systemPrompt: string;
  sha256: string;
  source: "BUNDLED" | "CUSTOM" | "HISTORICAL";
  status: "ACTIVE" | "ARCHIVED";
  isDefault: boolean;
  tournamentCount: number;
  seriesCount: number;
  createdByAdminUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LeaderboardEntry {
  modelId: string;
  displayName: string;
  rating: number;
  points: number;
  tournaments: number;
  championships: number;
  championshipRate: number;
  topThree: number;
  topThreeRate: number;
  averageFinish: number;
  sampleWarning: boolean;
}

export interface ReliabilityLeaderboardEntry {
  modelId: string;
  displayName: string;
  decisions: number;
  validDecisionRate: number | null;
  firstPassRate: number | null;
  protocolCorrections: number;
  fallbacks: number;
  timeouts: number;
  infrastructurePauses: number;
  sampleWarning: boolean;
}

export interface EfficiencyLeaderboardEntry {
  modelId: string;
  displayName: string;
  decisions: number;
  providerCalls: number;
  averageLatencyMs: number | null;
  p95LatencyMs: number | null;
  totalTokens: number | null;
  tokensPerDecision: number | null;
  tokenUsageCoverage: number;
  sampleWarning: boolean;
}

export interface StyleProfileEntry {
  modelId: string;
  displayName: string;
  handsPlayed: number;
  vpipRate: number;
  pfrRate: number;
  threeBetRate: number;
  showdownWinRate: number | null;
  profile: "紧凶" | "紧稳" | "均衡" | "松凶" | "松稳";
  sampleWarning: boolean;
}

export interface LeaderboardResponse {
  leaderboard: LeaderboardEntry[];
  competition: LeaderboardEntry[];
  reliability: ReliabilityLeaderboardEntry[];
  efficiency: EfficiencyLeaderboardEntry[];
  styles: StyleProfileEntry[];
  methodology: {
    competition: string;
    rating: string;
    points: string;
    separation: string;
  };
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
  revisionId: string;
  revisionNumber: number;
  configurationHash: string;
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

export interface TournamentPlayerStatistics {
  playerId: string;
  displayName: string;
  seat: number;
  finishingPosition: number | null;
  knockouts: number;
  handsPlayed: number;
  potsWon: number;
  chipLeadHands: number;
  chipLeadRate: number;
  peakStack: number;
  peakStackBigBlinds: number;
  lowestPositiveStackBigBlinds: number | null;
  netBigBlinds: number;
  vpipHands: number;
  vpipRate: number;
  pfrHands: number;
  pfrRate: number;
  threeBetHands: number;
  threeBetRate: number;
  showdownHands: number;
  showdownWins: number;
  showdownWinRate: number | null;
  allInHands: number;
  allInWins: number;
  allInWinRate: number | null;
  allInExpectedBigBlinds: number;
  allInActualBigBlinds: number;
  allInLuckBigBlinds: number;
  allInEstimatedHands: number;
  decisions: number;
  validDecisions: number;
  validDecisionRate: number | null;
  firstPassDecisions: number;
  firstPassRate: number | null;
  providerCalls: number;
  infrastructureRetries: number;
  protocolCorrections: number;
  timeouts: number;
  fallbacks: number;
  infrastructurePauses: number;
  averageLatencyMs: number | null;
  p95LatencyMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  tokenUsageCoverage: number;
}

export interface TournamentStatistics {
  tournamentId: string;
  completedHands: number;
  initialStack: number;
  totalChips: number;
  players: TournamentPlayerStatistics[];
  methodology: {
    chipPerformance: string;
    allInEquity: string;
    validDecision: string;
    firstPass: string;
    monetaryCost: string;
  };
}
