import { z } from "zod";

// Historical IDs are immutable. Current aliases may advance only alongside a
// newly registered schema or algorithm implementation.
export const MOMENT_FACTS_V1 = "arena-moment-facts-v1";
export const MOMENT_DETECTOR_V1 = "arena-moment-detector-v1";
export const MOMENT_DETECTOR_V2 = "arena-moment-detector-v2";
export const MOMENT_SCORING_V1 = "arena-moment-scoring-v1";
export const MOMENT_FACTS_VERSION = MOMENT_FACTS_V1;
export const MOMENT_DETECTOR_VERSION = MOMENT_DETECTOR_V2;
export const MOMENT_SCORING_VERSION = MOMENT_SCORING_V1;

export const momentTagSchema = z.enum([
  "FINAL_HAND",
  "ELIMINATION",
  "MULTI_ELIMINATION",
  "HEADS_UP_REACHED",
  "ALL_IN",
  "MULTIWAY_ALL_IN",
  "LARGE_POT",
  "LEAD_CHANGE",
  "SHORT_STACK_DOUBLE",
  "FOUR_BET_PLUS",
  "OVERBET",
  "SIDE_POT",
  "SPLIT_POT",
  "MULTIWAY_SHOWDOWN",
  "EQUITY_REVERSAL",
  "ALL_IN_UNDERDOG_WIN",
  "RARE_MADE_HAND",
  "LONG_TANK",
]);

export type MomentTag = z.infer<typeof momentTagSchema>;

export const momentScoreBreakdownSchema = z.object({
  potImpact: z.number().int().min(0).max(22),
  tournamentImpact: z.number().int().min(0).max(32),
  actionDrama: z.number().int().min(0).max(18),
  equityDrama: z.number().int().min(0).max(20),
  rarity: z.number().int().min(0).max(8),
}).strict();

export type MomentScoreBreakdown = z.infer<typeof momentScoreBreakdownSchema>;

export const momentActionFactSchema = z.object({
  sequence: z.number().int().positive(),
  street: z.string().min(1).max(32),
  playerId: z.string().min(1).max(200),
  action: z.string().min(1).max(40),
  classification: z.string().min(1).max(40),
  paid: z.number().int().nonnegative(),
  amountTo: z.number().int().nonnegative(),
}).strict();

export type MomentActionFact = z.infer<typeof momentActionFactSchema>;

const momentEquityPlayerSchema = z.object({
  playerId: z.string().min(1).max(200),
  equity: z.number().min(0).max(1),
}).strict();

export const momentAllInLockSchema = z.object({
  sequence: z.number().int().positive(),
  street: z.string().min(1).max(32),
  board: z.array(z.string().regex(/^[2-9TJQKA][cdhs]$/)).max(5),
  participantPlayerIds: z.array(z.string().min(1).max(200)).min(2),
  equities: z.array(momentEquityPlayerSchema).min(2),
  estimated: z.boolean(),
  samples: z.number().int().nonnegative(),
}).strict();

export type MomentAllInLock = z.infer<typeof momentAllInLockSchema>;

export const momentEquityTransitionSchema = z.object({
  fromSequence: z.number().int().positive(),
  toSequence: z.number().int().positive(),
  fromStreet: z.string().min(1).max(32),
  toStreet: z.string().min(1).max(32),
  participantPlayerIds: z.array(z.string().min(1).max(200)).min(2),
  leaderBefore: z.string().min(1).max(200),
  leaderAfter: z.string().min(1).max(200),
  maxAbsoluteDelta: z.number().min(0).max(1),
  estimated: z.boolean(),
  samples: z.number().int().nonnegative(),
}).strict().refine(
  (transition) => transition.toSequence > transition.fromSequence,
  "Equity transition must move forward in the event stream",
);

export type MomentEquityTransition = z.infer<typeof momentEquityTransitionSchema>;

const sourceFingerprintSchema = z.object({
  eventHash: z.string().regex(/^[a-f0-9]{64}$/),
  eventCount: z.number().int().positive(),
  startEventHash: z.string().regex(/^[a-f0-9]{64}$/),
  endEventHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

const stackRecordSchema = z.record(
  z.string().min(1).max(200),
  z.number().int().nonnegative(),
);

const signedStackRecordSchema = z.record(
  z.string().min(1).max(200),
  z.number().int(),
);

const tournamentMomentFactsV1Shape = {
  id: z.string().uuid(),
  tournamentId: z.string().uuid(),
  handNo: z.number().int().positive(),
  startSequence: z.number().int().positive(),
  focusSequence: z.number().int().positive(),
  endSequence: z.number().int().positive(),
  factsVersion: z.literal(MOMENT_FACTS_V1),
  // These identify the algorithms that produced a v1-shaped fact record.
  // They are intentionally not current-version literals: an old published
  // URL must remain readable after either algorithm advances.
  detectorVersion: z.string().trim().min(1).max(120),
  scoringVersion: z.string().trim().min(1).max(120),
  broadcastViewVersion: z.string().min(1).max(120),
  equityVersion: z.string().min(1).max(120),
  source: sourceFingerprintSchema,
  score: z.number().int().min(0).max(100),
  scoreBreakdown: momentScoreBreakdownSchema,
  recommendationRank: z.number().int().positive().nullable(),
  primaryTag: momentTagSchema,
  tags: z.array(momentTagSchema).min(1),
  participantPlayerIds: z.array(z.string().min(1).max(200)).min(2),
  featuredPlayerIds: z.array(z.string().min(1).max(200)).min(1),
  winnerPlayerIds: z.array(z.string().min(1).max(200)).min(1),
  eliminatedPlayerIds: z.array(z.string().min(1).max(200)),
  showdownPlayerIds: z.array(z.string().min(1).max(200)),
  board: z.array(z.string().regex(/^[2-9TJQKA][cdhs]$/)).max(5),
  bigBlind: z.number().int().positive(),
  potChips: z.number().int().positive(),
  potBigBlinds: z.number().nonnegative(),
  totalChipShare: z.number().min(0).max(1),
  startingStacks: stackRecordSchema,
  endingStacks: stackRecordSchema,
  netChanges: signedStackRecordSchema,
  actionCount: z.number().int().nonnegative(),
  preflopRaiseCount: z.number().int().nonnegative(),
  overbetSequences: z.array(z.number().int().positive()),
  sidePotCount: z.number().int().nonnegative(),
  splitPot: z.boolean(),
  leadChange: z.boolean(),
  maxDecisionLatencyMs: z.number().int().nonnegative().nullable(),
  winningHandCategories: z.array(z.enum([
    "FULL_HOUSE",
    "FOUR_OF_A_KIND",
    "STRAIGHT_FLUSH",
  ])),
  actions: z.array(momentActionFactSchema),
  allInLock: momentAllInLockSchema.nullable(),
  equityTransitions: z.array(momentEquityTransitionSchema),
} satisfies z.ZodRawShape;

function validateMomentFactsV1(
  moment: z.infer<z.ZodObject<typeof tournamentMomentFactsV1Shape>>,
  context: z.RefinementCtx,
): void {
  if (!(moment.startSequence <= moment.focusSequence && moment.focusSequence <= moment.endSequence)) {
    context.addIssue({ code: "custom", message: "Moment focus must be inside its event window" });
  }
  if (!moment.tags.includes(moment.primaryTag)) {
    context.addIssue({ code: "custom", message: "Moment primary tag must be included in tags" });
  }
  if (new Set(moment.tags).size !== moment.tags.length) {
    context.addIssue({ code: "custom", message: "Moment tags must be unique" });
  }
}

// Never mutate a historical shape in place. A future facts v2 should add a
// sibling schema and register it in storedMomentFactsSchemas below.
export const tournamentMomentFactsV1Schema = z.object(tournamentMomentFactsV1Shape)
  .strict()
  .superRefine(validateMomentFactsV1);

export type StoredTournamentMomentFacts = z.infer<typeof tournamentMomentFactsV1Schema>;

// Current writers are stricter than historical readers. This catches a missed
// version bump in the detector while keeping old algorithm versions readable.
export const tournamentMomentFactsSchema = z.object({
  ...tournamentMomentFactsV1Shape,
  factsVersion: z.literal(MOMENT_FACTS_VERSION),
  detectorVersion: z.literal(MOMENT_DETECTOR_VERSION),
  scoringVersion: z.literal(MOMENT_SCORING_VERSION),
}).strict().superRefine(validateMomentFactsV1);

export type TournamentMomentFacts = z.infer<typeof tournamentMomentFactsSchema>;

const storedMomentFactsSchemas: Readonly<
  Record<string, z.ZodType<StoredTournamentMomentFacts>>
> = {
  [MOMENT_FACTS_V1]: tournamentMomentFactsV1Schema,
};

export const storedTournamentMomentFactsSchema = z.unknown().transform((raw, context) => {
  const factsVersion = raw !== null && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>).factsVersion
    : null;
  const schema = typeof factsVersion === "string" ? storedMomentFactsSchemas[factsVersion] : undefined;
  if (!schema) {
    context.addIssue({
      code: "custom",
      message: `Unsupported tournament moment facts version: ${String(factsVersion)}`,
    });
    return z.NEVER;
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    context.addIssue({
      code: "custom",
      message: `Invalid ${String(factsVersion)} tournament moment facts: ${parsed.error.message}`,
    });
    return z.NEVER;
  }
  return parsed.data;
});

export const momentPublicationStatusSchema = z.enum(["DRAFT", "PUBLISHED", "HIDDEN"]);
export type MomentPublicationStatus = z.infer<typeof momentPublicationStatusSchema>;

export const momentSpoilerModeSchema = z.enum(["SUSPENSE", "RESULT"]);
export type MomentSpoilerMode = z.infer<typeof momentSpoilerModeSchema>;

export const momentPublicationSchema = z.object({
  momentId: z.string().uuid(),
  status: momentPublicationStatusSchema,
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(120).nullable(),
  titleZh: z.string().trim().min(1).max(140).nullable(),
  titleEn: z.string().trim().min(1).max(140).nullable(),
  summaryZh: z.string().trim().min(1).max(500).nullable(),
  summaryEn: z.string().trim().min(1).max(500).nullable(),
  coverSequence: z.number().int().positive().nullable(),
  playbackStartSequence: z.number().int().positive().nullable(),
  playbackEndSequence: z.number().int().positive().nullable(),
  spoilerMode: momentSpoilerModeSchema,
  isPrimary: z.boolean(),
  revision: z.number().int().positive(),
  createdByAdminUserId: z.string().uuid().nullable(),
  publishedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();

export type MomentPublication = z.infer<typeof momentPublicationSchema>;

// This is the only editorial shape accepted from an HTTP caller. Identity,
// lifecycle status, and administrator provenance are injected by the API.
// Optional and nullable are intentionally distinct: omitted keeps the current
// value, while an explicit null clears an editable field.
export const momentEditorialPatchSchema = z.object({
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(120).nullable().optional(),
  titleZh: z.string().trim().min(1).max(140).nullable().optional(),
  titleEn: z.string().trim().min(1).max(140).nullable().optional(),
  summaryZh: z.string().trim().min(1).max(500).nullable().optional(),
  summaryEn: z.string().trim().min(1).max(500).nullable().optional(),
  coverSequence: z.number().int().positive().nullable().optional(),
  playbackStartSequence: z.number().int().positive().nullable().optional(),
  playbackEndSequence: z.number().int().positive().nullable().optional(),
  spoilerMode: momentSpoilerModeSchema.optional(),
  isPrimary: z.boolean().optional(),
}).strict();

export type MomentEditorialPatch = z.infer<typeof momentEditorialPatchSchema>;

// Fully resolved persistence command. Unlike the caller-facing patch above,
// every field is required so repository writes cannot silently reset omitted
// editorial choices through schema defaults.
export const momentPublicationMutationSchema = z.object({
  momentId: z.string().uuid(),
  status: momentPublicationStatusSchema,
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(120).nullable(),
  titleZh: z.string().trim().min(1).max(140).nullable(),
  titleEn: z.string().trim().min(1).max(140).nullable(),
  summaryZh: z.string().trim().min(1).max(500).nullable(),
  summaryEn: z.string().trim().min(1).max(500).nullable(),
  coverSequence: z.number().int().positive().nullable(),
  playbackStartSequence: z.number().int().positive().nullable(),
  playbackEndSequence: z.number().int().positive().nullable(),
  spoilerMode: momentSpoilerModeSchema,
  isPrimary: z.boolean(),
  createdByAdminUserId: z.string().uuid().nullable(),
}).strict();

export type MomentPublicationMutation = z.infer<typeof momentPublicationMutationSchema>;

export const adminMomentRecordSchema = z.object({
  facts: storedTournamentMomentFactsSchema,
  publication: momentPublicationSchema.nullable(),
  supersededAt: z.string().datetime().nullable(),
}).strict();

export type AdminMomentRecord = z.infer<typeof adminMomentRecordSchema>;

export const publicMomentDtoSchema = z.object({
  id: z.string().uuid(),
  tournamentId: z.string().uuid(),
  handNo: z.number().int().positive(),
  status: z.literal("PUBLISHED"),
  slug: z.string().min(1).max(120),
  titleZh: z.string().nullable(),
  titleEn: z.string().nullable(),
  summaryZh: z.string().nullable(),
  summaryEn: z.string().nullable(),
  coverSequence: z.number().int().positive(),
  playbackStartSequence: z.number().int().positive(),
  playbackEndSequence: z.number().int().positive(),
  spoilerMode: momentSpoilerModeSchema,
  isPrimary: z.boolean(),
  publicationRevision: z.number().int().positive(),
  publishedAt: z.string().datetime(),
  primaryTag: momentTagSchema,
  tags: z.array(momentTagSchema).min(1),
  score: z.number().int().min(0).max(100),
  facts: storedTournamentMomentFactsSchema,
}).strict();

export type PublicMomentDto = z.infer<typeof publicMomentDtoSchema>;
