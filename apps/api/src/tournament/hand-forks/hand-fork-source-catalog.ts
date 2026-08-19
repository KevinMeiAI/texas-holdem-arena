import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
import {
  handForkLegalActionsSchema,
  handForkSourceCandidateSchema,
  handForkSourceErrorCodeSchema,
  handForkSourceIntegritySchema,
  handForkSourceSummarySchema,
  type HandForkSourceCandidate,
  type HandForkSourceIntegrity,
  type HandForkSourceSummary,
} from "../../../../../packages/contracts/src/index.js";
import { canonicalJson } from "../../../../../packages/fairness/src/canonical-json.js";
import type { HandForkSourcePayloadV1 } from "./hand-fork-repository.js";
import {
  HandForkSourceError,
  type HandForkResolvedSource,
  type HandForkSourceAssertions,
} from "./hand-fork-source.js";

const uuidSchema = z.string().uuid();
const handNoSchema = z.number().int().positive();

export interface HandForkSourceAnchor {
  decisionId: string;
  playerId: string;
  expectedAggregateVersion: number;
}

export interface HandForkSourceCatalogStore {
  tournamentExists(tournamentId: string): Promise<boolean>;
  handExists(tournamentId: string, handNo: number): Promise<boolean>;
  listActionDecisionAnchors(
    tournamentId: string,
    handNo: number,
  ): Promise<HandForkSourceAnchor[]>;
}

export interface HandForkSourceResolverLike {
  resolve(
    decisionId: string,
    assertions?: HandForkSourceAssertions,
  ): Promise<HandForkResolvedSource>;
}

export type HandForkSourceCatalogErrorCode = "TOURNAMENT_NOT_FOUND" | "HAND_NOT_FOUND";

export class HandForkSourceCatalogError extends Error {
  constructor(
    readonly code: HandForkSourceCatalogErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "HandForkSourceCatalogError";
  }
}

interface DecisionAnchorRow {
  id: string;
  player_id: string;
  expected_aggregate_version: string | number;
}

function positiveSafeInteger(value: string | number, name: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return parsed;
}

export class PgHandForkSourceCatalogStore implements HandForkSourceCatalogStore {
  constructor(private readonly pool: Pool) {}

  async tournamentExists(tournamentId: string): Promise<boolean> {
    const result = await this.pool.query(
      "select 1 from tournaments where id = $1 limit 1",
      [tournamentId],
    );
    return result.rowCount === 1;
  }

  async handExists(tournamentId: string, handNo: number): Promise<boolean> {
    const result = await this.pool.query(
      `select 1 from arena_events
        where tournament_id = $1 and hand_no = $2
        limit 1`,
      [tournamentId, handNo],
    );
    return result.rowCount === 1;
  }

  async listActionDecisionAnchors(
    tournamentId: string,
    handNo: number,
  ): Promise<HandForkSourceAnchor[]> {
    const result = await this.pool.query<DecisionAnchorRow>(
      `select id, player_id, expected_aggregate_version
         from decision_requests
        where tournament_id = $1 and hand_no = $2 and request_kind = 'ACTION'
        order by expected_aggregate_version, created_at, id`,
      [tournamentId, handNo],
    );
    return result.rows.map((row) => ({
      decisionId: uuidSchema.parse(row.id),
      playerId: z.string().min(1).max(200).parse(row.player_id),
      expectedAggregateVersion: positiveSafeInteger(
        row.expected_aggregate_version,
        "expectedAggregateVersion",
      ),
    }));
  }
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function handForkSourceSummary(source: HandForkResolvedSource): HandForkSourceSummary {
  return handForkSourceSummarySchema.parse({
    tournamentId: source.tournamentId,
    tournamentName: source.tournamentName,
    handNo: source.handNo,
    decisionId: source.decisionId,
    playerId: source.playerId,
    playerDisplayName: source.playerDisplayName,
    street: source.street,
    heroPosition: source.heroPosition,
    holeCards: source.holeCards,
    legalActions: source.legalActions,
    originalAction: source.originalAction,
    originalAmountTo: source.originalAmountTo,
    originalDecisionSummary: source.originalDecisionSummary,
    originalUsedFallback: source.originalUsedFallback,
    actionEventSequence: source.actionEventSequence,
  });
}

export function handForkSourcePayload(source: HandForkResolvedSource): HandForkSourcePayloadV1 {
  const summary = handForkSourceSummary(source);
  return {
    version: "hand-fork-source-v1",
    source: {
      tournamentName: summary.tournamentName,
      playerDisplayName: summary.playerDisplayName,
      street: summary.street,
      heroPosition: summary.heroPosition,
      holeCards: [summary.holeCards[0]!, summary.holeCards[1]!],
      legalActions: handForkLegalActionsSchema.parse(summary.legalActions),
      originalAction: summary.originalAction,
      originalAmountTo: summary.originalAmountTo,
      originalDecisionSummary: summary.originalDecisionSummary,
      originalUsedFallback: summary.originalUsedFallback,
      decisionEventSequence: source.decisionEventSequence,
      snapshotChecksum: source.snapshotChecksum,
    },
    baseRequest: source.baseRequest,
    decisionConfig: source.decisionConfig,
  };
}

export function handForkSourceIntegrity(source: HandForkResolvedSource): HandForkSourceIntegrity {
  const outputSchemaHash = source.baseRequest.outputSchema?.sha256;
  if (!outputSchemaHash) {
    throw new Error("Resolved hand fork source has no frozen output schema hash");
  }
  return handForkSourceIntegritySchema.parse({
    expectedAggregateVersion: source.expectedAggregateVersion,
    sourceEventHash: source.sourceEventHash,
    sourceRequestHash: source.requestHash,
    sourcePayloadHash: sha256(handForkSourcePayload(source)),
    visibleInputHash: source.visibleInputHash,
    legalContractHash: source.legalContractHash,
    protocolBundleId: source.protocolBundle.id,
    rulesetVersion: source.rulesetVersion,
    contextVersion: source.protocolBundle.contextVersion,
    systemPromptHash: source.baseRequest.systemPromptHash,
    outputSchemaHash,
    parserPolicyVersion: source.baseRequest.parserPolicy
      ?? source.protocolBundle.parserPolicyVersion,
    adapterProtocolVersion: source.baseRequest.adapterProtocolVersion
      ?? source.protocolBundle.adapterProtocolVersion,
    historyProtocolVersion: source.historyProtocolVersion,
    correctionProtocolVersion: source.protocolBundle.correctionProtocolVersion,
  });
}

export function handForkSourceCandidateFromResolved(
  source: HandForkResolvedSource,
): HandForkSourceCandidate {
  return handForkSourceCandidateSchema.parse({
    availability: "AVAILABLE",
    decisionId: source.decisionId,
    playerId: source.playerId,
    expectedAggregateVersion: source.expectedAggregateVersion,
    source: handForkSourceSummary(source),
    sourceIntegrity: handForkSourceIntegrity(source),
  });
}

export class HandForkSourceCatalog {
  constructor(
    private readonly store: HandForkSourceCatalogStore,
    private readonly resolver: HandForkSourceResolverLike,
  ) {}

  async list(tournamentId: string, handNo: number): Promise<HandForkSourceCandidate[]> {
    uuidSchema.parse(tournamentId);
    handNoSchema.parse(handNo);
    if (!(await this.store.tournamentExists(tournamentId))) {
      throw new HandForkSourceCatalogError(
        "TOURNAMENT_NOT_FOUND",
        "The source tournament does not exist",
      );
    }
    if (!(await this.store.handExists(tournamentId, handNo))) {
      throw new HandForkSourceCatalogError(
        "HAND_NOT_FOUND",
        "The source hand does not exist",
      );
    }

    const candidates: HandForkSourceCandidate[] = [];
    const anchors = await this.store.listActionDecisionAnchors(tournamentId, handNo);
    for (const anchor of anchors) {
      try {
        const source = await this.resolver.resolve(anchor.decisionId, { tournamentId, handNo });
        candidates.push(handForkSourceCandidateFromResolved(source));
      } catch (error) {
        if (!(error instanceof HandForkSourceError)) throw error;
        candidates.push(handForkSourceCandidateSchema.parse({
          availability: "UNAVAILABLE",
          decisionId: anchor.decisionId,
          playerId: anchor.playerId,
          expectedAggregateVersion: anchor.expectedAggregateVersion,
          reasonCode: handForkSourceErrorCodeSchema.parse(error.code),
        }));
      }
    }
    return candidates;
  }
}

export function pgHandForkSourceCatalog(
  pool: Pool,
  resolver: HandForkSourceResolverLike,
): HandForkSourceCatalog {
  return new HandForkSourceCatalog(new PgHandForkSourceCatalogStore(pool), resolver);
}
