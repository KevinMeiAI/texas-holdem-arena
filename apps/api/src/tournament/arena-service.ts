import { randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { projectArenaEvent, type ProjectionRole } from "../../../../packages/contracts/src/visibility.js";
import { deriveSeed, DeterministicRng } from "../../../../packages/fairness/src/rng.js";
import { createProvider } from "../../../../packages/providers/src/provider-factory.js";
import type { ModelProvider } from "../../../../packages/providers/src/provider.js";
import { ModelConfigService } from "../admin/model-service.js";
import { PgEventStore } from "../persistence/event-store.js";
import {
  TournamentOrchestrator,
  type OperationalStatus,
  type OrchestratorRuntime,
} from "./orchestrator.js";

export interface CreateArenaTournamentInput {
  name: string;
  modelConfigIds: string[];
  initialStack: number;
  handsPerLevel: number;
  blindLevels: { smallBlind: number; bigBlind: number; bigBlindAnte: number }[];
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

export class ArenaService {
  readonly #records = new Map<string, ActiveArena>();
  readonly #store: PgEventStore;
  #stopping = false;

  constructor(
    private readonly pool: Pool,
    masterKey: Uint8Array,
    private readonly models: ModelConfigService,
    private readonly displayDelayMs = 120,
  ) {
    this.#store = new PgEventStore(pool, masterKey);
  }

  async restoreActive(): Promise<void> {
    const result = await this.pool.query<{
      id: string;
      status: string;
      configuration: {
        providerIdByPlayer?: Record<string, string>;
      };
    }>(
      `select id, status, configuration from tournaments
        where status in ('RUNNING', 'PAUSED_INFRA')
          and configuration @> '{"managedByArena":true}'::jsonb`,
    );
    for (const row of result.rows) {
      const ids = Object.values(row.configuration.providerIdByPlayer ?? {});
      const providers = await this.#providers(ids);
      const orchestrator = new TournamentOrchestrator({
        eventStore: this.#store,
        pool: this.pool,
        providers,
      });
      const runtime = await orchestrator.recover(row.id);
      const record: ActiveArena = {
        orchestrator,
        runtime,
        desiredStatus: runtime.operationalStatus === "RUNNING" ? "RUNNING" : "PAUSED",
        driving: false,
        drivePromise: null,
        lastError: null,
      };
      this.#records.set(row.id, record);
      if (record.desiredStatus === "RUNNING") this.#startDrive(record);
    }
  }

  async create(input: CreateArenaTournamentInput): Promise<OrchestratorRuntime> {
    if (this.#stopping) throw new Error("Arena service is shutting down");
    const models = await Promise.all(input.modelConfigIds.map(async (id) => {
      const model = await this.models.getModel(id);
      if (!model) throw new Error(`Model configuration not found: ${id}`);
      return model;
    }));
    const providers = await this.#providers(input.modelConfigIds);
    const masterSeed = randomBytes(32);
    const seatingRng = new DeterministicRng(deriveSeed(masterSeed, "tournament:seating"));
    const seated = seatingRng.shuffle(models);
    const tournamentId = randomUUID();
    const orchestrator = new TournamentOrchestrator({ eventStore: this.#store, pool: this.pool, providers });
    const runtime = await orchestrator.createAndStart({
      tournamentId,
      name: input.name,
      rulesetVersion: "arena-rules-v1",
      tournament: {
        seatCount: seated.length,
        players: seated.map((model, seat) => ({ id: model.id, seat })),
        initialStack: input.initialStack,
        initialButton: seatingRng.int(seated.length),
        handsPerLevel: input.handsPerLevel,
        blindLevels: input.blindLevels,
      },
      providerIdByPlayer: Object.fromEntries(seated.map((model) => [model.id, model.id])),
      playerLabels: Object.fromEntries(seated.map((model) => [model.id, model.displayName])),
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
          order by (status in ('RUNNING','PAUSED_INFRA')) desc, created_at desc limit 1`,
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
      created_at: Date;
      updated_at: Date;
    }>(
      `select id, name, status, ruleset_version, prompt_hash, champion_player_id,
              public_state, created_at, updated_at
         from tournaments order by created_at desc`,
    );
    return result.rows.map((row) => ({
      id: row.id,
      name: row.name,
      status: row.status,
      rulesetVersion: row.ruleset_version,
      promptHash: row.prompt_hash,
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

  async leaderboard(): Promise<unknown[]> {
    const result = await this.pool.query<{ public_state: {
      status?: string;
      championPlayerId?: string | null;
      players?: { id: string; displayName: string; finishingPosition: number | null }[];
    } }>("select public_state from tournaments where status = 'COMPLETED'");
    const entries = new Map<string, {
      modelId: string;
      displayName: string;
      tournaments: number;
      championships: number;
      finishTotal: number;
    }>();
    for (const row of result.rows) {
      for (const player of row.public_state.players ?? []) {
        if (!player.finishingPosition) continue;
        const entry = entries.get(player.id) ?? {
          modelId: player.id,
          displayName: player.displayName,
          tournaments: 0,
          championships: 0,
          finishTotal: 0,
        };
        entry.tournaments += 1;
        entry.finishTotal += player.finishingPosition;
        if (row.public_state.championPlayerId === player.id) entry.championships += 1;
        entries.set(player.id, entry);
      }
    }
    return [...entries.values()].map((entry) => ({
      ...entry,
      championshipRate: entry.championships / entry.tournaments,
      averageFinish: entry.finishTotal / entry.tournaments,
      sampleWarning: entry.tournaments < 10,
    })).sort((left, right) => (
      right.championshipRate - left.championshipRate || left.averageFinish - right.averageFinish
    ));
  }

  async fairness(tournamentId: string): Promise<unknown> {
    return {
      chain: await this.#store.verifyTournamentChain(tournamentId),
      state: await this.publicState(tournamentId),
    };
  }

  async latestEventSequence(tournamentId: string): Promise<number | null> {
    const result = await this.pool.query<{ sequence: string }>(
      "select (next_event_sequence - 1)::text as sequence from tournaments where id = $1",
      [tournamentId],
    );
    return result.rows[0] ? Number(result.rows[0].sequence) : null;
  }

  async #providers(modelIds: readonly string[]): Promise<Map<string, ModelProvider>> {
    const providers = new Map<string, ModelProvider>();
    for (const id of new Set(modelIds)) {
      providers.set(id, createProvider(await this.models.runtimeConfig(id)));
    }
    return providers;
  }

  async #record(tournamentId: string): Promise<ActiveArena> {
    const existing = this.#records.get(tournamentId);
    if (existing) return existing;
    const snapshot = await this.#store.loadLatestSnapshot(tournamentId);
    if (!snapshot) throw new Error("Tournament not found");
    const runtime = snapshot.privateState as OrchestratorRuntime;
    const providers = await this.#providers(Object.values(runtime.providerIdByPlayer));
    const orchestrator = new TournamentOrchestrator({ eventStore: this.#store, pool: this.pool, providers });
    const record: ActiveArena = {
      orchestrator,
      runtime: await orchestrator.recover(tournamentId),
      desiredStatus: runtime.operationalStatus === "RUNNING" ? "RUNNING" : "PAUSED",
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
          return;
        }
        if (record.desiredStatus === "PAUSED") {
          if (record.runtime.operationalStatus === "RUNNING") {
            record.runtime = await record.orchestrator.pause(record.runtime);
          }
          return;
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
        if (record.runtime.operationalStatus === "COMPLETED") return;
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
}
