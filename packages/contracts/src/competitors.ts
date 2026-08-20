import { z } from "zod";
import { publicMomentDtoSchema } from "./moments.js";

export const providerBrandSchema = z.enum([
  "chatgpt",
  "claude",
  "deepseek",
  "doubao",
  "gemini",
  "glm",
  "hunyuan",
  "kimi",
  "minimax",
  "qwen",
  "wenxin",
  "xai",
]);

export type ProviderBrand = z.infer<typeof providerBrandSchema>;

const nullableRateSchema = z.number().min(0).max(1).nullable();
const competitorStatusSchema = z.enum(["ACTIVE", "RETIRED"]);
const eventClassSchema = z.enum(["RATED", "EXHIBITION"]);
const styleProfileSchema = z.enum(["紧凶", "紧稳", "均衡", "松凶", "松稳"]);

export const publicCompetitorRevisionSchema = z.object({
  id: z.string().uuid(),
  revisionNumber: z.number().int().positive(),
  modelId: z.string().min(1).max(200),
  displayNameAtRevision: z.string().min(1).max(120),
  createdAt: z.string().datetime(),
}).strict();

export const publicCompetitorResultSchema = z.object({
  tournamentId: z.string().uuid(),
  name: z.string().min(1).max(120),
  eventClass: eventClassSchema,
  benchmarkCohortId: z.string().min(1),
  benchmarkTrackId: z.string().min(1),
  completedAt: z.string().datetime(),
  competitorRevisionId: z.string().uuid(),
  displayNameAtEntry: z.string().min(1).max(120),
  providerBrand: providerBrandSchema.nullable(),
  fieldSize: z.number().int().min(2).max(9),
  finishingPosition: z.number().int().min(1).max(9),
  handsPlayed: z.number().int().nonnegative(),
  netBigBlinds: z.number(),
  peakStackBigBlinds: z.number().nonnegative(),
  // A split elimination is credited fractionally when multiple winners share
  // the pot that removes a player.
  knockouts: z.number().nonnegative(),
  validDecisionRate: nullableRateSchema,
  firstPassRate: nullableRateSchema,
  totalTokens: z.number().int().nonnegative().nullable(),
  tokenUsageCoverage: nullableRateSchema,
  countedInCurrentRanking: z.boolean(),
}).strict();

export const publicCompetitorProfileSchema = z.object({
  schemaVersion: z.literal("arena-competitor-profile-v1"),
  competitor: z.object({
    id: z.string().uuid(),
    displayName: z.string().min(1).max(120),
    status: competitorStatusSchema,
    providerBrand: providerBrandSchema.nullable(),
    currentRevision: publicCompetitorRevisionSchema.nullable(),
    revisionCount: z.number().int().nonnegative(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  }).strict(),
  competitiveScope: z.object({
    eventClass: z.literal("RATED"),
    benchmarkCohortId: z.string().min(1).nullable(),
    rankedCompetitors: z.number().int().nonnegative(),
  }).strict(),
  competition: z.object({
    rank: z.number().int().positive().nullable(),
    rating: z.number().int().nullable(),
    points: z.number().nonnegative(),
    tournaments: z.number().int().nonnegative(),
    championships: z.number().int().nonnegative(),
    championshipRate: nullableRateSchema,
    topThree: z.number().int().nonnegative(),
    topThreeRate: nullableRateSchema,
    averageFinish: z.number().positive().nullable(),
    sampleWarning: z.boolean(),
  }).strict(),
  style: z.object({
    handsPlayed: z.number().int().nonnegative(),
    vpipRate: nullableRateSchema,
    pfrRate: nullableRateSchema,
    threeBetRate: nullableRateSchema,
    showdownWinRate: nullableRateSchema,
    profile: styleProfileSchema.nullable(),
    sampleWarning: z.boolean(),
  }).strict(),
  reliability: z.object({
    decisions: z.number().int().nonnegative(),
    validDecisionRate: nullableRateSchema,
    firstPassRate: nullableRateSchema,
    protocolCorrections: z.number().int().nonnegative(),
    fallbacks: z.number().int().nonnegative(),
    timeouts: z.number().int().nonnegative(),
    infrastructurePauses: z.number().int().nonnegative(),
    sampleWarning: z.boolean(),
  }).strict(),
  efficiency: z.object({
    providerCalls: z.number().int().nonnegative(),
    averageLatencyMs: z.number().nonnegative().nullable(),
    p95LatencyMs: z.number().nonnegative().nullable(),
    totalTokens: z.number().int().nonnegative().nullable(),
    tokensPerDecision: z.number().nonnegative().nullable(),
    tokenUsageCoverage: nullableRateSchema,
    sampleWarning: z.boolean(),
  }).strict(),
  consistency: z.object({
    runId: z.string().uuid(),
    competitorRevisionId: z.string().uuid(),
    tier: z.enum(["single", "quick", "standard", "full"]),
    scenarioRegistryVersion: z.string().min(1),
    promptName: z.string().min(1).max(120),
    validityRate: nullableRateSchema,
    meanDominantShare: nullableRateSchema,
    meanPairwiseAgreement: nullableRateSchema,
    completedSamples: z.number().int().nonnegative(),
    scenarioCount: z.number().int().positive(),
    completedAt: z.string().datetime(),
  }).strict().nullable(),
  career: z.object({
    appearances: z.number().int().nonnegative(),
    ratedAppearances: z.number().int().nonnegative(),
    exhibitionAppearances: z.number().int().nonnegative(),
    wins: z.number().int().nonnegative(),
    podiums: z.number().int().nonnegative(),
    handsPlayed: z.number().int().nonnegative(),
    decisions: z.number().int().nonnegative(),
    firstPlayedAt: z.string().datetime().nullable(),
    lastPlayedAt: z.string().datetime().nullable(),
  }).strict(),
  recentResults: z.array(publicCompetitorResultSchema).max(50),
  featuredMoments: z.array(publicMomentDtoSchema).max(12),
  methodology: z.object({
    competition: z.string().min(1),
    career: z.string().min(1),
    consistency: z.string().min(1),
  }).strict(),
}).strict();

export type PublicCompetitorProfile = z.infer<typeof publicCompetitorProfileSchema>;
export type PublicCompetitorResult = z.infer<typeof publicCompetitorResultSchema>;
