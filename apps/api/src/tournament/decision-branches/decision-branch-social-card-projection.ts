import {
  DECISION_BRANCH_SOCIAL_CARD_ACTION_ORDER,
  DECISION_BRANCH_SOCIAL_CARD_PROJECTION_VERSION,
  parseDecisionBranchSocialCardProjection,
  type DecisionBranchSocialCardProjection,
  type PublicDecisionBranchDto,
} from "../../../../../packages/contracts/src/index.js";

export type DecisionBranchSocialCardLocale = "zh-CN" | "en";

const ASCII_REPLACEMENTS: Readonly<Record<string, string>> = {
  "’": "'",
  "‘": "'",
  "“": "'",
  "”": "'",
  "–": "-",
  "—": "-",
  "·": "-",
  "×": "x",
};

function asciiVisualText(value: string | null, fallback: string, maximum: number): string {
  const normalized = (value ?? "")
    .normalize("NFKD")
    .split("")
    .map((character) => ASCII_REPLACEMENTS[character] ?? character)
    .join("")
    .replace(/[^\x20-\x7e]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const selected = /[A-Za-z0-9]/.test(normalized) ? normalized : fallback;
  if (selected.length <= maximum) return selected;
  return `${selected.slice(0, maximum - 3).trimEnd()}...`;
}

function streetLabel(street: PublicDecisionBranchDto["snapshot"]["source"]["street"]): string {
  const labels = {
    PREFLOP: "Pre-flop",
    FLOP: "Flop",
    TURN: "Turn",
    RIVER: "River",
  } as const;
  return labels[street];
}

function originalDisplayAmount(
  source: PublicDecisionBranchDto["snapshot"]["source"],
): number | null {
  if (source.originalDecision.action === "bet" || source.originalDecision.action === "raise") {
    return source.originalDecision.amountTo;
  }
  if (source.originalDecision.action === "all_in") {
    const amount = source.legalActions.all_in?.resulting_street_commitment ?? null;
    if (amount === null) throw new Error("A published all-in decision requires its frozen total commitment");
    return amount;
  }
  return null;
}

export function buildDecisionBranchSocialCardProjection(input: {
  branch: PublicDecisionBranchDto;
  locale: DecisionBranchSocialCardLocale;
}): DecisionBranchSocialCardProjection {
  const { branch, locale } = input;
  const { source, methodology } = branch.snapshot;
  const hero = source.players.find((player) => player.playerId === source.heroPlayerId);
  if (!hero) throw new Error("Decision branch social card source has no hero");
  const targets = [...branch.snapshot.targets]
    .sort((left, right) => left.ordinal - right.ordinal)
    .slice(0, 4)
    .map((target) => ({
      ordinal: target.ordinal,
      displayName: asciiVisualText(target.displayName, `MODEL ${target.ordinal}`, 120),
      providerBrand: target.providerBrand,
      validActionTrials: target.modelActionTrials,
      completedTrials: target.completedTrials,
      fallbackTrials: target.fallbackTrials,
      infrastructureErrorTrials: target.infrastructureErrorTrials,
      pairwiseAgreement: target.pairwiseAgreement,
      actionDistribution: DECISION_BRANCH_SOCIAL_CARD_ACTION_ORDER.flatMap((action) => {
        const entry = target.actionDistribution.find((candidate) => candidate.action === action);
        return entry ? [{
          action,
          count: entry.count,
          share: entry.count / target.modelActionTrials,
        }] : [];
      }),
    }));
  const titleFallback = `Hand ${source.handNo} - ${streetLabel(source.street)} decision branch`;
  const targetCount = branch.snapshot.targets.length;
  return parseDecisionBranchSocialCardProjection({
    version: DECISION_BRANCH_SOCIAL_CARD_PROJECTION_VERSION,
    locale,
    tournamentName: asciiVisualText(source.tournamentName, "MODEL POKER TOURNAMENT", 120),
    handNo: source.handNo,
    street: source.street,
    title: asciiVisualText(branch.titleEn, titleFallback, 140),
    hero: {
      displayName: asciiVisualText(source.heroDisplayName, "SOURCE MODEL", 120),
      position: asciiVisualText(source.heroPosition, `SEAT ${hero.seat + 1}`, 32),
      holeCards: [...source.heroHoleCards],
      stackChips: hero.stack,
      stackBigBlinds: hero.stackBigBlinds,
    },
    board: [...source.board],
    potBeforeActionChips: source.potBeforeAction,
    potBeforeActionBigBlinds: source.potBigBlinds,
    callAmountChips: source.callAmount,
    callAmountBigBlinds: source.callAmount / source.blinds.bigBlind,
    originalDecision: {
      action: source.originalDecision.action,
      displayAmountTo: originalDisplayAmount(source),
    },
    sampleCountPerModel: methodology.sampleCountPerModel,
    targetCount,
    displayedTargets: targets,
    additionalTargetCount: Math.max(0, targetCount - targets.length),
    completedAt: methodology.completedAt,
  });
}
