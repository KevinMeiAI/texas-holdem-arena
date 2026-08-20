import type {
  DecisionBranchTarget,
  PublicDecisionBranchDto,
} from "../../../packages/contracts/src/decision-branches";
import type { HandForkLegalActions } from "../../../packages/contracts/src/hand-forks";
import type { UiLocale } from "./ui-preferences";

export const DECISION_BRANCH_ACTION_ORDER = [
  "fold",
  "check",
  "call",
  "bet",
  "raise",
  "all_in",
] as const;

export type DecisionBranchAction = typeof DECISION_BRANCH_ACTION_ORDER[number];

type DecisionBranchDistributionEntry = Pick<
  DecisionBranchTarget["actionDistribution"][number],
  "action" | "count"
>;

export interface DecisionBranchLocalizedCopy {
  title: string;
  summary: string | null;
}

export interface DecisionBranchCopyInput extends Pick<
  PublicDecisionBranchDto,
  "titleZh" | "titleEn" | "summaryZh" | "summaryEn"
> {
  snapshot: {
    source: {
      handNo: number;
    };
  };
}

export interface DecisionBranchLegalActionPresentation {
  action: DecisionBranchAction;
  label: string;
  detail: string | null;
  qualifier: string | null;
  text: string;
}

export interface DecisionBranchActionColumn {
  action: DecisionBranchAction;
  legal: boolean;
  original: boolean;
  observed: boolean;
}

export interface DecisionBranchActionCell {
  action: DecisionBranchAction;
  count: number;
  share: number | null;
  isModal: boolean;
}

export interface DecisionBranchActionMatrixTargetInput extends Pick<
  DecisionBranchTarget,
  | "ordinal"
  | "competitorId"
  | "displayName"
  | "modelId"
  | "providerBrand"
  | "requestedSamples"
  | "completedTrials"
  | "modelActionTrials"
  | "fallbackTrials"
  | "infrastructureErrorTrials"
  | "pairwiseAgreement"
  | "actionDistribution"
> {}

export interface DecisionBranchActionMatrixInput {
  source: {
    legalActions: Pick<HandForkLegalActions, "allowed">;
    originalDecision: {
      action: DecisionBranchAction;
      amountTo: number | null;
      usedFallback: boolean;
    };
  };
  targets: readonly DecisionBranchActionMatrixTargetInput[];
}

export interface DecisionBranchActionMatrixRow {
  ordinal: number;
  competitorId: string;
  displayName: string;
  modelId: string;
  providerBrand: DecisionBranchTarget["providerBrand"];
  cells: DecisionBranchActionCell[];
  modalActions: DecisionBranchAction[];
  pairwiseAgreement: number | null;
  requestedSamples: number;
  completedTrials: number;
  modelActionTrials: number;
  fallbackTrials: number;
  infrastructureErrorTrials: number;
  fallbackShare: number | null;
  infrastructureErrorShare: number | null;
  denominators: {
    actionDistribution: number;
    terminalOutcomes: number;
    requested: number;
  };
}

export interface DecisionBranchActionMatrix {
  columns: DecisionBranchActionColumn[];
  original: {
    action: DecisionBranchAction;
    amountTo: number | null;
    usedFallback: boolean;
  };
  rows: DecisionBranchActionMatrixRow[];
}

function trimmedOrNull(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function sortActions(actions: Iterable<DecisionBranchAction>): DecisionBranchAction[] {
  const included = new Set(actions);
  return DECISION_BRANCH_ACTION_ORDER.filter((action) => included.has(action));
}

export function localizedDecisionBranchCopy(
  branch: DecisionBranchCopyInput,
  locale: UiLocale,
): DecisionBranchLocalizedCopy {
  const localizedTitle = trimmedOrNull(locale === "zh-CN" ? branch.titleZh : branch.titleEn);
  const localizedSummary = trimmedOrNull(locale === "zh-CN" ? branch.summaryZh : branch.summaryEn);
  const hand = String(branch.snapshot.source.handNo).padStart(3, "0");
  return {
    title: localizedTitle ?? (locale === "zh-CN" ? `第 ${hand} 手 · 决策分支` : `Hand ${hand} · Decision branch`),
    summary: localizedSummary,
  };
}

export function decisionBranchActionLabel(action: DecisionBranchAction, locale: UiLocale): string {
  const labels: Record<DecisionBranchAction, [string, string]> = {
    fold: ["弃牌", "Fold"],
    check: ["过牌", "Check"],
    call: ["跟注", "Call"],
    bet: ["下注", "Bet"],
    raise: ["加注", "Raise"],
    all_in: ["全下", "All-in"],
  };
  return labels[action][locale === "zh-CN" ? 0 : 1];
}

export function formatDecisionBranchChips(value: number): string {
  return value.toLocaleString("en-US");
}

export function decisionBranchActionWithAmountLabel(
  action: DecisionBranchAction,
  amountTo: number | null,
  locale: UiLocale,
): string {
  const label = decisionBranchActionLabel(action, locale);
  if ((action !== "bet" && action !== "raise") || amountTo === null) return label;
  return locale === "zh-CN"
    ? `${label}至 ${formatDecisionBranchChips(amountTo)}`
    : `${label} to ${formatDecisionBranchChips(amountTo)}`;
}

export function decisionBranchLegalActionPresentations(
  legalActions: HandForkLegalActions,
  locale: UiLocale,
): DecisionBranchLegalActionPresentation[] {
  const classificationLabels: Record<
    NonNullable<HandForkLegalActions["all_in"]>["classification"],
    [string, string]
  > = {
    call: ["跟注", "call"],
    bet: ["下注", "bet"],
    raise: ["加注", "raise"],
    short_raise: ["短加注", "short raise"],
  };
  const localized = ([zh, en]: [string, string]) => locale === "zh-CN" ? zh : en;

  return legalActions.allowed.map((action) => {
    const label = decisionBranchActionLabel(action, locale);
    if (action === "call" && legalActions.call) {
      const detail = formatDecisionBranchChips(legalActions.call.amount);
      const qualifier = legalActions.call.will_be_all_in
        ? locale === "zh-CN" ? "全下" : "all-in"
        : null;
      return {
        action,
        label,
        detail,
        qualifier,
        text: `${label} ${detail}${qualifier ? ` · ${qualifier}` : ""}`,
      };
    }
    if ((action === "bet" || action === "raise") && legalActions[action]) {
      const bounds = legalActions[action];
      const detail = `${formatDecisionBranchChips(bounds.min_amount_to)}–${formatDecisionBranchChips(bounds.max_amount_to)}`;
      return {
        action,
        label,
        detail,
        qualifier: null,
        text: locale === "zh-CN" ? `${label}至 ${detail}` : `${label} to ${detail}`,
      };
    }
    if (action === "all_in" && legalActions.all_in) {
      const detail = formatDecisionBranchChips(legalActions.all_in.resulting_street_commitment);
      const qualifier = localized(classificationLabels[legalActions.all_in.classification]);
      return {
        action,
        label,
        detail,
        qualifier,
        text: locale === "zh-CN"
          ? `${label} ${detail}（${qualifier}）`
          : `${label} ${detail} (${qualifier})`,
      };
    }
    return { action, label, detail: null, qualifier: null, text: label };
  });
}

export function decisionBranchModalActions(
  distribution: readonly DecisionBranchDistributionEntry[],
): DecisionBranchAction[] {
  const maximum = distribution.reduce((highest, entry) => Math.max(highest, entry.count), 0);
  if (maximum <= 0) return [];
  return sortActions(distribution
    .filter((entry) => entry.count === maximum)
    .map((entry) => entry.action));
}

export function buildDecisionBranchActionMatrix(
  input: DecisionBranchActionMatrixInput,
): DecisionBranchActionMatrix {
  const legal = new Set(input.source.legalActions.allowed);
  const observed = new Set(input.targets.flatMap((target) => (
    target.actionDistribution.filter((entry) => entry.count > 0).map((entry) => entry.action)
  )));
  const columnActions = sortActions([
    ...legal,
    ...observed,
    input.source.originalDecision.action,
  ]);
  const columns = columnActions.map((action) => ({
    action,
    legal: legal.has(action),
    original: input.source.originalDecision.action === action,
    observed: observed.has(action),
  }));
  const rows = [...input.targets]
    .sort((left, right) => left.ordinal - right.ordinal)
    .map((target): DecisionBranchActionMatrixRow => {
      const counts = new Map(target.actionDistribution.map((entry) => [entry.action, entry.count]));
      const modalActions = decisionBranchModalActions(target.actionDistribution);
      const modal = new Set(modalActions);
      return {
        ordinal: target.ordinal,
        competitorId: target.competitorId,
        displayName: target.displayName,
        modelId: target.modelId,
        providerBrand: target.providerBrand,
        cells: columnActions.map((action) => {
          const count = counts.get(action) ?? 0;
          return {
            action,
            count,
            share: ratio(count, target.modelActionTrials),
            isModal: count > 0 && modal.has(action),
          };
        }),
        modalActions,
        pairwiseAgreement: target.pairwiseAgreement,
        requestedSamples: target.requestedSamples,
        completedTrials: target.completedTrials,
        modelActionTrials: target.modelActionTrials,
        fallbackTrials: target.fallbackTrials,
        infrastructureErrorTrials: target.infrastructureErrorTrials,
        fallbackShare: ratio(target.fallbackTrials, target.completedTrials),
        infrastructureErrorShare: ratio(target.infrastructureErrorTrials, target.completedTrials),
        denominators: {
          actionDistribution: target.modelActionTrials,
          terminalOutcomes: target.completedTrials,
          requested: target.requestedSamples,
        },
      };
    });
  return {
    columns,
    original: { ...input.source.originalDecision },
    rows,
  };
}
