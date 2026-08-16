import type { ProviderBrand } from "./provider-brand";

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

export interface ArenaBroadcastLastAction {
  sequence: number;
  street: string;
  action: string;
  classification: string;
  paid: number;
  amountTo: number;
  term: string | null;
}

export interface ArenaBroadcastPlayer {
  playerId: string;
  seat: number;
  holeCards: string[];
  stack: number;
  folded: boolean;
  allIn: boolean;
  streetCommitted: number;
  equity: number | null;
  outrightWinProbability: number | null;
  tieProbability: number | null;
  lastAction: ArenaBroadcastLastAction | null;
}

export interface ArenaBroadcast {
  version: string;
  equityVersion: string;
  handNo: number;
  sequence: number;
  street: string;
  board: string[];
  pot: number;
  pots: { index: number; amount: number; eligible: string[] }[];
  positions: { button: number; smallBlind: number; bigBlind: number; headsUp: boolean } | null;
  blinds: { smallBlind: number; bigBlind: number; bigBlindAnte: number } | null;
  currentActorId: string | null;
  estimated: boolean;
  samples: number;
  players: ArenaBroadcastPlayer[];
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
  providerBrand: ProviderBrand | null;
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
  providerBrand: ProviderBrand | null;
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
  providerBrand: ProviderBrand | null;
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
  providerBrand: ProviderBrand | null;
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
  providerBaseUrl: string | null;
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

export type ConsistencyTier = "single" | "quick" | "standard" | "full";
export type ConsistencyRunStatus = "QUEUED" | "RUNNING" | "COMPLETED" | "CANCELLED" | "FAILED";
export type ConsistencyBatchStatus = ConsistencyRunStatus | "PARTIAL";
export type ConsistencySampleOutcome = "VALID_ACTION" | "INVALID_DECISION" | "PROTOCOL_ERROR" | "INFRA_ERROR";

export interface ConsistencyScenario {
  id: string;
  version: number;
  registryVersion: string;
  title: { zh: string; en: string };
  summary: { zh: string; en: string };
  role: "ANCHOR" | "MIXED" | "PRESSURE";
  tags: {
    street: "PREFLOP" | "FLOP" | "TURN" | "RIVER";
    tableSize: number;
    contenders: number;
    potType: "UNOPENED" | "OPEN_RAISED" | "HEADS_UP" | "MULTIWAY" | "SIDE_POT";
    position: "EARLY" | "IN_POSITION" | "OUT_OF_POSITION" | "SANDWICH";
    stackDepth: "SHORT" | "MEDIUM" | "DEEP";
    handClass: string;
    boardTexture: string;
    pressure: string;
  };
  preview: {
    heroPosition: string;
    heroStack: number;
    heroStackBb: number;
    holeCards: string[];
    board: string[];
    potBeforeAction: number;
    legalActions: string[];
    actionHistory: Record<string, unknown>[];
  };
  arenaState: Record<string, unknown>;
}

export interface ConsistencyScenarioRegistry {
  version: string;
  scenarios: ConsistencyScenario[];
  presets: Record<"quick" | "standard" | "full", string[]>;
}

export interface ConsistencySample {
  id: string;
  scenarioId: string;
  sampleIndex: number;
  outcome: ConsistencySampleOutcome;
  action: string | null;
  amountTo: number | null;
  decisionSummary: string | null;
  parsedOutput: Record<string, unknown> | null;
  rawText: string | null;
  errorKind: string | null;
  errorMessage: string | null;
  latencyMs: number;
  usage: { inputTokens?: number | null; outputTokens?: number | null; totalTokens?: number | null } | null;
  transportAudit: Record<string, unknown> | null;
  visibleInputHash: string;
  createdAt: string;
}

export interface ScenarioConsistencySummary {
  scenarioId: string;
  completedSamples: number;
  validActions: number;
  validityRate: number | null;
  dominantAction: string | null;
  dominantCount: number;
  dominantShare: number | null;
  pairwiseAgreement: number | null;
  actionDistribution: Record<string, number>;
  sizing: Record<string, { count: number; median: number; min: number; max: number; values: number[] }>;
  outcomes: Record<ConsistencySampleOutcome, number>;
  averageLatencyMs: number | null;
  p95LatencyMs: number | null;
  uniqueInputHashes: string[];
}

export interface ConsistencySummary {
  completedSamples: number;
  validActions: number;
  validityRate: number | null;
  meanDominantShare: number | null;
  meanPairwiseAgreement: number | null;
  outcomes: Record<ConsistencySampleOutcome, number>;
  averageLatencyMs: number | null;
  p95LatencyMs: number | null;
  totalTokens: number | null;
  scenarios: ScenarioConsistencySummary[];
  dimensions: Record<string, Record<string, {
    scenarios: number;
    meanDominantShare: number | null;
    meanPairwiseAgreement: number | null;
    validityRate: number | null;
  }>>;
}

export interface ConsistencyRun {
  id: string;
  batchId: string | null;
  modelConfigId: string;
  competitorRevisionId: string;
  modelDisplayName: string;
  modelId: string;
  systemPromptVersionId: string;
  promptName: string;
  status: ConsistencyRunStatus;
  tier: ConsistencyTier;
  scenarioRegistryVersion: string;
  scenarioIds: string[];
  sampleCount: number;
  totalSamples: number;
  completedSamples: number;
  protocolBundleId: string;
  modelConfigurationHash: string;
  systemPromptHash: string;
  outputSchemaHash: string;
  effectiveOutputMode: string;
  timeoutMs: number;
  executionMode: "serial";
  summary: ConsistencySummary | null;
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  scenarios?: ConsistencyScenario[];
  samples?: ConsistencySample[];
}

export interface ConsistencyBatch {
  id: string;
  systemPromptVersionId: string;
  promptName: string;
  status: ConsistencyBatchStatus;
  tier: ConsistencyTier;
  scenarioRegistryVersion: string;
  scenarioIds: string[];
  modelConfigIds: string[];
  sampleCount: number;
  timeoutMs: number;
  maxParallelModels: number;
  protocolBundleId: string;
  systemPromptHash: string;
  outputSchemaHash: string;
  totalModels: number;
  totalSamples: number;
  completedSamples: number;
  createdAt: string;
  runs: ConsistencyRun[];
  scenarios?: ConsistencyScenario[];
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
