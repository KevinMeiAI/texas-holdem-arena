import {
  adminHandForkSchema,
  type AdminHandFork,
} from "../../../../../packages/contracts/src/index.js";
import type {
  HandForkPersistenceRecord,
  HandForkSourcePayloadV1,
} from "./hand-fork-repository.js";

export function adminHandForkFromPersistence(
  record: HandForkPersistenceRecord,
  payload: HandForkSourcePayloadV1,
): AdminHandFork {
  return adminHandForkSchema.parse({
    id: record.id,
    status: record.status,
    source: {
      tournamentId: record.sourceTournamentId,
      tournamentName: payload.source.tournamentName,
      handNo: record.sourceHandNo,
      decisionId: record.sourceDecisionId,
      playerId: record.sourcePlayerId,
      playerDisplayName: payload.source.playerDisplayName,
      street: payload.source.street,
      heroPosition: payload.source.heroPosition,
      holeCards: payload.source.holeCards,
      legalActions: payload.source.legalActions,
      originalAction: payload.source.originalAction,
      originalAmountTo: payload.source.originalAmountTo,
      originalDecisionSummary: payload.source.originalDecisionSummary,
      originalUsedFallback: payload.source.originalUsedFallback,
      actionEventSequence: record.sourceActionEventSequence,
    },
    sourceIntegrity: {
      expectedAggregateVersion: record.sourceExpectedAggregateVersion,
      sourceEventHash: record.sourceEventHash,
      sourceRequestHash: record.sourceRequestHash,
      sourcePayloadHash: record.sourcePayloadHash,
      visibleInputHash: record.visibleInputHash,
      legalContractHash: record.legalContractHash,
      protocolBundleId: record.protocolBundleId,
      rulesetVersion: record.rulesetVersion,
      contextVersion: record.contextVersion,
      systemPromptHash: record.systemPromptHash,
      outputSchemaHash: record.outputSchemaHash,
      parserPolicyVersion: record.parserPolicyVersion,
      adapterProtocolVersion: record.adapterProtocolVersion,
      historyProtocolVersion: record.historyProtocolVersion,
      correctionProtocolVersion: record.correctionProtocolVersion,
    },
    sampleCount: record.sampleCount,
    timeoutMs: record.timeoutMs,
    maxParallelTargets: record.maxParallelTargets,
    summary: record.summary,
    errorMessage: record.errorMessage,
    createdByAdminUserId: record.createdByAdminUserId,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    targets: record.targets,
  });
}
