import { randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { projectArenaEvent, type ProjectionRole } from "../../../../packages/contracts/src/visibility.js";
import { deriveSeed, DeterministicRng } from "../../../../packages/fairness/src/rng.js";
import { createProvider } from "../../../../packages/providers/src/provider-factory.js";
import type { FrozenModelConfig, ModelProvider } from "../../../../packages/providers/src/provider.js";
import { inspectOutputPolicy } from "../../../../packages/providers/src/output-policy.js";
import { ModelConfigService } from "../admin/model-service.js";
import { SystemPromptVersionService } from "../admin/system-prompt-service.js";
import { PgEventStore } from "../persistence/event-store.js";
import {
  TournamentOrchestrator,
  type OperationalStatus,
  type OrchestratorRuntime,
} from "./orchestrator.js";
import {
  buildArenaLeaderboards,
  calculateTournamentStatistics,
  type ArenaLeaderboards,
  type StatisticsTournamentState,
  type TournamentStatistics,
  type TournamentStatisticsComputation,
} from "./statistics.js";
import { benchmarkTrackIdentity, type BenchmarkTrackIdentity } from "./benchmark-track.js";
import { CURRENT_RULESET_VERSION } from "./ruleset-registry.js";
import {
  createDealSchedule,
  DEAL_SCHEDULE_VERSION,
  rotateSeats,
  SEAT_ROTATION_POLICY_VERSION,
  verifyDealSchedule,
  type DealSchedule,
} from "../../../../packages/fairness/src/deal-schedule.js";
import { decryptJson, encryptJson } from "../security/encryption.js";

export interface CreateArenaTournamentInput {
  name: string;
  modelConfigIds: string[];
  initialStack: number;
  handsPerLevel: number;
  decisionTimeoutMs: number;
  blindLevels: { smallBlind: number; bigBlind: number; bigBlindAnte: number }[];
  interfaceTrack?: "native" | "normalized" | undefined;
  historyMode?: "query_only" | "disabled" | undefined;
  systemPromptVersionId?: string | undefined;
}

export interface CreateBenchmarkSeriesInput extends CreateArenaTournamentInput {
  rotations?: number | undefined;
}

interface BenchmarkSeriesRow {
  id: string;
  name: string;
  status: "READY" | "RUNNING" | "COMPLETED" | "CANCELLED";
  competitor_revision_ids: string[];
  competitor_labels: Record<string, string>;
  tournament_configuration: CreateArenaTournamentInput;
  protocol_bundle_id: string;
  ruleset_version: string;
  benchmark_track: BenchmarkTrackIdentity;
  deal_schedule_id: string;
  deal_schedule_version: string;
  deal_schedule_commitment: string;
  encrypted_deal_schedule: unknown;
  rotation_policy_version: string;
  rotation_count: number;
  next_rotation: number;
  revealed_deal_schedule_seed: string | null;
  system_prompt_version_id: string | null;
}

interface SeriesTournamentRow {
  id: string;
  status: OperationalStatus | "DRAFT" | "PREFLIGHT";
  benchmark_rotation: number;
  aggregate_version: string;
}

interface ActiveArena {
  orchestrator: TournamentOrchestrator;
  runtime: OrchestratorRuntime;
  desiredStatus: "RUNNING" | "PAUSED" | "CANCELLED";
  driving: boolean;
  drivePromise: Promise<void> | null;
  lastError: string | null;
}

const delay = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

function providerOutputModes(configs: readonly FrozenModelConfig[]): string[] {
  return [...new Set(configs.map((config) => inspectOutputPolicy(config).effectiveMode))].sort();
}

function trackModelConfig(
  config: FrozenModelConfig,
  interfaceTrack: "native" | "normalized",
): FrozenModelConfig {
  return interfaceTrack === "normalized" ? { ...config, outputMode: "prompt" } : config;
}

function decisionConfig(historyMode: "query_only" | "disabled") {
  return {
    maxInfrastructureAttempts: 3,
    infrastructureRetryDelaysMs: [2_000, 8_000],
    history: historyMode === "disabled"
      ? { maxQueries: 0, maxRecordsPerQuery: 80, maxApproxTokens: 0 }
      : { maxQueries: 2, maxRecordsPerQuery: 80, maxApproxTokens: 4_000 },
  };
}

function desiredStatusAfterAwait(record: ActiveArena): ActiveArena["desiredStatus"] {
  // Admin commands can change this value while a provider request is in flight.
  return record.desiredStatus;
}

export class ArenaService {
  readonly #records = new Map<string, ActiveArena>();
  readonly #statisticsCache = new Map<string, TournamentStatisticsComputation>();
  readonly #statisticsPending = new Map<string, Promise<TournamentStatisticsComputation>>();
  readonly #store: PgEventStore;
  readonly #systemPrompts: SystemPromptVersionService;
  #stopping = false;

  constructor(
    private readonly pool: Pool,
    private readonly masterKey: Uint8Array,
    private readonly models: ModelConfigService,
    private readonly displayDelayMs = 120,
  ) {
    this.#store = new PgEventStore(pool, masterKey);
    this.#systemPrompts = new SystemPromptVersionService(pool, masterKey);
  }

  async restoreActive(): Promise<void> {
    const result = await this.pool.query<{
      id: string;
      status: string;
    }>(
      `select id, status from tournaments
        where status in ('READY', 'RUNNING', 'PAUSED_INFRA')
          and configuration @> '{"managedByArena":true}'::jsonb`,
    );
    for (const row of result.rows) {
      const snapshot = await this.#store.loadLatestSnapshot(row.id);
      if (!snapshot) throw new Error(`Active tournament has no recovery snapshot: ${row.id}`);
      const snapshotRuntime = snapshot.privateState as OrchestratorRuntime;
      const providers = await this.#providersForRuntime(snapshotRuntime);
      const orchestrator = new TournamentOrchestrator({
        eventStore: this.#store,
        pool: this.pool,
        providers,
      });
      const runtime = await orchestrator.recover(row.id);
      const record: ActiveArena = {
        orchestrator,
        runtime,
        desiredStatus: runtime.operationalStatus === "RUNNING" || runtime.operationalStatus === "READY"
          ? "RUNNING"
          : "PAUSED",
        driving: false,
        drivePromise: null,
        lastError: null,
      };
      this.#records.set(row.id, record);
      if (record.desiredStatus === "RUNNING") this.#startDrive(record);
    }
    const openSeries = await this.pool.query<{ id: string }>(
      "select id from benchmark_series where status in ('READY', 'RUNNING') order by created_at",
    );
    for (const series of openSeries.rows) {
      await this.#startSeriesRotation(series.id);
    }
  }

  async create(input: CreateArenaTournamentInput): Promise<OrchestratorRuntime> {
    return this.#withTableLaunchLock(() => this.#create(input));
  }

  async #create(input: CreateArenaTournamentInput): Promise<OrchestratorRuntime> {
    if (this.#stopping) throw new Error("Arena service is shutting down");
    const activeTournament = await this.pool.query<{ id: string }>(
      "select id from tournaments where status in ('READY', 'RUNNING', 'PAUSED_INFRA') limit 1",
    );
    if (activeTournament.rows[0]) throw new Error("The single Arena table is already occupied");
    const openSeries = await this.pool.query<{ id: string }>(
      "select id from benchmark_series where status in ('READY', 'RUNNING') limit 1",
    );
    if (openSeries.rows[0]) throw new Error("A benchmark series already owns the single Arena table");
    const models = await Promise.all(input.modelConfigIds.map(async (id) => {
      const model = await this.models.currentRevision(id);
      if (!model) throw new Error(`Model configuration not found: ${id}`);
      return model;
    }));
    const interfaceTrack = input.interfaceTrack ?? "native";
    const historyMode = input.historyMode ?? "query_only";
    const selectedPrompt = await this.#systemPrompts.resolve(input.systemPromptVersionId);
    if (selectedPrompt.version.status !== "ACTIVE") throw new Error("Archived system prompt versions cannot start new tournaments");
    const frozenConfigByRevisionId = Object.fromEntries(await Promise.all(models.map(async (model) => (
      [model.revisionId, trackModelConfig({
        ...await this.models.runtimeConfigForRevision(model.revisionId),
        timeoutMs: input.decisionTimeoutMs,
      }, interfaceTrack)] as const
    ))));
    const providers = this.#providersFromFrozen(frozenConfigByRevisionId);
    const masterSeed = randomBytes(32);
    const seatingRng = new DeterministicRng(deriveSeed(masterSeed, "tournament:seating"));
    const seated = seatingRng.shuffle(models);
    const tournamentId = randomUUID();
    const rulesetVersion = CURRENT_RULESET_VERSION;
    const protocolBundleId = selectedPrompt.version.protocolBundleId;
    const track = benchmarkTrackIdentity({
      protocolBundleId,
      rulesetVersion,
      systemPromptHash: selectedPrompt.prompt.sha256,
      historyMode,
      interfaceTrack,
      providerOutputModes: providerOutputModes(Object.values(frozenConfigByRevisionId)),
      tournamentFormat: {
        seatCount: seated.length,
        initialStack: input.initialStack,
        handsPerLevel: input.handsPerLevel,
        blindLevels: input.blindLevels,
        decisionTimeoutMs: input.decisionTimeoutMs,
      },
    });
    const orchestrator = new TournamentOrchestrator({ eventStore: this.#store, pool: this.pool, providers });
    const runtime = await orchestrator.createAndStart({
      tournamentId,
      name: input.name,
      rulesetVersion,
      protocolBundleId,
      benchmarkTrack: track,
      effectiveSystemPrompt: selectedPrompt.prompt,
      systemPromptVersionId: selectedPrompt.version.id,
      tournament: {
        seatCount: seated.length,
        players: seated.map((model, seat) => ({ id: model.revisionId, seat })),
        initialStack: input.initialStack,
        initialButton: seatingRng.int(seated.length),
        handsPerLevel: input.handsPerLevel,
        blindLevels: input.blindLevels,
      },
      providerIdByPlayer: Object.fromEntries(seated.map((model) => [model.revisionId, model.revisionId])),
      frozenModelConfigByPlayer: Object.fromEntries(seated.map((model) => [
        model.revisionId,
        frozenConfigByRevisionId[model.revisionId]!,
      ])),
      playerLabels: Object.fromEntries(seated.map((model) => [model.revisionId, model.displayName])),
      decisionTimeoutMs: input.decisionTimeoutMs,
      decisionConfig: decisionConfig(historyMode),
      masterSeed,
      managedByArena: true,
    });
    const record: ActiveArena = {
      orchestrator,
      runtime,
      desiredStatus: "RUNNING",
      driving: false,
      drivePromise: null,
      lastError: null,
    };
    this.#records.set(tournamentId, record);
    this.#startDrive(record);
    return runtime;
  }

  async createBenchmarkSeries(input: CreateBenchmarkSeriesInput): Promise<{ seriesId: string; tournamentId: string }> {
    return this.#withTableLaunchLock(() => this.#createBenchmarkSeries(input));
  }

  async #createBenchmarkSeries(input: CreateBenchmarkSeriesInput): Promise<{ seriesId: string; tournamentId: string }> {
    if (this.#stopping) throw new Error("Arena service is shutting down");
    const activeTournament = await this.pool.query<{ id: string }>(
      "select id from tournaments where status in ('READY', 'RUNNING', 'PAUSED_INFRA') limit 1",
    );
    if (activeTournament.rows[0]) throw new Error("The single Arena table is already occupied");
    const revisions = await Promise.all(input.modelConfigIds.map(async (id) => {
      const model = await this.models.currentRevision(id);
      if (!model) throw new Error(`Model configuration not found: ${id}`);
      return model;
    }));
    const rotationCount = revisions.length;
    if (input.rotations !== undefined && input.rotations !== rotationCount) {
      throw new Error(`A balanced benchmark series requires exactly ${rotationCount} rotations`);
    }
    const seriesId = randomUUID();
    const interfaceTrack = input.interfaceTrack ?? "native";
    const historyMode = input.historyMode ?? "query_only";
    const selectedPrompt = await this.#systemPrompts.resolve(input.systemPromptVersionId);
    if (selectedPrompt.version.status !== "ACTIVE") throw new Error("Archived system prompt versions cannot start new benchmark series");
    const schedule = createDealSchedule();
    const rulesetVersion = CURRENT_RULESET_VERSION;
    const protocolBundleId = selectedPrompt.version.protocolBundleId;
    const frozenConfigs = await Promise.all(revisions.map(async (model) => trackModelConfig({
      ...await this.models.runtimeConfigForRevision(model.revisionId),
      timeoutMs: input.decisionTimeoutMs,
    }, interfaceTrack)));
    const track = benchmarkTrackIdentity({
      protocolBundleId,
      rulesetVersion,
      systemPromptHash: selectedPrompt.prompt.sha256,
      historyMode,
      interfaceTrack,
      providerOutputModes: providerOutputModes(frozenConfigs),
      tournamentFormat: {
        seatCount: revisions.length,
        initialStack: input.initialStack,
        handsPerLevel: input.handsPerLevel,
        blindLevels: input.blindLevels,
        decisionTimeoutMs: input.decisionTimeoutMs,
        pairedRotations: rotationCount,
      },
    });
    const configuration: CreateArenaTournamentInput = {
      name: input.name,
      modelConfigIds: [...input.modelConfigIds],
      initialStack: input.initialStack,
      handsPerLevel: input.handsPerLevel,
      decisionTimeoutMs: input.decisionTimeoutMs,
      blindLevels: input.blindLevels.map((level) => ({ ...level })),
      interfaceTrack,
      historyMode,
      systemPromptVersionId: selectedPrompt.version.id,
    };
    await this.pool.query(
      `insert into benchmark_series
        (id, name, status, protocol_bundle_id, ruleset_version, benchmark_track_id,
         benchmark_cohort_id, benchmark_track, competitor_revision_ids, competitor_labels,
         tournament_configuration, deal_schedule_id, deal_schedule_version,
         deal_schedule_commitment, encrypted_deal_schedule, rotation_policy_version,
         rotation_count, system_prompt_version_id)
       values ($1, $2, 'READY', $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb,
               $10::jsonb, $11, $12, $13, $14::jsonb, $15, $16, $17)`,
      [
        seriesId,
        input.name,
        protocolBundleId,
        rulesetVersion,
        track.id,
        track.cohortId,
        JSON.stringify(track),
        JSON.stringify(revisions.map((model) => model.revisionId)),
        JSON.stringify(Object.fromEntries(revisions.map((model) => [model.revisionId, model.displayName]))),
        JSON.stringify(configuration),
        schedule.id,
        schedule.version,
        schedule.commitment,
        JSON.stringify(encryptJson(schedule, this.masterKey, `arena:benchmark-series:${seriesId}:deal-schedule`)),
        SEAT_ROTATION_POLICY_VERSION,
        rotationCount,
        selectedPrompt.version.id,
      ],
    );
    try {
      const runtime = await this.#startSeriesRotation(seriesId);
      return { seriesId, tournamentId: runtime.tournamentId };
    } catch (error) {
      await this.#closeBenchmarkSeries(seriesId, "CANCELLED");
      throw error;
    }
  }

  async listBenchmarkSeries(): Promise<unknown[]> {
    const result = await this.pool.query<{
      id: string;
      name: string;
      status: BenchmarkSeriesRow["status"];
      protocol_bundle_id: string;
      ruleset_version: string;
      benchmark_track_id: string;
      benchmark_cohort_id: string;
      competitor_labels: Record<string, string>;
      deal_schedule_id: string;
      deal_schedule_version: string;
      deal_schedule_commitment: string;
      rotation_policy_version: string;
      rotation_count: number;
      next_rotation: number;
      revealed_deal_schedule_seed: string | null;
      system_prompt_version_id: string | null;
      tournaments: { id: string; rotation: number; status: string; createdAt: string }[];
      created_at: Date;
      updated_at: Date;
    }>(
      `select id, name, status, protocol_bundle_id, ruleset_version,
              benchmark_track_id, benchmark_cohort_id, competitor_labels,
              deal_schedule_id,
              deal_schedule_version, deal_schedule_commitment, rotation_policy_version,
              rotation_count, next_rotation, system_prompt_version_id,
              revealed_deal_schedule_seed, created_at, updated_at,
              (select coalesce(jsonb_agg(jsonb_build_object(
                 'id', t.id,
                 'rotation', t.benchmark_rotation,
                 'status', t.status,
                 'createdAt', t.created_at
               ) order by t.benchmark_rotation), '[]'::jsonb)
                 from tournaments t where t.benchmark_series_id = benchmark_series.id) as tournaments
         from benchmark_series order by created_at desc`,
    );
    return result.rows.map((row) => ({
      id: row.id,
      name: row.name,
      status: row.status,
      protocolBundleId: row.protocol_bundle_id,
      rulesetVersion: row.ruleset_version,
      benchmarkTrackId: row.benchmark_track_id,
      benchmarkCohortId: row.benchmark_cohort_id,
      competitorLabels: row.competitor_labels,
      dealScheduleId: row.deal_schedule_id,
      dealScheduleVersion: row.deal_schedule_version,
      dealScheduleCommitment: row.deal_schedule_commitment,
      rotationPolicyVersion: row.rotation_policy_version,
      rotationCount: row.rotation_count,
      nextRotation: row.next_rotation,
      revealedDealScheduleSeed: row.revealed_deal_schedule_seed,
      systemPromptVersionId: row.system_prompt_version_id,
      tournaments: row.tournaments,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    }));
  }

  async pause(tournamentId: string): Promise<void> {
    const record = await this.#record(tournamentId);
    if (record.runtime.operationalStatus !== "RUNNING") {
      throw new Error("Tournament is not running");
    }
    record.desiredStatus = "PAUSED";
    this.#startDrive(record);
  }

  async resume(tournamentId: string): Promise<void> {
    const record = await this.#record(tournamentId);
    if (record.runtime.operationalStatus === "COMPLETED" || record.runtime.operationalStatus === "CANCELLED") {
      throw new Error("Tournament is already terminal");
    }
    record.desiredStatus = "RUNNING";
    record.lastError = null;
    this.#startDrive(record);
  }

  async cancel(tournamentId: string): Promise<void> {
    const record = await this.#record(tournamentId);
    if (record.runtime.operationalStatus === "COMPLETED" || record.runtime.operationalStatus === "CANCELLED") {
      throw new Error("Tournament is already terminal");
    }
    record.desiredStatus = "CANCELLED";
    this.#startDrive(record);
  }

  async shutdown(): Promise<void> {
    this.#stopping = true;
    await Promise.all(
      [...this.#records.values()].map((record) => record.drivePromise).filter(
        (promise): promise is Promise<void> => promise !== null,
      ),
    );
  }

  async publicState(tournamentId?: string): Promise<unknown | null> {
    const result = tournamentId
      ? await this.pool.query<{ public_state: unknown }>(
        "select public_state from tournaments where id = $1",
        [tournamentId],
      )
      : await this.pool.query<{ public_state: unknown }>(
        `select public_state from tournaments
          order by (status in ('READY','RUNNING','PAUSED_INFRA')) desc, created_at desc limit 1`,
      );
    return result.rows[0]?.public_state ?? null;
  }

  async listTournaments(): Promise<unknown[]> {
    const result = await this.pool.query<{
      id: string;
      name: string;
      status: string;
      ruleset_version: string;
      prompt_hash: string | null;
      champion_player_id: string | null;
      public_state: unknown;
      protocol_bundle_id: string;
      benchmark_track_id: string;
      benchmark_cohort_id: string;
      system_prompt_version_id: string | null;
      benchmark_series_id: string | null;
      benchmark_rotation: number | null;
      created_at: Date;
      updated_at: Date;
    }>(
      `select id, name, status, ruleset_version, prompt_hash, champion_player_id,
              protocol_bundle_id, benchmark_track_id, benchmark_cohort_id,
              system_prompt_version_id,
              benchmark_series_id, benchmark_rotation,
              public_state, created_at, updated_at
         from tournaments order by created_at desc`,
    );
    return result.rows.map((row) => ({
      id: row.id,
      name: row.name,
      status: row.status,
      rulesetVersion: row.ruleset_version,
      promptHash: row.prompt_hash,
      protocolBundleId: row.protocol_bundle_id,
      benchmarkTrackId: row.benchmark_track_id,
      benchmarkCohortId: row.benchmark_cohort_id,
      systemPromptVersionId: row.system_prompt_version_id,
      benchmarkSeriesId: row.benchmark_series_id,
      benchmarkRotation: row.benchmark_rotation,
      championPlayerId: row.champion_player_id,
      publicState: row.public_state,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    }));
  }

  async projectedEvents(
    tournamentId: string,
    role: Extract<ProjectionRole, "SPECTATOR_LIVE" | "SPECTATOR_REPLAY">,
    afterSequence = 0,
  ) {
    const loaded = await this.#store.loadEvents(tournamentId, { includePrivate: true });
    const completedHandNos = new Set<number>(
      loaded.filter((item) => item.event.type === "HAND_COMPLETED" && item.event.handNo !== null)
        .map((item) => item.event.handNo!),
    );
    return loaded
      .filter((item) => item.event.sequence > afterSequence)
      .map((item) => projectArenaEvent(item, { role, completedHandNos }));
  }

  async tournamentStatistics(tournamentId: string): Promise<TournamentStatistics | null> {
    const state = await this.publicState(tournamentId);
    if (!state) return null;
    return (await this.#calculateStatistics(tournamentId, state)).statistics;
  }

  async leaderboard(): Promise<ArenaLeaderboards> {
    const result = await this.pool.query<{
      id: string;
      public_state: unknown;
      created_at: Date;
      benchmark_cohort_id: string;
    }>(`select id, public_state, created_at, benchmark_cohort_id
          from tournaments where status = 'COMPLETED' order by created_at`);
    // The public board is always a single comparable cohort. Until the UI
    // exposes a cohort selector, use the cohort of the most recently completed
    // tournament and never merge incompatible historical protocols into it.
    const selectedCohortId = result.rows.at(-1)?.benchmark_cohort_id ?? null;
    const completed = await Promise.all(result.rows.map(async (row) => {
      if (row.benchmark_cohort_id !== selectedCohortId) return null;
      const calculation = await this.#calculateStatistics(row.id, row.public_state, false);
      return {
        createdAt: row.created_at.toISOString(),
        statistics: calculation.statistics,
        internals: calculation.internals,
      };
    }));
    return buildArenaLeaderboards(completed.filter((record): record is NonNullable<typeof record> => record !== null));
  }

  async fairness(tournamentId: string): Promise<unknown> {
    return {
      chain: await this.#store.verifyTournamentChain(tournamentId),
      state: await this.publicState(tournamentId),
    };
  }

  async decisionAudit(tournamentId: string, handNo: number): Promise<unknown[]> {
    return this.#store.loadDecisionAudit(tournamentId, handNo);
  }

  async latestEventSequence(tournamentId: string): Promise<number | null> {
    const result = await this.pool.query<{ sequence: string }>(
      "select (next_event_sequence - 1)::text as sequence from tournaments where id = $1",
      [tournamentId],
    );
    return result.rows[0] ? Number(result.rows[0].sequence) : null;
  }

  async #calculateStatistics(
    tournamentId: string,
    rawState: unknown,
    includeAllInEquity = true,
  ): Promise<TournamentStatisticsComputation> {
    const state = rawState as StatisticsTournamentState & { status?: string };
    if (!state || !Array.isArray(state.players) || typeof state.completedHands !== "number") {
      throw new Error(`Tournament public state is unavailable for statistics: ${tournamentId}`);
    }
    const cached = includeAllInEquity ? this.#statisticsCache.get(tournamentId) : null;
    if (cached && state.status === "COMPLETED") return cached;
    const pending = includeAllInEquity ? this.#statisticsPending.get(tournamentId) : null;
    if (pending && state.status === "COMPLETED") return pending;
    const calculate = async () => {
      const events = await this.projectedEvents(tournamentId, "SPECTATOR_REPLAY");
      const calculation = calculateTournamentStatistics(state, events, { includeAllInEquity });
      if (state.status === "COMPLETED" && includeAllInEquity) this.#statisticsCache.set(tournamentId, calculation);
      return calculation;
    };
    if (state.status !== "COMPLETED" || !includeAllInEquity) return calculate();
    const calculation = calculate();
    this.#statisticsPending.set(tournamentId, calculation);
    try {
      return await calculation;
    } finally {
      this.#statisticsPending.delete(tournamentId);
    }
  }

  async #providers(modelIds: readonly string[]): Promise<Map<string, ModelProvider>> {
    const providers = new Map<string, ModelProvider>();
    for (const id of new Set(modelIds)) {
      providers.set(id, createProvider(await this.models.runtimeConfig(id)));
    }
    return providers;
  }

  #providersFromFrozen(configByProviderId: Readonly<Record<string, FrozenModelConfig>>): Map<string, ModelProvider> {
    return new Map(Object.entries(configByProviderId).map(([providerId, config]) => [
      providerId,
      createProvider(config),
    ]));
  }

  async #providersForRuntime(runtime: OrchestratorRuntime): Promise<Map<string, ModelProvider>> {
    if (runtime.frozenModelConfigByPlayer) {
      const configByProviderId: Record<string, FrozenModelConfig> = {};
      for (const [playerId, providerId] of Object.entries(runtime.providerIdByPlayer)) {
        const config = runtime.frozenModelConfigByPlayer[playerId];
        if (!config) return this.#providers(Object.values(runtime.providerIdByPlayer));
        configByProviderId[providerId] = config;
      }
      return this.#providersFromFrozen(configByProviderId);
    }
    return this.#providers(Object.values(runtime.providerIdByPlayer));
  }

  async #record(tournamentId: string): Promise<ActiveArena> {
    const existing = this.#records.get(tournamentId);
    if (existing) return existing;
    const snapshot = await this.#store.loadLatestSnapshot(tournamentId);
    if (!snapshot) throw new Error("Tournament not found");
    const runtime = snapshot.privateState as OrchestratorRuntime;
    const providers = await this.#providersForRuntime(runtime);
    const orchestrator = new TournamentOrchestrator({ eventStore: this.#store, pool: this.pool, providers });
    const record: ActiveArena = {
      orchestrator,
      runtime: await orchestrator.recover(tournamentId),
      desiredStatus: runtime.operationalStatus === "RUNNING" || runtime.operationalStatus === "READY"
        ? "RUNNING"
        : "PAUSED",
      driving: false,
      drivePromise: null,
      lastError: null,
    };
    this.#records.set(tournamentId, record);
    return record;
  }

  #startDrive(record: ActiveArena): void {
    if (this.#stopping || record.driving) return;
    const promise = this.#drive(record);
    record.drivePromise = promise;
    void promise.finally(() => {
      if (record.drivePromise === promise) record.drivePromise = null;
    });
  }

  async #drive(record: ActiveArena): Promise<void> {
    if (record.driving) return;
    record.driving = true;
    try {
      while (true) {
        if (this.#stopping) return;
        if (record.runtime.operationalStatus === "COMPLETED"
          || record.runtime.operationalStatus === "CANCELLED") return;
        if (record.desiredStatus === "CANCELLED") {
          record.runtime = await record.orchestrator.cancel(record.runtime);
          await this.#cancelBenchmarkSeries(record.runtime);
          return;
        }
        if (record.desiredStatus === "PAUSED") {
          if (record.runtime.operationalStatus === "RUNNING") {
            record.runtime = await record.orchestrator.pause(record.runtime);
          }
          return;
        }
        if (record.runtime.operationalStatus === "READY") {
          record.runtime = await record.orchestrator.startReady(record.runtime);
        }
        if (record.runtime.operationalStatus === "PAUSED_INFRA") {
          record.runtime = await record.orchestrator.resume(record.runtime);
        }
        if (record.runtime.operationalStatus !== "RUNNING") return;
        record.runtime = await record.orchestrator.runNextDecision(record.runtime, "arena-local-worker");
        if (record.runtime.operationalStatus === "PAUSED_INFRA") {
          record.desiredStatus = "PAUSED";
          return;
        }
        if (record.runtime.operationalStatus === "COMPLETED") {
          const terminalIntent = desiredStatusAfterAwait(record);
          if (terminalIntent === "CANCELLED") {
            await this.#cancelBenchmarkSeries(record.runtime);
          } else {
            await this.#advanceBenchmarkSeries(record.runtime, terminalIntent === "PAUSED");
          }
          return;
        }
        await delay(this.displayDelayMs);
      }
    } catch (error) {
      record.lastError = error instanceof Error ? error.message : "Unknown arena driver failure";
      record.desiredStatus = "PAUSED";
    } finally {
      record.driving = false;
      if (!this.#stopping
        && record.desiredStatus === "RUNNING"
        && record.runtime.operationalStatus === "RUNNING"
        && record.lastError === null) {
        this.#startDrive(record);
      }
    }
  }

  async #startSeriesRotation(seriesId: string, pauseBeforeFirstDecision = false): Promise<OrchestratorRuntime> {
    const lockClient = await this.pool.connect();
    try {
      await lockClient.query("select pg_advisory_lock(hashtextextended($1, 0))", [`arena:benchmark-series:${seriesId}`]);
      const result = await lockClient.query<BenchmarkSeriesRow>(
        "select * from benchmark_series where id = $1",
        [seriesId],
      );
      const series = result.rows[0];
      if (!series) throw new Error("Benchmark series not found");
      if (series.status === "COMPLETED" || series.status === "CANCELLED") {
        throw new Error("Benchmark series is already terminal");
      }

      const tournamentResult = await lockClient.query<SeriesTournamentRow>(
        `select id, status, benchmark_rotation, aggregate_version::text
           from tournaments where benchmark_series_id = $1
          order by benchmark_rotation`,
        [seriesId],
      );
      const cancelled = tournamentResult.rows.find((tournament) => tournament.status === "CANCELLED");
      if (cancelled) {
        await this.#closeBenchmarkSeries(seriesId, "CANCELLED", lockClient);
        throw new Error("Benchmark series contains a cancelled tournament");
      }
      const current = tournamentResult.rows.find((tournament) => (
        ["DRAFT", "PREFLIGHT", "READY", "RUNNING", "PAUSED_INFRA"].includes(tournament.status)
      ));
      if (current && current.status === "DRAFT" && Number(current.aggregate_version) === 0) {
        await lockClient.query("delete from tournaments where id = $1 and status = 'DRAFT' and aggregate_version = 0", [current.id]);
      } else if (current) {
        await lockClient.query(
          `update benchmark_series set status = 'RUNNING',
                  next_rotation = greatest(next_rotation, $2), updated_at = now()
            where id = $1`,
          [seriesId, current.benchmark_rotation + 1],
        );
        return this.#recoverSeriesTournament(current.id);
      }

      const completedRotations = new Set(
        tournamentResult.rows
          .filter((tournament) => tournament.status === "COMPLETED")
          .map((tournament) => tournament.benchmark_rotation),
      );
      let rotation = 0;
      while (completedRotations.has(rotation)) rotation += 1;
      if (rotation >= series.rotation_count) {
        await this.#closeBenchmarkSeries(seriesId, "COMPLETED", lockClient);
        const last = tournamentResult.rows.at(-1);
        if (!last) throw new Error("Completed benchmark series has no tournaments");
        return this.#recoverSeriesTournament(last.id);
      }
      if (tournamentResult.rows.some((tournament) => tournament.benchmark_rotation > rotation)) {
        throw new Error("Benchmark series rotations are not contiguous");
      }

      const schedule = this.#dealSchedule(series);
      const models = await this.models.revisionDetails(series.competitor_revision_ids);
      if (models.length !== series.competitor_revision_ids.length) {
        throw new Error("Benchmark competitor revision is unavailable");
      }
      const seated = rotateSeats(models, rotation, series.rotation_policy_version);
      const selectedPrompt = await this.#systemPrompts.resolve(
        series.system_prompt_version_id ?? series.tournament_configuration.systemPromptVersionId,
      );
      if (typeof series.benchmark_track.systemPromptHash === "string"
        && selectedPrompt.prompt.sha256 !== series.benchmark_track.systemPromptHash) {
        throw new Error("Benchmark series system prompt no longer matches its frozen track");
      }
      const frozen = Object.fromEntries(await Promise.all(seated.map(async (model) => [
        model.revisionId,
        trackModelConfig({
          ...await this.models.runtimeConfigForRevision(model.revisionId),
          timeoutMs: series.tournament_configuration.decisionTimeoutMs,
        }, series.tournament_configuration.interfaceTrack ?? "native"),
      ] as const)));
      const providers = this.#providersFromFrozen(frozen);
      const orchestrator = new TournamentOrchestrator({ eventStore: this.#store, pool: this.pool, providers });
      const tournamentId = randomUUID();
      let runtime: OrchestratorRuntime;
      try {
        runtime = await orchestrator.createAndStart({
          tournamentId,
          name: `${series.name} · ${rotation + 1}/${series.rotation_count}`,
          rulesetVersion: series.ruleset_version,
          protocolBundleId: series.protocol_bundle_id,
          benchmarkTrack: series.benchmark_track,
          effectiveSystemPrompt: selectedPrompt.prompt,
          systemPromptVersionId: selectedPrompt.version.id,
          tournament: {
            seatCount: seated.length,
            players: seated.map((model, seat) => ({ id: model.revisionId, seat })),
            initialStack: series.tournament_configuration.initialStack,
            initialButton: 0,
            handsPerLevel: series.tournament_configuration.handsPerLevel,
            blindLevels: series.tournament_configuration.blindLevels,
          },
          providerIdByPlayer: Object.fromEntries(seated.map((model) => [model.revisionId, model.revisionId])),
          frozenModelConfigByPlayer: frozen,
          playerLabels: Object.fromEntries(seated.map((model) => [
            model.revisionId,
            series.competitor_labels[model.revisionId] ?? model.displayName,
          ])),
          decisionTimeoutMs: series.tournament_configuration.decisionTimeoutMs,
          decisionConfig: decisionConfig(series.tournament_configuration.historyMode ?? "query_only"),
          managedByArena: true,
          dealSchedule: schedule,
          benchmarkSeriesId: seriesId,
          benchmarkRotation: rotation,
          revealSeedOnCompletion: false,
        });
        if (pauseBeforeFirstDecision && runtime.operationalStatus === "RUNNING") {
          runtime = await orchestrator.pause(runtime);
        }
      } catch (error) {
        await lockClient.query(
          "delete from tournaments where id = $1 and status in ('DRAFT', 'READY')",
          [tournamentId],
        );
        throw error;
      }
      await lockClient.query(
        `update benchmark_series set status = 'RUNNING', next_rotation = $2,
                updated_at = now() where id = $1`,
        [seriesId, rotation + 1],
      );
      const record: ActiveArena = {
        orchestrator,
        runtime,
        desiredStatus: pauseBeforeFirstDecision ? "PAUSED" : "RUNNING",
        driving: false,
        drivePromise: null,
        lastError: null,
      };
      this.#records.set(runtime.tournamentId, record);
      if (record.desiredStatus === "RUNNING") this.#startDrive(record);
      return runtime;
    } finally {
      try {
        await lockClient.query("select pg_advisory_unlock(hashtextextended($1, 0))", [`arena:benchmark-series:${seriesId}`]);
      } finally {
        lockClient.release();
      }
    }
  }

  async #advanceBenchmarkSeries(runtime: OrchestratorRuntime, pauseNextRotation = false): Promise<void> {
    if (!runtime.benchmarkSeriesId) return;
    await this.#startSeriesRotation(runtime.benchmarkSeriesId, pauseNextRotation);
  }

  async #recoverSeriesTournament(tournamentId: string): Promise<OrchestratorRuntime> {
    const existing = this.#records.get(tournamentId);
    if (existing) return existing.runtime;
    const record = await this.#record(tournamentId);
    if (record.desiredStatus === "RUNNING") this.#startDrive(record);
    return record.runtime;
  }

  #dealSchedule(series: BenchmarkSeriesRow): DealSchedule {
    const schedule = decryptJson(
      series.encrypted_deal_schedule as Parameters<typeof decryptJson>[0],
      this.masterKey,
      `arena:benchmark-series:${series.id}:deal-schedule`,
    ) as DealSchedule;
    if (!verifyDealSchedule(schedule)
      || schedule.id !== series.deal_schedule_id
      || schedule.version !== series.deal_schedule_version
      || schedule.commitment !== series.deal_schedule_commitment) {
      throw new Error("Benchmark deal schedule failed its commitment check");
    }
    return schedule;
  }

  async #closeBenchmarkSeries(
    seriesId: string,
    status: "COMPLETED" | "CANCELLED",
    queryable: Pick<PoolClient, "query"> | Pool = this.pool,
  ): Promise<void> {
    const result = await queryable.query<BenchmarkSeriesRow>(
      "select * from benchmark_series where id = $1",
      [seriesId],
    );
    const series = result.rows[0];
    if (!series || series.status === "COMPLETED" || series.status === "CANCELLED") return;
    const schedule = this.#dealSchedule(series);
    await queryable.query(
      `update benchmark_series set status = $2, revealed_deal_schedule_seed = $3,
              updated_at = now() where id = $1 and status in ('READY', 'RUNNING')`,
      [seriesId, status, schedule.seedBase64],
    );
  }

  async #cancelBenchmarkSeries(runtime: OrchestratorRuntime): Promise<void> {
    if (!runtime.benchmarkSeriesId) return;
    await this.#closeBenchmarkSeries(runtime.benchmarkSeriesId, "CANCELLED");
  }

  async #withTableLaunchLock<T>(action: () => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    const lockName = "arena:single-table-launch";
    try {
      await client.query("select pg_advisory_lock(hashtextextended($1, 0))", [lockName]);
      return await action();
    } finally {
      try {
        await client.query("select pg_advisory_unlock(hashtextextended($1, 0))", [lockName]);
      } finally {
        client.release();
      }
    }
  }
}
