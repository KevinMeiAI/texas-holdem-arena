import { z } from "zod";
import {
  handForkEffectiveOutputModeSchema,
  handForkLegalActionsSchema,
  handForkTrialOutcomeSchema,
} from "./hand-forks.js";
import { pokerActionSchema } from "./model-protocol.js";
import { providerBrandSchema } from "./provider-brand.js";

export const DECISION_BRANCH_SNAPSHOT_V1 = "arena-decision-branch-public-v1";
export const DECISION_BRANCH_SNAPSHOT_VERSION = DECISION_BRANCH_SNAPSHOT_V1;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const cardCodeSchema = z.string().regex(/^[2-9TJQKA][cdhs]$/);
const boundedNameSchema = z.string().trim().min(1).max(200);
const nullableRateSchema = z.number().min(0).max(1).nullable();

export const decisionBranchPublicationStatusSchema = z.enum(["DRAFT", "PUBLISHED", "HIDDEN"]);
export type DecisionBranchPublicationStatus = z.infer<typeof decisionBranchPublicationStatusSchema>;

export const decisionBranchPlayerSchema = z.object({
  playerId: z.string().min(1).max(200),
  displayName: boundedNameSchema,
  seat: z.number().int().min(0).max(8),
  position: z.string().trim().min(1).max(32).nullable(),
  stack: z.number().int().nonnegative(),
  stackBigBlinds: z.number().nonnegative(),
  streetCommitted: z.number().int().nonnegative(),
  totalCommitted: z.number().int().nonnegative(),
  folded: z.boolean(),
  allIn: z.boolean(),
  competitorId: z.string().uuid().nullable(),
  providerBrand: providerBrandSchema.nullable(),
}).strict();
export type DecisionBranchPlayer = z.infer<typeof decisionBranchPlayerSchema>;

export const decisionBranchActionHistoryItemSchema = z.object({
  sequence: z.number().int().positive(),
  type: z.enum([
    "FORCED_BET",
    "STREET_STARTED",
    "BOARD_DEALT",
    "ACTION",
    "UNCALLED_BET_RETURNED",
  ]),
  street: z.enum(["PREFLOP", "FLOP", "TURN", "RIVER"]).nullable(),
  playerId: z.string().min(1).max(200).nullable(),
  label: z.string().trim().min(1).max(40).nullable(),
  action: pokerActionSchema.nullable(),
  amount: z.number().int().nonnegative().nullable(),
  amountTo: z.number().int().nonnegative().nullable(),
  potAfter: z.number().int().nonnegative().nullable(),
  stackAfter: z.number().int().nonnegative().nullable(),
  cards: z.array(cardCodeSchema).max(5),
}).strict();
export type DecisionBranchActionHistoryItem = z.infer<typeof decisionBranchActionHistoryItemSchema>;

export const decisionBranchOriginalDecisionSchema = z.object({
  action: pokerActionSchema,
  amountTo: z.number().int().positive().nullable(),
  decisionSummary: z.string().trim().min(1).max(300).nullable(),
  usedFallback: z.boolean(),
}).strict().superRefine((decision, context) => {
  if ((decision.action === "bet" || decision.action === "raise") !== (decision.amountTo !== null)) {
    context.addIssue({
      code: "custom",
      path: ["amountTo"],
      message: "Only bet and raise use amountTo",
    });
  }
});

export const decisionBranchSourceSchema = z.object({
  tournamentId: z.string().uuid(),
  tournamentName: boundedNameSchema,
  handNo: z.number().int().positive(),
  actionSequence: z.number().int().positive(),
  street: z.enum(["PREFLOP", "FLOP", "TURN", "RIVER"]),
  heroPlayerId: z.string().min(1).max(200),
  heroDisplayName: boundedNameSchema,
  heroPosition: z.string().trim().min(1).max(32),
  heroHoleCards: z.array(cardCodeSchema).length(2),
  board: z.array(cardCodeSchema).max(5),
  blinds: z.object({
    smallBlind: z.number().int().positive(),
    bigBlind: z.number().int().positive(),
    bigBlindAnte: z.number().int().nonnegative(),
  }).strict(),
  potBeforeAction: z.number().int().nonnegative(),
  potBigBlinds: z.number().nonnegative(),
  currentBet: z.number().int().nonnegative(),
  callAmount: z.number().int().nonnegative(),
  legalActions: handForkLegalActionsSchema,
  players: z.array(decisionBranchPlayerSchema).min(2).max(9),
  actionHistory: z.array(decisionBranchActionHistoryItemSchema).max(120),
  originalDecision: decisionBranchOriginalDecisionSchema,
}).strict().superRefine((source, context) => {
  if (!source.players.some((player) => player.playerId === source.heroPlayerId)) {
    context.addIssue({ code: "custom", path: ["players"], message: "Source players must contain the hero" });
  }
  if (new Set(source.players.map((player) => player.playerId)).size !== source.players.length) {
    context.addIssue({ code: "custom", path: ["players"], message: "Source player IDs must be unique" });
  }
  if (new Set(source.players.map((player) => player.seat)).size !== source.players.length) {
    context.addIssue({ code: "custom", path: ["players"], message: "Source player seats must be unique" });
  }
  const expectedBoardLength = source.street === "PREFLOP" ? 0
    : source.street === "FLOP" ? 3 : source.street === "TURN" ? 4 : 5;
  if (source.board.length !== expectedBoardLength) {
    context.addIssue({ code: "custom", path: ["board"], message: "Board length must match the decision street" });
  }
  if (new Set([...source.heroHoleCards, ...source.board]).size
    !== source.heroHoleCards.length + source.board.length) {
    context.addIssue({ code: "custom", path: ["board"], message: "Known cards must be unique" });
  }
  if (source.blinds.smallBlind > source.blinds.bigBlind) {
    context.addIssue({ code: "custom", path: ["blinds"], message: "Small blind cannot exceed big blind" });
  }
  if (Math.abs(source.potBigBlinds - source.potBeforeAction / source.blinds.bigBlind) > 1e-12) {
    context.addIssue({ code: "custom", path: ["potBigBlinds"], message: "Pot big blinds must use the frozen big blind" });
  }
  if (source.callAmount !== (source.legalActions.call?.amount ?? 0)) {
    context.addIssue({ code: "custom", path: ["callAmount"], message: "Call amount must match the legal-action contract" });
  }
  if (source.actionHistory.some((item) => item.sequence >= source.actionSequence)) {
    context.addIssue({ code: "custom", path: ["actionHistory"], message: "Action history cannot pass the source decision" });
  }
});

export const decisionBranchActionDistributionEntrySchema = z.object({
  action: pokerActionSchema,
  count: z.number().int().positive(),
  share: z.number().min(0).max(1),
}).strict();

export const decisionBranchSizingEntrySchema = z.object({
  action: z.enum(["bet", "raise"]),
  count: z.number().int().positive(),
  median: z.number().nonnegative(),
  min: z.number().int().nonnegative(),
  max: z.number().int().nonnegative(),
}).strict().refine((entry) => entry.min <= entry.median && entry.median <= entry.max, {
  message: "Sizing median must stay within the observed range",
});

export const decisionBranchTrialSchema = z.object({
  sampleIndex: z.number().int().min(1).max(20),
  outcome: handForkTrialOutcomeSchema,
  action: pokerActionSchema.nullable(),
  amountTo: z.number().int().positive().nullable(),
  decisionSummary: z.string().trim().min(1).max(300).nullable(),
  usedFallback: z.boolean(),
}).strict().superRefine((trial, context) => {
  const actionOutcome = trial.outcome === "MODEL_ACTION" || trial.outcome === "PROTOCOL_FALLBACK";
  if (actionOutcome !== (trial.action !== null)) {
    context.addIssue({ code: "custom", path: ["action"], message: "Only action outcomes contain an action" });
  }
  if ((trial.action === "bet" || trial.action === "raise") !== (trial.amountTo !== null)) {
    context.addIssue({ code: "custom", path: ["amountTo"], message: "Only bet and raise use amountTo" });
  }
  if ((trial.outcome === "PROTOCOL_FALLBACK") !== trial.usedFallback) {
    context.addIssue({ code: "custom", path: ["usedFallback"], message: "Fallback flag must match the outcome" });
  }
  if (trial.outcome !== "MODEL_ACTION" && trial.decisionSummary !== null) {
    context.addIssue({
      code: "custom",
      path: ["decisionSummary"],
      message: "Only model actions expose a decision summary",
    });
  }
});

export const decisionBranchTargetSchema = z.object({
  ordinal: z.number().int().min(1).max(9),
  competitorId: z.string().uuid(),
  competitorRevisionId: z.string().uuid(),
  displayName: boundedNameSchema,
  modelId: z.string().trim().min(1).max(300),
  providerBrand: providerBrandSchema.nullable(),
  effectiveOutputMode: handForkEffectiveOutputModeSchema,
  requestedSamples: z.number().int().min(1).max(20),
  completedTrials: z.number().int().nonnegative(),
  modelActionTrials: z.number().int().nonnegative(),
  fallbackTrials: z.number().int().nonnegative(),
  infrastructureErrorTrials: z.number().int().nonnegative(),
  modalAction: pokerActionSchema.nullable(),
  modalShare: nullableRateSchema,
  pairwiseAgreement: nullableRateSchema,
  firstTurnValidRate: nullableRateSchema,
  historyQueryRate: nullableRateSchema,
  correctionRate: nullableRateSchema,
  averageLatencyMs: z.number().nonnegative().nullable(),
  p95LatencyMs: z.number().int().nonnegative().nullable(),
  actionDistribution: z.array(decisionBranchActionDistributionEntrySchema).max(6),
  sizing: z.array(decisionBranchSizingEntrySchema).max(2),
  trials: z.array(decisionBranchTrialSchema).min(1).max(20),
}).strict().superRefine((target, context) => {
  if (target.completedTrials !== target.modelActionTrials
    + target.fallbackTrials + target.infrastructureErrorTrials) {
    context.addIssue({ code: "custom", path: ["completedTrials"], message: "Completed trial totals are inconsistent" });
  }
  if (target.completedTrials !== target.requestedSamples || target.trials.length !== target.requestedSamples) {
    context.addIssue({
      code: "custom",
      path: ["requestedSamples"],
      message: "A published target requires every requested trial to be complete",
    });
  }
  const distributionTotal = target.actionDistribution.reduce((sum, entry) => sum + entry.count, 0);
  if (distributionTotal !== target.modelActionTrials) {
    context.addIssue({ code: "custom", path: ["actionDistribution"], message: "Distribution must use model actions only" });
  }
  if (new Set(target.actionDistribution.map((entry) => entry.action)).size !== target.actionDistribution.length) {
    context.addIssue({ code: "custom", path: ["actionDistribution"], message: "Distribution actions must be unique" });
  }
  if (new Set(target.trials.map((trial) => trial.sampleIndex)).size !== target.trials.length) {
    context.addIssue({ code: "custom", path: ["trials"], message: "Trial sample indexes must be unique" });
  }
  const observedModelActions = target.trials.filter((trial) => trial.outcome === "MODEL_ACTION").length;
  const observedFallbacks = target.trials.filter((trial) => trial.outcome === "PROTOCOL_FALLBACK").length;
  const observedInfrastructureErrors = target.trials.filter((trial) => trial.outcome === "INFRA_ERROR").length;
  if (observedModelActions !== target.modelActionTrials
    || observedFallbacks !== target.fallbackTrials
    || observedInfrastructureErrors !== target.infrastructureErrorTrials) {
    context.addIssue({ code: "custom", path: ["trials"], message: "Trial outcomes must match their public denominators" });
  }
  for (const entry of target.actionDistribution) {
    const expectedShare = target.modelActionTrials === 0 ? 0 : entry.count / target.modelActionTrials;
    if (Math.abs(entry.share - expectedShare) > 1e-12) {
      context.addIssue({ code: "custom", path: ["actionDistribution"], message: "Action shares must use model actions as denominator" });
    }
  }
  const modalMissing = target.modalAction === null || target.modalShare === null;
  if ((target.modelActionTrials === 0) !== modalMissing
    || (target.modalAction === null) !== (target.modalShare === null)) {
    context.addIssue({ code: "custom", path: ["modalAction"], message: "Modal metrics require model actions" });
  }
  if (target.modalAction !== null && target.modalShare !== null) {
    const modalEntry = target.actionDistribution.find((entry) => entry.action === target.modalAction);
    const maximum = Math.max(...target.actionDistribution.map((entry) => entry.count));
    if (!modalEntry || modalEntry.count !== maximum || Math.abs(modalEntry.share - target.modalShare) > 1e-12) {
      context.addIssue({ code: "custom", path: ["modalAction"], message: "Modal metrics must match the action distribution" });
    }
  }
  if ((target.modelActionTrials < 2) !== (target.pairwiseAgreement === null)) {
    context.addIssue({ code: "custom", path: ["pairwiseAgreement"], message: "Pairwise agreement requires at least two model actions" });
  }
});
export type DecisionBranchTarget = z.infer<typeof decisionBranchTargetSchema>;

export const decisionBranchMethodologySchema = z.object({
  scope: z.literal("DECISION_ONLY"),
  continuationSimulated: z.literal(false),
  sameVisibleInput: z.literal(true),
  sampleCountPerModel: z.number().int().min(1).max(20),
  targetCount: z.number().int().min(1).max(9),
  createdAt: z.string().datetime(),
  completedAt: z.string().datetime(),
}).strict();

const decisionBranchSnapshotV1Shape = {
  version: z.literal(DECISION_BRANCH_SNAPSHOT_V1),
  source: decisionBranchSourceSchema,
  methodology: decisionBranchMethodologySchema,
  targets: z.array(decisionBranchTargetSchema).min(1).max(9),
} satisfies z.ZodRawShape;

export const decisionBranchSnapshotV1Schema = z.object(decisionBranchSnapshotV1Shape)
  .strict()
  .superRefine((snapshot, context) => {
    if (snapshot.targets.length !== snapshot.methodology.targetCount) {
      context.addIssue({ code: "custom", path: ["targets"], message: "Target count does not match methodology" });
    }
    if (snapshot.targets.some((target) => (
      target.requestedSamples !== snapshot.methodology.sampleCountPerModel
    ))) {
      context.addIssue({
        code: "custom",
        path: ["targets"],
        message: "Every target must use the frozen sample count",
      });
    }
    if (new Set(snapshot.targets.map((target) => target.competitorRevisionId)).size !== snapshot.targets.length) {
      context.addIssue({ code: "custom", path: ["targets"], message: "Target competitor revisions must be unique" });
    }
  });

export type DecisionBranchSnapshotV1 = z.infer<typeof decisionBranchSnapshotV1Schema>;
export type StoredDecisionBranchSnapshot = DecisionBranchSnapshotV1;

const storedDecisionBranchSnapshotSchemas: Readonly<
  Record<string, z.ZodType<StoredDecisionBranchSnapshot>>
> = {
  [DECISION_BRANCH_SNAPSHOT_V1]: decisionBranchSnapshotV1Schema,
};

export const storedDecisionBranchSnapshotSchema = z.unknown().transform((raw, context) => {
  const version = raw !== null && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>).version
    : null;
  const schema = typeof version === "string" ? storedDecisionBranchSnapshotSchemas[version] : undefined;
  if (!schema) {
    context.addIssue({ code: "custom", message: `Unsupported decision branch snapshot version: ${String(version)}` });
    return z.NEVER;
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    context.addIssue({ code: "custom", message: `Invalid ${String(version)} decision branch snapshot: ${parsed.error.message}` });
    return z.NEVER;
  }
  return parsed.data;
});

export const decisionBranchPublicationSchema = z.object({
  id: z.string().uuid(),
  handForkId: z.string().uuid(),
  status: decisionBranchPublicationStatusSchema,
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(120).nullable(),
  titleZh: z.string().trim().min(1).max(140).nullable(),
  titleEn: z.string().trim().min(1).max(140).nullable(),
  summaryZh: z.string().trim().min(1).max(500).nullable(),
  summaryEn: z.string().trim().min(1).max(500).nullable(),
  snapshotVersion: z.string().trim().min(1).max(120),
  snapshotHash: sha256Schema,
  snapshot: storedDecisionBranchSnapshotSchema,
  revision: z.number().int().positive(),
  createdByAdminUserId: z.string().uuid().nullable(),
  publishedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict().superRefine((publication, context) => {
  if (publication.snapshotVersion !== publication.snapshot.version) {
    context.addIssue({ code: "custom", path: ["snapshotVersion"], message: "Snapshot version columns must agree" });
  }
  if (publication.status === "PUBLISHED" && (
    publication.slug === null
    || (publication.titleZh === null && publication.titleEn === null)
    || publication.publishedAt === null
  )) {
    context.addIssue({ code: "custom", path: ["status"], message: "Published branches require public metadata" });
  }
  if ((publication.status === "DRAFT") !== (publication.publishedAt === null)) {
    context.addIssue({ code: "custom", path: ["publishedAt"], message: "Only never-published drafts omit publishedAt" });
  }
});

export type DecisionBranchPublication = z.infer<typeof decisionBranchPublicationSchema>;

export const decisionBranchEditorialPatchSchema = z.object({
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(120).nullable().optional(),
  titleZh: z.string().trim().min(1).max(140).nullable().optional(),
  titleEn: z.string().trim().min(1).max(140).nullable().optional(),
  summaryZh: z.string().trim().min(1).max(500).nullable().optional(),
  summaryEn: z.string().trim().min(1).max(500).nullable().optional(),
}).strict();

export type DecisionBranchEditorialPatch = z.infer<typeof decisionBranchEditorialPatchSchema>;

export const publicDecisionBranchDtoSchema = z.object({
  id: z.string().uuid(),
  status: z.literal("PUBLISHED"),
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(120),
  titleZh: z.string().nullable(),
  titleEn: z.string().nullable(),
  summaryZh: z.string().nullable(),
  summaryEn: z.string().nullable(),
  publicationRevision: z.number().int().positive(),
  publishedAt: z.string().datetime(),
  snapshot: storedDecisionBranchSnapshotSchema,
}).strict();

export type PublicDecisionBranchDto = z.infer<typeof publicDecisionBranchDtoSchema>;

export const decisionBranchRelatedPlayerRoleSchema = z.enum([
  "DECISION_MAKER",
  "COMPARED_MODEL",
]);
export type DecisionBranchRelatedPlayerRole = z.infer<
  typeof decisionBranchRelatedPlayerRoleSchema
>;

export const publicDecisionBranchSummaryHeroSchema = z.object({
  competitorId: z.string().uuid().nullable(),
  displayName: boundedNameSchema,
  position: z.string().trim().min(1).max(32),
  providerBrand: providerBrandSchema.nullable(),
}).strict();

export const publicDecisionBranchSummaryOriginalDecisionSchema = z.object({
  action: pokerActionSchema,
  displayAmountTo: z.number().int().positive().nullable(),
}).strict().superRefine((decision, context) => {
  const sized = decision.action === "bet"
    || decision.action === "raise"
    || decision.action === "all_in";
  if (sized !== (decision.displayAmountTo !== null)) {
    context.addIssue({
      code: "custom",
      path: ["displayAmountTo"],
      message: "Bet, raise, and all-in summaries require a display amount",
    });
  }
});

export const publicDecisionBranchSummaryTargetSchema = z.object({
  ordinal: z.number().int().min(1).max(9),
  competitorId: z.string().uuid(),
  displayName: boundedNameSchema,
  providerBrand: providerBrandSchema.nullable(),
  modelActionTrials: z.number().int().nonnegative(),
  fallbackTrials: z.number().int().nonnegative(),
  infrastructureErrorTrials: z.number().int().nonnegative(),
  actionDistribution: z.array(decisionBranchActionDistributionEntrySchema).max(6),
}).strict().superRefine((target, context) => {
  const distributionTotal = target.actionDistribution.reduce((sum, entry) => sum + entry.count, 0);
  if (distributionTotal !== target.modelActionTrials) {
    context.addIssue({
      code: "custom",
      path: ["actionDistribution"],
      message: "Summary distributions must use model actions only",
    });
  }
  if (new Set(target.actionDistribution.map((entry) => entry.action)).size
    !== target.actionDistribution.length) {
    context.addIssue({
      code: "custom",
      path: ["actionDistribution"],
      message: "Summary distribution actions must be unique",
    });
  }
  for (let index = 0; index < target.actionDistribution.length; index += 1) {
    const entry = target.actionDistribution[index]!;
    const expectedShare = target.modelActionTrials === 0 ? 0 : entry.count / target.modelActionTrials;
    if (Math.abs(entry.share - expectedShare) > 1e-12) {
      context.addIssue({
        code: "custom",
        path: ["actionDistribution", index, "share"],
        message: "Summary action shares must use model actions as their denominator",
      });
    }
  }
});

export const publicDecisionBranchSummarySchema = z.object({
  id: z.string().uuid(),
  status: z.literal("PUBLISHED"),
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(120),
  titleZh: z.string().trim().min(1).max(140).nullable(),
  titleEn: z.string().trim().min(1).max(140).nullable(),
  summaryZh: z.string().trim().min(1).max(500).nullable(),
  summaryEn: z.string().trim().min(1).max(500).nullable(),
  publishedAt: z.string().datetime(),
  tournamentId: z.string().uuid(),
  tournamentName: boundedNameSchema,
  handNo: z.number().int().positive(),
  actionSequence: z.number().int().positive(),
  street: z.enum(["PREFLOP", "FLOP", "TURN", "RIVER"]),
  hero: publicDecisionBranchSummaryHeroSchema,
  originalDecision: publicDecisionBranchSummaryOriginalDecisionSchema,
  targetCount: z.number().int().min(1).max(9),
  sampleCountPerModel: z.number().int().min(1).max(20),
  targets: z.array(publicDecisionBranchSummaryTargetSchema).min(1).max(9),
  relatedPlayerRoles: z.array(decisionBranchRelatedPlayerRoleSchema).max(2),
}).strict().superRefine((summary, context) => {
  if (summary.titleZh === null && summary.titleEn === null) {
    context.addIssue({
      code: "custom",
      path: ["titleZh"],
      message: "A public decision branch summary requires a localized title",
    });
  }
  if (summary.targets.length !== summary.targetCount) {
    context.addIssue({
      code: "custom",
      path: ["targets"],
      message: "Summary target count must match its targets",
    });
  }
  if (new Set(summary.targets.map((target) => target.ordinal)).size !== summary.targets.length) {
    context.addIssue({
      code: "custom",
      path: ["targets"],
      message: "Summary target ordinals must be unique",
    });
  }
  for (let index = 0; index < summary.targets.length; index += 1) {
    const target = summary.targets[index]!;
    const completed = target.modelActionTrials
      + target.fallbackTrials
      + target.infrastructureErrorTrials;
    if (completed !== summary.sampleCountPerModel) {
      context.addIssue({
        code: "custom",
        path: ["targets", index],
        message: "Every summary target must use the common sample count",
      });
    }
  }
  if (new Set(summary.relatedPlayerRoles).size !== summary.relatedPlayerRoles.length) {
    context.addIssue({
      code: "custom",
      path: ["relatedPlayerRoles"],
      message: "Related player roles must be unique",
    });
  }
});

export type PublicDecisionBranchSummary = z.infer<typeof publicDecisionBranchSummarySchema>;
