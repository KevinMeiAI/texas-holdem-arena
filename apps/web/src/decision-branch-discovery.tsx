import { useId } from "react";
import { Link } from "react-router-dom";
import type { PublicDecisionBranchSummary } from "../../../packages/contracts/src/decision-branches";
import { useApiResource } from "./api";
import { modelTint } from "./components";
import {
  buildDecisionBranchDiscoveryCardModel,
  type DecisionBranchDiscoveryCardModel,
} from "./decision-branch-discovery-model";
import { ProviderLogo } from "./provider-logo";
import { useUiPreferences } from "./ui-preferences";
import "./decision-branch-discovery.css";

interface DecisionBranchDiscoveryResponse {
  decisionBranches: PublicDecisionBranchSummary[];
}

export interface DecisionBranchDiscoveryProps {
  apiPath: string | null;
  title: string;
  eyebrow?: string;
  showRelatedRoles?: boolean;
}

function DecisionBranchDiscoveryCard({
  model,
  showRelatedRoles,
}: {
  model: DecisionBranchDiscoveryCardModel;
  showRelatedRoles: boolean;
}) {
  const { text } = useUiPreferences();
  return (
    <Link className="decision-branch-discovery-card" to={model.href}>
      <div className="decision-branch-discovery-meta">
        <span>{model.handLabel}</span>
        <b>{model.streetLabel}</b>
        <i aria-hidden="true">↗</i>
      </div>
      <h3>{model.title}</h3>
      <div className="decision-branch-discovery-hero">
        <ProviderLogo
          brand={model.hero.providerBrand}
          fallback={model.hero.displayName.trim().slice(0, 1).toLocaleUpperCase() || "?"}
          fallbackStyle={modelTint(model.hero.competitorId ?? model.id)}
          className="decision-branch-discovery-hero-logo"
        />
        <div><span>{text("原决策模型", "Original model")}</span><strong title={model.hero.displayName}>{model.hero.displayName}</strong></div>
        <b>{model.originalDecisionLabel}</b>
      </div>
      {showRelatedRoles && model.relatedRoles.length > 0 && (
        <div className="decision-branch-discovery-roles" aria-label={text("选手角色", "Player roles")}>
          {model.relatedRoles.map((role) => <span key={role.role}>{role.label}</span>)}
        </div>
      )}
      <div className="decision-branch-discovery-split">
        <span>{text("主要分歧", "Main split")}</span>
        <div>
          {model.primarySplit.length > 0
            ? model.primarySplit.map((entry) => (
                <b className={`is-${entry.action}`} key={entry.action}>{entry.label}<i>{entry.shareLabel}</i></b>
              ))
            : <em>{text("暂无有效动作", "No valid actions")}</em>}
        </div>
      </div>
      <footer>
        <div className="decision-branch-discovery-targets" aria-label={text("复测模型", "Compared models")} role="list">
          {model.visibleTargets.map((target) => (
            <span
              aria-label={target.displayName}
              key={`${target.competitorId}:${target.ordinal}`}
              role="listitem"
              title={target.displayName}
            >
              <ProviderLogo
                brand={target.providerBrand}
                fallback={target.displayName.trim().slice(0, 1).toLocaleUpperCase() || "?"}
                fallbackStyle={modelTint(target.competitorId)}
                className="decision-branch-discovery-target-logo"
              />
            </span>
          ))}
          {model.additionalTargetCount > 0 && (
            <b
              aria-label={text(
                `另有 ${model.additionalTargetCount} 个复测模型`,
                `${model.additionalTargetCount} more compared models`,
              )}
              role="listitem"
            >+{model.additionalTargetCount}</b>
          )}
        </div>
        <span>{model.sampleLabel}</span>
      </footer>
    </Link>
  );
}

function DecisionBranchDiscoverySkeleton() {
  return <div className="decision-branch-discovery-skeleton" aria-hidden="true"><i /><i /><i /><i /></div>;
}

function DecisionBranchDiscoveryResource({
  apiPath,
  title,
  eyebrow,
  showRelatedRoles = false,
}: DecisionBranchDiscoveryProps) {
  const { locale, text } = useUiPreferences();
  const headingId = useId();
  const resource = useApiResource<DecisionBranchDiscoveryResponse>(apiPath);
  if (resource.error) return null;
  const branches = resource.data?.decisionBranches ?? [];
  if (!resource.loading && branches.length === 0) return null;
  const models = branches.map((branch) => buildDecisionBranchDiscoveryCardModel(branch, locale));
  return (
    <section className="decision-branch-discovery" aria-labelledby={headingId} aria-busy={resource.loading}>
      <header>
        <div>{eyebrow && <span>{eyebrow}</span>}<h2 id={headingId}>{title}</h2></div>
        {!resource.loading && <b>{branches.length}</b>}
      </header>
      <div className="decision-branch-discovery-grid">
        {resource.loading
          ? <><DecisionBranchDiscoverySkeleton /><DecisionBranchDiscoverySkeleton /></>
          : models.map((model) => (
              <DecisionBranchDiscoveryCard model={model} showRelatedRoles={showRelatedRoles} key={model.id} />
            ))}
      </div>
      {resource.loading && <span className="visually-hidden">{text("正在加载决策分叉", "Loading decision branches")}</span>}
    </section>
  );
}

export function DecisionBranchDiscovery(props: DecisionBranchDiscoveryProps) {
  return <DecisionBranchDiscoveryResource {...props} key={props.apiPath ?? "decision-branch-discovery-empty"} />;
}
