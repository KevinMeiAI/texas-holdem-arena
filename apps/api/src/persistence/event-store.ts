import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  encryptedPayloadSchema,
  newArenaEventSchema,
  storedArenaEventSchema,
  type LoadedArenaEvent,
  type NewArenaEvent,
  type StoredArenaEvent,
} from "../../../../packages/contracts/src/events.js";
import { canonicalJson } from "../../../../packages/fairness/src/canonical-json.js";
import {
  GENESIS_EVENT_HASH,
  hashArenaEvent,
  verifyEventChain,
  type ChainVerification,
} from "../../../../packages/fairness/src/event-hash.js";
import { decryptJson, encryptJson } from "../security/encryption.js";

interface TournamentRow {
  id: string;
  name: string;
  status: string;
  ruleset_version: string;
  aggregate_version: string;
  next_event_sequence: string;
  last_event_hash: string;
  public_state: unknown;
}

interface EventRow {
  tournament_id: string;
  sequence: string;
  aggregate_version: string;
  event_type: string;
  actor_id: string | null;
  hand_no: number | null;
  public_payload: unknown;
  encrypted_private_payload: unknown | null;
  private_visibility: StoredArenaEvent["privateVisibility"];
  private_owner_id: string | null;
  prev_hash: string;
  event_hash: string;
  created_at: Date | string;
}

interface SnapshotRow {
  tournament_id: string;
  event_sequence: string;
  aggregate_version: string;
  public_state: unknown;
  encrypted_private_state: unknown;
  checksum: string;
}

export interface CreateTournamentRecord {
  id: string;
  name: string;
  rulesetVersion: string;
  configuration: unknown;
  promptHash?: string;
  protocolBundleId?: string;
  benchmarkTrackId?: string;
  benchmarkCohortId?: string;
}

export interface AppendSnapshot {
  publicState: unknown;
  privateState: unknown;
}

export interface PendingDecisionRequest {
  id: string;
  handNo: number;
  playerId: string;
  requestKind: "ACTION";
  promptHash: string;
  idempotencyKey: string;
}

export interface AppendEventsInput {
  tournamentId: string;
  expectedVersion: number;
  events: NewArenaEvent[];
  nextStatus?: string;
  publicState?: unknown;
  snapshot?: AppendSnapshot;
  decisionRequest?: PendingDecisionRequest;
  completeDecision?: { id: string; workerId: string; finalResponse: unknown };
  failDecisionInfrastructure?: { id: string; workerId: string; errorClass: string };
  cancelDecisionId?: string;
}

export interface AppendEventsResult {
  events: StoredArenaEvent[];
  aggregateVersion: number;
  nextSequence: number;
  finalHash: string;
}

export interface DecisionTurnAuditInput {
  decisionId: string;
  turnIndex: number;
  request: unknown;
  response?: unknown;
  outcome: "SUCCESS" | "PROTOCOL_ERROR" | "INFRA_ERROR";
  errorKind: string | null;
  providerConfigHash: string;
  outputSchemaVersion: string;
  outputSchemaHash: string;
  latencyMs: number | null;
  usage: unknown | null;
}

export interface LoadedSnapshot {
  tournamentId: string;
  eventSequence: number;
  aggregateVersion: number;
  publicState: unknown;
  privateState: unknown;
  checksum: string;
}

export class EventStoreConcurrencyError extends Error {
  constructor(readonly expectedVersion: number, readonly actualVersion: number) {
    super(`Tournament version conflict: expected ${expectedVersion}, got ${actualVersion}`);
    this.name = "EventStoreConcurrencyError";
  }
}

function eventAad(tournamentId: string, sequence: number, version: number, type: string): string {
  return `arena:event:${tournamentId}:${sequence}:${version}:${type}`;
}

function snapshotAad(tournamentId: string, sequence: number, version: number): string {
  return `arena:snapshot:${tournamentId}:${sequence}:${version}`;
}

function decisionStateAad(decisionId: string): string {
  return `arena:decision-state:${decisionId}`;
}

function decisionTurnAad(decisionId: string, turnIndex: number, kind: "request" | "response"): string {
  return `arena:decision-turn:${decisionId}:${turnIndex}:${kind}`;
}

function canonicalHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapEventRow(row: EventRow): StoredArenaEvent {
  return storedArenaEventSchema.parse({
    tournamentId: row.tournament_id,
    sequence: Number(row.sequence),
    aggregateVersion: Number(row.aggregate_version),
    type: row.event_type,
    actorId: row.actor_id,
    handNo: row.hand_no,
    publicPayload: row.public_payload,
    encryptedPrivatePayload: row.encrypted_private_payload,
    privateVisibility: row.private_visibility,
    privateOwnerId: row.private_owner_id,
    prevHash: row.prev_hash,
    eventHash: row.event_hash,
    createdAt: iso(row.created_at),
  });
}

function snapshotChecksum(input: {
  tournamentId: string;
  eventSequence: number;
  aggregateVersion: number;
  publicState: unknown;
  encryptedPrivateState: unknown;
}): string {
  return createHash("sha256").update(canonicalJson(input)).digest("hex");
}

export class PgEventStore {
  constructor(private readonly pool: Pool, private readonly masterKey: Uint8Array) {
    if (masterKey.byteLength !== 32) throw new Error("Event store requires a 32-byte master key");
  }

  async saveDecisionResumeState(decisionId: string, state: unknown): Promise<void> {
    canonicalJson(state);
    const encrypted = encryptJson(state, this.masterKey, decisionStateAad(decisionId));
    await this.pool.query(
      `insert into decision_resume_states (decision_id, encrypted_state, state_hash)
       values ($1, $2::jsonb, $3)
       on conflict (decision_id) do update
         set encrypted_state = excluded.encrypted_state,
             state_hash = excluded.state_hash,
             updated_at = now()`,
      [decisionId, JSON.stringify(encrypted), canonicalHash(state)],
    );
  }

  async loadDecisionResumeState<T>(decisionId: string): Promise<T | null> {
    const result = await this.pool.query<{ encrypted_state: unknown; state_hash: string }>(
      "select encrypted_state, state_hash from decision_resume_states where decision_id = $1",
      [decisionId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const state = decryptJson(
      encryptedPayloadSchema.parse(row.encrypted_state),
      this.masterKey,
      decisionStateAad(decisionId),
    );
    if (canonicalHash(state) !== row.state_hash) throw new Error("Decision resume state hash mismatch");
    return state as T;
  }

  async appendDecisionTurn(input: DecisionTurnAuditInput): Promise<void> {
    if (!Number.isSafeInteger(input.turnIndex) || input.turnIndex < 1) {
      throw new Error("Decision turn index must be positive");
    }
    canonicalJson(input.request);
    if (input.response !== undefined) canonicalJson(input.response);
    const encryptedRequest = encryptJson(
      input.request,
      this.masterKey,
      decisionTurnAad(input.decisionId, input.turnIndex, "request"),
    );
    const encryptedResponse = input.response === undefined ? null : encryptJson(
      input.response,
      this.masterKey,
      decisionTurnAad(input.decisionId, input.turnIndex, "response"),
    );
    await this.pool.query(
      `insert into decision_turns
        (decision_id, turn_index, request_hash, encrypted_request, response_hash,
         encrypted_response, outcome, error_kind, provider_config_hash,
         output_schema_version, output_schema_hash, latency_ms, usage)
       values ($1, $2, $3, $4::jsonb, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, $13::jsonb)
       on conflict (decision_id, turn_index) do nothing`,
      [
        input.decisionId,
        input.turnIndex,
        canonicalHash(input.request),
        JSON.stringify(encryptedRequest),
        input.response === undefined ? null : canonicalHash(input.response),
        encryptedResponse ? JSON.stringify(encryptedResponse) : null,
        input.outcome,
        input.errorKind,
        input.providerConfigHash,
        input.outputSchemaVersion,
        input.outputSchemaHash,
        input.latencyMs,
        input.usage === null ? null : JSON.stringify(input.usage),
      ],
    );
  }

  async loadDecisionAudit(tournamentId: string, handNo: number): Promise<unknown[]> {
    const result = await this.pool.query<{
      decision_id: string;
      player_id: string;
      turn_index: number;
      request_hash: string;
      encrypted_request: unknown;
      response_hash: string | null;
      encrypted_response: unknown | null;
      outcome: string;
      error_kind: string | null;
      provider_config_hash: string;
      output_schema_version: string;
      output_schema_hash: string;
      latency_ms: number | null;
      usage: unknown | null;
      created_at: Date | string;
    }>(
      `select d.id as decision_id, d.player_id, t.turn_index, t.request_hash,
              t.encrypted_request, t.response_hash, t.encrypted_response, t.outcome,
              t.error_kind, t.provider_config_hash, t.output_schema_version,
              t.output_schema_hash, t.latency_ms, t.usage, t.created_at
         from decision_requests d join decision_turns t on t.decision_id = d.id
        where d.tournament_id = $1 and d.hand_no = $2
        order by d.created_at, t.turn_index`,
      [tournamentId, handNo],
    );
    return result.rows.map((row) => {
      const request = decryptJson(
        encryptedPayloadSchema.parse(row.encrypted_request),
        this.masterKey,
        decisionTurnAad(row.decision_id, row.turn_index, "request"),
      );
      if (canonicalHash(request) !== row.request_hash) throw new Error("Decision request audit hash mismatch");
      const response = row.encrypted_response === null ? null : decryptJson(
        encryptedPayloadSchema.parse(row.encrypted_response),
        this.masterKey,
        decisionTurnAad(row.decision_id, row.turn_index, "response"),
      );
      if (response !== null && canonicalHash(response) !== row.response_hash) {
        throw new Error("Decision response audit hash mismatch");
      }
      return {
        decision_id: row.decision_id,
        player_id: row.player_id,
        turn_index: row.turn_index,
        request_hash: row.request_hash,
        request,
        response_hash: row.response_hash,
        response,
        outcome: row.outcome,
        error_kind: row.error_kind,
        provider_config_hash: row.provider_config_hash,
        output_schema_version: row.output_schema_version,
        output_schema_hash: row.output_schema_hash,
        latency_ms: row.latency_ms,
        usage: row.usage,
        created_at: iso(row.created_at),
      };
    });
  }

  async createTournament(input: CreateTournamentRecord): Promise<void> {
    await this.pool.query(
      `insert into tournaments
        (id, name, status, ruleset_version, prompt_hash, configuration,
         protocol_bundle_id, benchmark_track_id, benchmark_cohort_id)
       values ($1, $2, 'DRAFT', $3, $4, $5::jsonb, $6, $7, $8)`,
      [
        input.id,
        input.name,
        input.rulesetVersion,
        input.promptHash ?? null,
        JSON.stringify(input.configuration),
        input.protocolBundleId ?? "legacy/native-unclassified",
        input.benchmarkTrackId ?? "legacy/native-unclassified",
        input.benchmarkCohortId ?? "legacy/native-unclassified",
      ],
    );
  }

  async append(input: AppendEventsInput): Promise<AppendEventsResult> {
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
      throw new Error("expectedVersion must be a non-negative integer");
    }
    if (input.events.length === 0) throw new Error("At least one event is required");
    const parsedEvents = input.events.map((event) => newArenaEventSchema.parse(event));
    for (const event of parsedEvents) {
      canonicalJson(event.publicPayload);
      if (event.privatePayload !== undefined) canonicalJson(event.privatePayload);
    }
    if (input.publicState !== undefined) canonicalJson(input.publicState);
    if (input.snapshot) {
      canonicalJson(input.snapshot.publicState);
      canonicalJson(input.snapshot.privateState);
    }
    if (input.completeDecision) canonicalJson(input.completeDecision.finalResponse);
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const tournamentResult = await client.query<TournamentRow>(
        `select id, name, status, ruleset_version, aggregate_version::text,
                next_event_sequence::text, last_event_hash, public_state
           from tournaments where id = $1 for update`,
        [input.tournamentId],
      );
      const tournament = tournamentResult.rows[0];
      if (!tournament) throw new Error(`Tournament not found: ${input.tournamentId}`);
      const actualVersion = Number(tournament.aggregate_version);
      if (actualVersion !== input.expectedVersion) {
        throw new EventStoreConcurrencyError(input.expectedVersion, actualVersion);
      }

      let sequence = Number(tournament.next_event_sequence);
      let version = actualVersion;
      let prevHash = tournament.last_event_hash || GENESIS_EVENT_HASH;
      const stored: StoredArenaEvent[] = [];

      for (const event of parsedEvents) {
        version += 1;
        const currentSequence = sequence;
        sequence += 1;
        const encryptedPrivatePayload = event.privatePayload === undefined
          ? null
          : encryptJson(
            event.privatePayload,
            this.masterKey,
            eventAad(input.tournamentId, currentSequence, version, event.type),
          );
        const hashable = {
          tournamentId: input.tournamentId,
          sequence: currentSequence,
          aggregateVersion: version,
          type: event.type,
          actorId: event.actorId,
          handNo: event.handNo,
          publicPayload: event.publicPayload,
          encryptedPrivatePayload,
          privateVisibility: event.privateVisibility,
          privateOwnerId: event.privateOwnerId,
        };
        const eventHash = hashArenaEvent(hashable, prevHash);
        const inserted = await client.query<EventRow>(
          `insert into arena_events
            (tournament_id, sequence, aggregate_version, event_type, actor_id, hand_no,
             public_payload, encrypted_private_payload, private_visibility, private_owner_id,
             prev_hash, event_hash)
           values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11, $12)
           returning tournament_id, sequence::text, aggregate_version::text, event_type,
                     actor_id, hand_no, public_payload, encrypted_private_payload,
                     private_visibility, private_owner_id, prev_hash, event_hash, created_at`,
          [
            input.tournamentId,
            currentSequence,
            version,
            event.type,
            event.actorId,
            event.handNo,
            JSON.stringify(event.publicPayload),
            encryptedPrivatePayload ? JSON.stringify(encryptedPrivatePayload) : null,
            event.privateVisibility,
            event.privateOwnerId,
            prevHash,
            eventHash,
          ],
        );
        const insertedRow = inserted.rows[0];
        if (!insertedRow) throw new Error("Event insert did not return a row");
        stored.push(mapEventRow(insertedRow));
        prevHash = eventHash;
      }

      const nextPublicState = input.publicState ?? input.snapshot?.publicState ?? tournament.public_state;
      await client.query(
        `update tournaments
            set aggregate_version = $2,
                next_event_sequence = $3,
                last_event_hash = $4,
                status = coalesce($5, status),
                public_state = $6::jsonb,
                updated_at = now()
          where id = $1`,
        [
          input.tournamentId,
          version,
          sequence,
          prevHash,
          input.nextStatus ?? null,
          JSON.stringify(nextPublicState),
        ],
      );

      if (input.snapshot) {
        const eventSequence = sequence - 1;
        const encryptedPrivateState = encryptJson(
          input.snapshot.privateState,
          this.masterKey,
          snapshotAad(input.tournamentId, eventSequence, version),
        );
        const checksum = snapshotChecksum({
          tournamentId: input.tournamentId,
          eventSequence,
          aggregateVersion: version,
          publicState: input.snapshot.publicState,
          encryptedPrivateState,
        });
        await client.query(
          `insert into state_snapshots
            (tournament_id, event_sequence, aggregate_version, public_state,
             encrypted_private_state, checksum)
           values ($1, $2, $3, $4::jsonb, $5::jsonb, $6)`,
          [
            input.tournamentId,
            eventSequence,
            version,
            JSON.stringify(input.snapshot.publicState),
            JSON.stringify(encryptedPrivateState),
            checksum,
          ],
        );
      }

      if (input.decisionRequest) {
        const decision = input.decisionRequest;
        await client.query(
          `insert into decision_requests
            (id, tournament_id, hand_no, player_id, expected_aggregate_version,
             request_kind, status, prompt_hash, idempotency_key)
           values ($1, $2, $3, $4, $5, $6, 'PENDING', $7, $8)`,
          [
            decision.id,
            input.tournamentId,
            decision.handNo,
            decision.playerId,
            version,
            decision.requestKind,
            decision.promptHash,
            decision.idempotencyKey,
          ],
        );
      }

      if (input.completeDecision) {
        const completed = await client.query(
          `update decision_requests
              set status = 'SUCCEEDED', final_response = $3::jsonb,
                  lease_owner = null, lease_expires_at = null, updated_at = now()
            where id = $1 and status = 'IN_FLIGHT' and lease_owner = $2`,
          [
            input.completeDecision.id,
            input.completeDecision.workerId,
            JSON.stringify(input.completeDecision.finalResponse),
          ],
        );
        if (completed.rowCount !== 1) {
          throw new Error("Decision lease is no longer owned by this worker");
        }
      }
      if (input.failDecisionInfrastructure) {
        const failed = await client.query(
          `update decision_requests
              set status = 'INFRA_FAILED', last_error_class = $3,
                  lease_owner = null, lease_expires_at = null, updated_at = now()
            where id = $1 and status = 'IN_FLIGHT' and lease_owner = $2`,
          [
            input.failDecisionInfrastructure.id,
            input.failDecisionInfrastructure.workerId,
            input.failDecisionInfrastructure.errorClass,
          ],
        );
        if (failed.rowCount !== 1) {
          throw new Error("Decision lease is no longer owned by this worker");
        }
      }
      if (input.cancelDecisionId) {
        await client.query(
          `update decision_requests
              set status = 'CANCELLED', lease_owner = null, lease_expires_at = null,
                  updated_at = now()
            where id = $1 and status in ('PENDING', 'IN_FLIGHT', 'INFRA_FAILED')`,
          [input.cancelDecisionId],
        );
      }

      await client.query("commit");
      return { events: stored, aggregateVersion: version, nextSequence: sequence, finalHash: prevHash };
    } catch (error) {
      await this.rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  private async rollback(client: PoolClient): Promise<void> {
    try {
      await client.query("rollback");
    } catch {
      // Preserve the original append error; a broken connection is discarded by pg.
    }
  }

  async loadEvents(
    tournamentId: string,
    options: { afterSequence?: number; includePrivate?: boolean } = {},
  ): Promise<LoadedArenaEvent[]> {
    const result = await this.pool.query<EventRow>(
      `select tournament_id, sequence, aggregate_version, event_type,
              actor_id, hand_no, public_payload, encrypted_private_payload,
              private_visibility, private_owner_id, prev_hash, event_hash, created_at
         from arena_events
        where tournament_id = $1 and sequence > $2
        order by arena_events.sequence`,
      [tournamentId, options.afterSequence ?? 0],
    );
    return result.rows.map((row) => {
      const event = mapEventRow(row);
      if (!options.includePrivate || !event.encryptedPrivatePayload) return { event };
      return {
        event,
        privatePayload: decryptJson(
          event.encryptedPrivatePayload,
          this.masterKey,
          eventAad(event.tournamentId, event.sequence, event.aggregateVersion, event.type),
        ),
      };
    });
  }

  async loadLatestSnapshot(tournamentId: string): Promise<LoadedSnapshot | null> {
    const result = await this.pool.query<SnapshotRow>(
      `select tournament_id, event_sequence, aggregate_version,
              public_state, encrypted_private_state, checksum
         from state_snapshots where tournament_id = $1
        order by state_snapshots.event_sequence desc limit 1`,
      [tournamentId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const eventSequence = Number(row.event_sequence);
    const aggregateVersion = Number(row.aggregate_version);
    const encryptedPrivateState = encryptedPayloadSchema.parse(row.encrypted_private_state);
    const calculated = snapshotChecksum({
      tournamentId,
      eventSequence,
      aggregateVersion,
      publicState: row.public_state,
      encryptedPrivateState,
    });
    if (calculated !== row.checksum) throw new Error("Snapshot checksum verification failed");
    return {
      tournamentId,
      eventSequence,
      aggregateVersion,
      publicState: row.public_state,
      privateState: decryptJson(
        encryptedPrivateState,
        this.masterKey,
        snapshotAad(tournamentId, eventSequence, aggregateVersion),
      ),
      checksum: row.checksum,
    };
  }

  async verifyTournamentChain(tournamentId: string): Promise<ChainVerification> {
    const events = await this.loadEvents(tournamentId);
    return verifyEventChain(events.map((item) => item.event));
  }

  async claimNextDecision(
    tournamentId: string,
    workerId: string,
    leaseMilliseconds: number,
  ): Promise<{
    id: string;
    handNo: number;
    playerId: string;
    expectedAggregateVersion: number;
    requestKind: "ACTION";
    promptHash: string;
    idempotencyKey: string;
    attemptCount: number;
  } | null> {
    if (!Number.isSafeInteger(leaseMilliseconds) || leaseMilliseconds < 1) {
      throw new Error("leaseMilliseconds must be a positive integer");
    }
    const result = await this.pool.query<{
      id: string;
      hand_no: number;
      player_id: string;
      expected_aggregate_version: string;
      request_kind: "ACTION";
      prompt_hash: string;
      idempotency_key: string;
      attempt_count: number;
    }>(
      `with candidate as (
         select id from decision_requests
          where tournament_id = $1
            and (
              status in ('PENDING', 'INFRA_FAILED')
              or (status = 'IN_FLIGHT' and lease_expires_at < now())
            )
          order by created_at
          for update skip locked
          limit 1
       )
       update decision_requests d
          set status = 'IN_FLIGHT',
              lease_owner = $2,
              lease_expires_at = now() + ($3::text || ' milliseconds')::interval,
              attempt_count = attempt_count + 1,
              updated_at = now()
         from candidate
        where d.id = candidate.id
       returning d.id, d.hand_no, d.player_id, d.expected_aggregate_version::text,
                 d.request_kind, d.prompt_hash, d.idempotency_key, d.attempt_count`,
      [tournamentId, workerId, leaseMilliseconds],
    );
    const row = result.rows[0];
    return row ? {
      id: row.id,
      handNo: row.hand_no,
      playerId: row.player_id,
      expectedAggregateVersion: Number(row.expected_aggregate_version),
      requestKind: row.request_kind,
      promptHash: row.prompt_hash,
      idempotencyKey: row.idempotency_key,
      attemptCount: row.attempt_count,
    } : null;
  }

  async completeDecision(id: string, workerId: string, finalResponse: unknown): Promise<void> {
    canonicalJson(finalResponse);
    const result = await this.pool.query(
      `update decision_requests
          set status = 'SUCCEEDED', final_response = $3::jsonb,
              lease_owner = null, lease_expires_at = null, updated_at = now()
        where id = $1 and status = 'IN_FLIGHT' and lease_owner = $2`,
      [id, workerId, JSON.stringify(finalResponse)],
    );
    if (result.rowCount !== 1) throw new Error("Decision lease is no longer owned by this worker");
  }

  async failDecisionInfrastructure(id: string, workerId: string, errorClass: string): Promise<void> {
    const result = await this.pool.query(
      `update decision_requests
          set status = 'INFRA_FAILED', last_error_class = $3,
              lease_owner = null, lease_expires_at = null, updated_at = now()
        where id = $1 and status = 'IN_FLIGHT' and lease_owner = $2`,
      [id, workerId, errorClass],
    );
    if (result.rowCount !== 1) throw new Error("Decision lease is no longer owned by this worker");
  }
}
