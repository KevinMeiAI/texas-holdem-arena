import type {
  DecisionBranchRelatedPlayerRole,
  PublicDecisionBranchSummary,
} from "../../../packages/contracts/src/decision-branches";
import { formatArenaPhase } from "./components";
import {
  DECISION_BRANCH_ACTION_ORDER,
  decisionBranchActionLabel,
  decisionBranchActionWithAmountLabel,
  localizedDecisionBranchCopy,
  type DecisionBranchAction,
} from "./decision-branch-page-model";
import type { UiLocale } from "./ui-preferences";

const VISIBLE_TARGET_LIMIT = 3;

export interface DecisionBranchDiscoveryAction {
  action: DecisionBranchAction;
  count: number;
  share: number;
  label: string;
  shareLabel: string;
}

export interface DecisionBranchDiscoveryTarget {
  ordinal: number;
  competitorId: string;
  displayName: string;
  providerBrand: PublicDecisionBranchSummary["targets"][number]["providerBrand"];
}

export interface DecisionBranchDiscoveryRole {
  role: DecisionBranchRelatedPlayerRole;
  label: string;
}

export interface DecisionBranchDiscoveryCardModel {
  id: string;
  slug: string;
  href: string;
  title: string;
  handLabel: string;
  streetLabel: string;
  hero: PublicDecisionBranchSummary["hero"];
  originalDecisionLabel: string;
  primarySplit: DecisionBranchDiscoveryAction[];
  visibleTargets: DecisionBranchDiscoveryTarget[];
  additionalTargetCount: number;
  targetCount: number;
  sampleCountPerModel: number;
  sampleLabel: string;
  relatedRoles: DecisionBranchDiscoveryRole[];
}

function percent(value: number, locale: UiLocale): string {
  return new Intl.NumberFormat(locale, {
    style: "percent",
    maximumFractionDigits: 0,
  }).format(value);
}

function roleLabel(role: DecisionBranchRelatedPlayerRole, locale: UiLocale): string {
  const labels: Record<DecisionBranchRelatedPlayerRole, readonly [string, string]> = {
    DECISION_MAKER: ["原决策选手", "Decision maker"],
    COMPARED_MODEL: ["复测模型", "Compared model"],
  };
  return labels[role][locale === "zh-CN" ? 0 : 1];
}

export function aggregateDecisionBranchActions(
  targets: readonly PublicDecisionBranchSummary["targets"][number][],
  locale: UiLocale,
  limit = 2,
): DecisionBranchDiscoveryAction[] {
  const counts = new Map<DecisionBranchAction, number>();
  for (const target of targets) {
    for (const entry of target.actionDistribution) {
      if (entry.count <= 0) continue;
      counts.set(entry.action, (counts.get(entry.action) ?? 0) + entry.count);
    }
  }
  const denominator = [...counts.values()].reduce((sum, count) => sum + count, 0);
  if (denominator <= 0 || limit <= 0) return [];
  const order = new Map(DECISION_BRANCH_ACTION_ORDER.map((action, index) => [action, index]));
  return [...counts.entries()]
    .sort(([leftAction, leftCount], [rightAction, rightCount]) => (
      rightCount - leftCount
      || (order.get(leftAction) ?? Number.MAX_SAFE_INTEGER)
        - (order.get(rightAction) ?? Number.MAX_SAFE_INTEGER)
    ))
    .slice(0, Math.trunc(limit))
    .map(([action, count]) => {
      const share = count / denominator;
      return {
        action,
        count,
        share,
        label: decisionBranchActionLabel(action, locale),
        shareLabel: percent(share, locale),
      };
    });
}

export function buildDecisionBranchDiscoveryCardModel(
  branch: PublicDecisionBranchSummary,
  locale: UiLocale,
): DecisionBranchDiscoveryCardModel {
  const copy = localizedDecisionBranchCopy({
    titleZh: branch.titleZh,
    titleEn: branch.titleEn,
    summaryZh: branch.summaryZh,
    summaryEn: branch.summaryEn,
    snapshot: { source: { handNo: branch.handNo } },
  }, locale);
  const displayAmountTo = branch.originalDecision.displayAmountTo;
  const originalDecisionLabel = decisionBranchActionWithAmountLabel(
    branch.originalDecision.action,
    branch.originalDecision.action === "bet" || branch.originalDecision.action === "raise"
      ? displayAmountTo
      : null,
    locale,
    branch.originalDecision.action === "all_in" ? displayAmountTo : null,
  );
  const visibleTargets = [...branch.targets]
    .sort((left, right) => left.ordinal - right.ordinal)
    .slice(0, VISIBLE_TARGET_LIMIT)
    .map((target) => ({
      ordinal: target.ordinal,
      competitorId: target.competitorId,
      displayName: target.displayName,
      providerBrand: target.providerBrand,
    }));
  const modelWord = branch.targetCount === 1 ? "model" : "models";
  const runWord = branch.sampleCountPerModel === 1 ? "run" : "runs";
  return {
    id: branch.id,
    slug: branch.slug,
    href: `/branches/${encodeURIComponent(branch.slug)}`,
    title: copy.title,
    handLabel: `H${String(branch.handNo).padStart(3, "0")}`,
    streetLabel: formatArenaPhase(branch.street, locale),
    hero: branch.hero,
    originalDecisionLabel,
    primarySplit: aggregateDecisionBranchActions(branch.targets, locale),
    visibleTargets,
    additionalTargetCount: Math.max(0, branch.targetCount - visibleTargets.length),
    targetCount: branch.targetCount,
    sampleCountPerModel: branch.sampleCountPerModel,
    sampleLabel: locale === "zh-CN"
      ? `${branch.targetCount} 个模型 · 每个 ${branch.sampleCountPerModel} 次`
      : `${branch.targetCount} ${modelWord} · ${branch.sampleCountPerModel} ${runWord} each`,
    relatedRoles: branch.relatedPlayerRoles.map((role) => ({ role, label: roleLabel(role, locale) })),
  };
}
