import { z } from "zod";
import { providerBrandSchema } from "./provider-brand.js";

export const MOMENT_SOCIAL_CARD_PROJECTION_VERSION = "moment-social-card-projection-v1";
export const MOMENT_SOCIAL_CARD_RENDERER_VERSION = "moment-social-card-renderer-v1";
// This is the public cache identity. Any projection or renderer change that
// can alter bytes must advance this value and the route tests together.
export const MOMENT_SOCIAL_CARD_URL_VERSION = "v1";
export const MOMENT_SOCIAL_CARD_SIZE = Object.freeze({ width: 1_200, height: 675 });

const boundedText = (maximum: number) => z.string().trim().min(1).max(maximum);
const cardCodeSchema = z.string().regex(/^[2-9TJQKA][cdhs]$/);

const commonPlayerShape = {
  playerId: boundedText(200),
  displayName: boundedText(120),
  seat: z.number().int().min(0).max(8),
  providerBrand: providerBrandSchema.nullable(),
  position: boundedText(24).nullable(),
} satisfies z.ZodRawShape;

export const suspenseSocialCardPlayerSchema = z.object({
  ...commonPlayerShape,
  // These values are taken only from the validated causal cover frame. Their
  // names intentionally cannot be confused with terminal tournament facts.
  coverStack: z.number().int().nonnegative().nullable(),
  coverEquityPercent: z.number().min(0).max(100).nullable(),
  foldedAtCover: z.boolean().nullable(),
  allInAtCover: z.boolean().nullable(),
}).strict();

export const resultSocialCardPlayerSchema = z.object({
  ...commonPlayerShape,
  revealedHoleCards: z.array(cardCodeSchema).max(2),
  endingStack: z.number().int().nonnegative().nullable(),
}).strict();

export const resultSocialCardWinnerSchema = z.object({
  playerId: boundedText(200),
  displayName: boundedText(120),
  netChange: z.number().int(),
}).strict();

const commonProjectionShape = {
  version: z.literal(MOMENT_SOCIAL_CARD_PROJECTION_VERSION),
  locale: z.enum(["zh-CN", "en"]),
  tournamentName: boundedText(120),
  handNo: z.number().int().positive(),
  title: boundedText(140),
  summary: boundedText(500).nullable(),
  tagLabel: boundedText(80),
  additionalPlayerCount: z.number().int().nonnegative(),
} satisfies z.ZodRawShape;

/**
 * A suspense projection is a deliberately narrow causal snapshot. It has no
 * property capable of carrying winners, final board cards, ending stacks, or
 * net changes. Unknown cover details stay null/empty and render neutrally.
 */
export const suspenseSocialCardProjectionSchema = z.object({
  ...commonProjectionShape,
  spoilerMode: z.literal("SUSPENSE"),
  coverStreetLabel: boundedText(32).nullable(),
  coverBoard: z.array(cardCodeSchema).max(4),
  coverPotChips: z.number().int().nonnegative().nullable(),
  coverPotBigBlinds: z.number().nonnegative().nullable(),
  players: z.array(suspenseSocialCardPlayerSchema).min(1).max(3),
}).strict();

/** A result projection may carry the immutable terminal outcome. */
export const resultSocialCardProjectionSchema = z.object({
  ...commonProjectionShape,
  spoilerMode: z.literal("RESULT"),
  finalStreetLabel: boundedText(32),
  finalBoard: z.array(cardCodeSchema).max(5),
  finalPotChips: z.number().int().nonnegative(),
  finalPotBigBlinds: z.number().nonnegative(),
  players: z.array(resultSocialCardPlayerSchema).min(1).max(3),
  winners: z.array(resultSocialCardWinnerSchema).min(1).max(9),
}).strict();

export const socialCardProjectionSchema = z.discriminatedUnion("spoilerMode", [
  suspenseSocialCardProjectionSchema,
  resultSocialCardProjectionSchema,
]);

export type SuspenseSocialCardPlayer = z.infer<typeof suspenseSocialCardPlayerSchema>;
export type ResultSocialCardPlayer = z.infer<typeof resultSocialCardPlayerSchema>;
export type ResultSocialCardWinner = z.infer<typeof resultSocialCardWinnerSchema>;
export type SuspenseSocialCardProjection = z.infer<typeof suspenseSocialCardProjectionSchema>;
export type ResultSocialCardProjection = z.infer<typeof resultSocialCardProjectionSchema>;
export type SocialCardProjection = z.infer<typeof socialCardProjectionSchema>;

export function parseSocialCardProjection(input: unknown): SocialCardProjection {
  return socialCardProjectionSchema.parse(input);
}
