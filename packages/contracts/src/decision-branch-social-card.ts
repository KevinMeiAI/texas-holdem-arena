import { z } from "zod";
import { pokerActionSchema } from "./model-protocol.js";
import { providerBrandSchema } from "./provider-brand.js";

export const DECISION_BRANCH_SOCIAL_CARD_PROJECTION_VERSION =
  "decision-branch-social-card-projection-v1";
export const DECISION_BRANCH_SOCIAL_CARD_RENDERER_VERSION =
  "decision-branch-social-card-renderer-v1";
export const DECISION_BRANCH_SOCIAL_CARD_URL_VERSION = "v1";
export const DECISION_BRANCH_SOCIAL_CARD_SIZE = Object.freeze({ width: 1_200, height: 675 });
export const DECISION_BRANCH_SOCIAL_CARD_ACTION_ORDER = [
  "fold",
  "check",
  "call",
  "bet",
  "raise",
  "all_in",
] as const;

const actionOrder = new Map(
  DECISION_BRANCH_SOCIAL_CARD_ACTION_ORDER.map((action, index) => [action, index]),
);
const printableAscii = (maximum: number) => z.string()
  .trim()
  .min(1)
  .max(maximum)
  .regex(/^[\x20-\x7e]+$/);
const cardCodeSchema = z.string().regex(/^[2-9TJQKA][cdhs]$/);
const nullableRateSchema = z.number().min(0).max(1).nullable();

export const decisionBranchSocialCardHeroSchema = z.object({
  displayName: printableAscii(120),
  position: printableAscii(32),
  holeCards: z.array(cardCodeSchema).length(2),
  stackChips: z.number().int().nonnegative(),
  stackBigBlinds: z.number().nonnegative(),
}).strict();

export const decisionBranchSocialCardOriginalDecisionSchema = z.object({
  action: pokerActionSchema,
  displayAmountTo: z.number().int().positive().nullable(),
}).strict().superRefine((decision, context) => {
  const sizedAction = decision.action === "bet"
    || decision.action === "raise"
    || decision.action === "all_in";
  if (sizedAction !== (decision.displayAmountTo !== null)) {
    context.addIssue({
      code: "custom",
      path: ["displayAmountTo"],
      message: "Bet, raise, and all-in decisions require a display amount",
    });
  }
});

export const decisionBranchSocialCardActionDistributionEntrySchema = z.object({
  action: pokerActionSchema,
  count: z.number().int().positive(),
  share: z.number().min(0).max(1),
}).strict();

export const decisionBranchSocialCardTargetSchema = z.object({
  ordinal: z.number().int().min(1).max(9),
  displayName: printableAscii(120),
  providerBrand: providerBrandSchema.nullable(),
  validActionTrials: z.number().int().nonnegative(),
  completedTrials: z.number().int().positive(),
  fallbackTrials: z.number().int().nonnegative(),
  infrastructureErrorTrials: z.number().int().nonnegative(),
  pairwiseAgreement: nullableRateSchema,
  actionDistribution: z.array(decisionBranchSocialCardActionDistributionEntrySchema).max(6),
}).strict().superRefine((target, context) => {
  const terminalTotal = target.validActionTrials
    + target.fallbackTrials
    + target.infrastructureErrorTrials;
  if (terminalTotal !== target.completedTrials) {
    context.addIssue({
      code: "custom",
      path: ["completedTrials"],
      message: "Completed trials must equal valid actions, fallbacks, and infrastructure errors",
    });
  }
  const distributionTotal = target.actionDistribution.reduce((sum, entry) => sum + entry.count, 0);
  if (distributionTotal !== target.validActionTrials) {
    context.addIssue({
      code: "custom",
      path: ["actionDistribution"],
      message: "The action distribution must use valid model actions only",
    });
  }
  if (new Set(target.actionDistribution.map((entry) => entry.action)).size
    !== target.actionDistribution.length) {
    context.addIssue({
      code: "custom",
      path: ["actionDistribution"],
      message: "Distribution actions must be unique",
    });
  }
  for (let index = 0; index < target.actionDistribution.length; index += 1) {
    const entry = target.actionDistribution[index]!;
    const expectedShare = entry.count / target.validActionTrials;
    if (!Number.isFinite(expectedShare) || Math.abs(entry.share - expectedShare) > 1e-12) {
      context.addIssue({
        code: "custom",
        path: ["actionDistribution", index, "share"],
        message: "Action shares must use valid model actions as their denominator",
      });
    }
    if (index > 0) {
      const previous = target.actionDistribution[index - 1]!;
      if ((actionOrder.get(previous.action) ?? -1) >= (actionOrder.get(entry.action) ?? -1)) {
        context.addIssue({
          code: "custom",
          path: ["actionDistribution", index, "action"],
          message: "Action distributions must use canonical poker-action order",
        });
      }
    }
  }
  if ((target.validActionTrials < 2) !== (target.pairwiseAgreement === null)) {
    context.addIssue({
      code: "custom",
      path: ["pairwiseAgreement"],
      message: "Pairwise agreement requires at least two valid model actions",
    });
  }
});

export const decisionBranchSocialCardProjectionSchema = z.object({
  version: z.literal(DECISION_BRANCH_SOCIAL_CARD_PROJECTION_VERSION),
  locale: z.enum(["zh-CN", "en"]),
  tournamentName: printableAscii(120),
  handNo: z.number().int().positive(),
  street: z.enum(["PREFLOP", "FLOP", "TURN", "RIVER"]),
  title: printableAscii(140),
  hero: decisionBranchSocialCardHeroSchema,
  board: z.array(cardCodeSchema).max(5),
  potBeforeActionChips: z.number().int().nonnegative(),
  potBeforeActionBigBlinds: z.number().nonnegative(),
  callAmountChips: z.number().int().nonnegative(),
  callAmountBigBlinds: z.number().nonnegative(),
  originalDecision: decisionBranchSocialCardOriginalDecisionSchema,
  sampleCountPerModel: z.number().int().min(1).max(20),
  targetCount: z.number().int().min(1).max(9),
  displayedTargets: z.array(decisionBranchSocialCardTargetSchema).min(1).max(4),
  additionalTargetCount: z.number().int().nonnegative(),
  completedAt: z.string().datetime(),
}).strict().superRefine((projection, context) => {
  const expectedBoardLength = projection.street === "PREFLOP" ? 0
    : projection.street === "FLOP" ? 3
      : projection.street === "TURN" ? 4 : 5;
  if (projection.board.length !== expectedBoardLength) {
    context.addIssue({
      code: "custom",
      path: ["board"],
      message: "Board length must match the decision street",
    });
  }
  if (new Set([...projection.hero.holeCards, ...projection.board]).size
    !== projection.hero.holeCards.length + projection.board.length) {
    context.addIssue({
      code: "custom",
      path: ["board"],
      message: "Known cards must be unique",
    });
  }
  const expectedDisplayed = Math.min(4, projection.targetCount);
  if (projection.displayedTargets.length !== expectedDisplayed
    || projection.additionalTargetCount !== projection.targetCount - expectedDisplayed) {
    context.addIssue({
      code: "custom",
      path: ["displayedTargets"],
      message: "The card must contain the first four targets and an exact remainder count",
    });
  }
  const ordinals = projection.displayedTargets.map((target) => target.ordinal);
  if (new Set(ordinals).size !== ordinals.length
    || ordinals.some((ordinal, index) => index > 0 && ordinal <= ordinals[index - 1]!)) {
    context.addIssue({
      code: "custom",
      path: ["displayedTargets"],
      message: "Displayed target ordinals must be unique and ascending",
    });
  }
  for (let index = 0; index < projection.displayedTargets.length; index += 1) {
    if (projection.displayedTargets[index]!.completedTrials !== projection.sampleCountPerModel) {
      context.addIssue({
        code: "custom",
        path: ["displayedTargets", index, "completedTrials"],
        message: "Every displayed target must use the common sample count",
      });
    }
  }
});

export type DecisionBranchSocialCardHero = z.infer<typeof decisionBranchSocialCardHeroSchema>;
export type DecisionBranchSocialCardOriginalDecision = z.infer<
  typeof decisionBranchSocialCardOriginalDecisionSchema
>;
export type DecisionBranchSocialCardActionDistributionEntry = z.infer<
  typeof decisionBranchSocialCardActionDistributionEntrySchema
>;
export type DecisionBranchSocialCardTarget = z.infer<typeof decisionBranchSocialCardTargetSchema>;
export type DecisionBranchSocialCardProjection = z.infer<
  typeof decisionBranchSocialCardProjectionSchema
>;

export function parseDecisionBranchSocialCardProjection(
  input: unknown,
): DecisionBranchSocialCardProjection {
  return decisionBranchSocialCardProjectionSchema.parse(input);
}
