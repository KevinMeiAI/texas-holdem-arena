import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type {
  AdminHandFork,
  CreateHandForkRequest,
  HandForkSourceCandidate,
  HandForkSourceSummary,
  HandForkTarget,
  HandForkTargetSummary,
  HandForkTrial,
} from "../../../packages/contracts/src/hand-forks";
import { ApiError, apiRequest, useApiResource } from "./api";
import {
  EmptyState,
  ErrorBlock,
  formatArenaPhase,
  formatChips,
  LoadingBlock,
  modelTint,
  PlayingCard,
} from "./components";
import {
  actionDistributionEntries,
  availableHandForkSources,
  completedHandForkTournaments,
  handForkCreateAttempt,
  handForkCreateFingerprint,
  type HandForkCreateAttempt,
  handForkProgress,
  isHandForkActive,
  parseHandForkCreateAttempts,
} from "./hand-fork-admin-model";
import { ProviderLogo } from "./provider-logo";
import { SelectControl } from "./select-control";
import type { ModelConfig, TournamentSummary } from "./types";
import { type UiLocale, uiText, useUiPreferences } from "./ui-preferences";

const TERMINAL_FORK_STATUSES = new Set<AdminHandFork["status"]>([
  "COMPLETED",
  "PARTIAL",
  "FAILED",
  "CANCELLED",
]);

const PENDING_CREATE_STORAGE_KEY = "arena.hand-fork.pending-creates.v1";

function loadPendingCreateAttempts(): HandForkCreateAttempt[] {
  try {
    return parseHandForkCreateAttempts(window.sessionStorage.getItem(PENDING_CREATE_STORAGE_KEY));
  } catch {
    return [];
  }
}

function savePendingCreateAttempts(attempts: HandForkCreateAttempt[]): void {
  try {
    if (attempts.length === 0) window.sessionStorage.removeItem(PENDING_CREATE_STORAGE_KEY);
    else window.sessionStorage.setItem(PENDING_CREATE_STORAGE_KEY, JSON.stringify(attempts.slice(-12)));
  } catch {
    // Storage can be unavailable in hardened browser contexts; in-memory idempotency still applies.
  }
}

function percent(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : `${Math.round(value * 100)}%`;
}

function duration(milliseconds: number | null | undefined): string {
  if (milliseconds === null || milliseconds === undefined) return "—";
  if (milliseconds < 1_000) return `${Math.round(milliseconds)}ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 1 : 0)}s`;
  const totalSeconds = Math.round(milliseconds / 1_000);
  return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`;
}

function actionLabel(action: string | null, locale: UiLocale): string {
  if (!action) return "—";
  const labels: Record<string, [string, string]> = {
    fold: ["弃牌", "Fold"],
    check: ["过牌", "Check"],
    call: ["跟注", "Call"],
    bet: ["下注", "Bet"],
    raise: ["加注", "Raise"],
    all_in: ["全下", "All-in"],
  };
  const label = labels[action];
  return label ? uiText(locale, ...label) : action;
}

function decisionLabel(source: HandForkSourceSummary, locale: UiLocale): string {
  const amount = source.originalAmountTo === null ? "" : ` ${formatChips(source.originalAmountTo)}`;
  return `${formatArenaPhase(source.street, locale)} · ${source.playerDisplayName} · ${actionLabel(source.originalAction, locale)}${amount} · #${source.actionEventSequence}`;
}

function legalActionsLabel(source: HandForkSourceSummary, locale: UiLocale): string {
  const { legalActions } = source;
  const allInClassifications: Record<NonNullable<typeof legalActions.all_in>["classification"], [string, string]> = {
    call: ["跟注", "call"],
    bet: ["下注", "bet"],
    raise: ["加注", "raise"],
    short_raise: ["短加注", "short raise"],
  };
  return legalActions.allowed.map((action) => {
    if (action === "call" && legalActions.call) {
      const allIn = legalActions.call.will_be_all_in ? ` · ${uiText(locale, "全下", "all-in")}` : "";
      return `${actionLabel(action, locale)} ${formatChips(legalActions.call.amount)}${allIn}`;
    }
    if ((action === "bet" || action === "raise") && legalActions[action]) {
      const bounds = legalActions[action];
      return `${actionLabel(action, locale)} ${formatChips(bounds.min_amount_to)}–${formatChips(bounds.max_amount_to)}`;
    }
    if (action === "all_in" && legalActions.all_in) {
      const classification = allInClassifications[legalActions.all_in.classification];
      return `${actionLabel(action, locale)} ${formatChips(legalActions.all_in.resulting_street_commitment)} (${uiText(locale, ...classification)})`;
    }
    return actionLabel(action, locale);
  }).join(" / ");
}

function forkStatusLabel(status: AdminHandFork["status"], locale: UiLocale): string {
  const labels: Record<AdminHandFork["status"], [string, string]> = {
    QUEUED: ["排队中", "Queued"],
    RUNNING: ["运行中", "Running"],
    COMPLETED: ["已完成", "Completed"],
    PARTIAL: ["部分完成", "Partial"],
    FAILED: ["已停止", "Stopped"],
    CANCELLED: ["已取消", "Cancelled"],
  };
  return uiText(locale, ...labels[status]);
}

function targetStatusLabel(status: HandForkTarget["status"], locale: UiLocale): string {
  const labels: Record<HandForkTarget["status"], [string, string]> = {
    QUEUED: ["等待", "Waiting"],
    RUNNING: ["运行中", "Running"],
    COMPLETED: ["完成", "Complete"],
    FAILED: ["停止", "Stopped"],
    CANCELLED: ["取消", "Cancelled"],
  };
  return uiText(locale, ...labels[status]);
}

function trialOutcomeLabel(trial: HandForkTrial, locale: UiLocale): string {
  if (trial.status === "RUNNING") return uiText(locale, "调用中", "Calling");
  const labels: Record<NonNullable<HandForkTrial["outcome"]>, [string, string]> = {
    MODEL_ACTION: ["模型决策", "Model action"],
    PROTOCOL_FALLBACK: ["协议回退", "Protocol fallback"],
    INFRA_ERROR: ["调用失败", "API error"],
    CANCELLED: ["已取消", "Cancelled"],
  };
  return trial.outcome ? uiText(locale, ...labels[trial.outcome]) : "—";
}

function turnOutcomeLabel(outcome: NonNullable<HandForkTrial["turns"]>[number]["outcome"], locale: UiLocale): string {
  const labels = {
    SUCCESS: ["成功", "Success"],
    PROTOCOL_ERROR: ["协议错误", "Protocol error"],
    INFRA_ERROR: ["调用错误", "API error"],
  } satisfies Record<string, [string, string]>;
  return uiText(locale, ...labels[outcome]);
}

function errorMessage(error: unknown, locale: UiLocale): string {
  if (!(error instanceof Error)) return uiText(locale, "操作失败", "Operation failed");
  const labels: Record<string, [string, string]> = {
    hand_fork_target_unavailable: ["所选模型配置不可用于分叉测试", "A selected model configuration is unavailable"],
    hand_fork_conflict: ["实验状态已变化，请刷新后重试", "The run changed state; refresh and retry"],
    hand_fork_source_unavailable: ["该决策点已无法安全复现", "This decision point can no longer be reproduced safely"],
    source_decision_not_found: ["找不到该决策点", "Decision point not found"],
    hand_fork_failed: ["手牌分叉服务暂时不可用", "Hand fork service is temporarily unavailable"],
  };
  const label = labels[error instanceof ApiError ? error.code : error.message];
  return label ? uiText(locale, ...label) : error.message;
}

function setQueryValues(
  current: URLSearchParams,
  patch: Record<string, string | number | null>,
): URLSearchParams {
  const next = new URLSearchParams(current);
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) next.delete(key);
    else next.set(key, String(value));
  }
  return next;
}

function SourceSnapshot({ source, integrityHash }: { source: HandForkSourceSummary; integrityHash?: string }) {
  const { locale, text } = useUiPreferences();
  return <article className="hand-fork-source-snapshot">
    <header>
      <div>
        <span>H{String(source.handNo).padStart(3, "0")} · {formatArenaPhase(source.street, locale)}</span>
        <h2>{source.playerDisplayName}</h2>
      </div>
      <div className="hand-fork-hole-cards">
        {source.holeCards.map((card) => <PlayingCard card={card} compact key={card} />)}
      </div>
    </header>
    <dl>
      <div><dt>{text("位置", "Position")}</dt><dd>{source.heroPosition}</dd></div>
      <div><dt>{text("原决策", "Original")}</dt><dd>{actionLabel(source.originalAction, locale)}{source.originalAmountTo === null ? "" : ` ${formatChips(source.originalAmountTo)}`}{source.originalUsedFallback && <small className="hand-fork-fallback-badge">{text("规则兜底", "Fallback")}</small>}</dd></div>
      <div><dt>{text("合法动作", "Legal actions")}</dt><dd>{legalActionsLabel(source, locale)}</dd></div>
      <div><dt>{text("行动序号", "Event sequence")}</dt><dd>#{source.actionEventSequence}</dd></div>
    </dl>
    {source.originalDecisionSummary && <blockquote>{source.originalDecisionSummary}</blockquote>}
    {integrityHash && <footer>{text("输入指纹", "Input fingerprint")} <code>{integrityHash.slice(0, 12)}</code></footer>}
  </article>;
}

function ModelPicker({ models, selected, onToggle }: {
  models: ModelConfig[];
  selected: string[];
  onToggle: (id: string) => void;
}) {
  const { text } = useUiPreferences();
  return <section className="hand-fork-models">
    <header><div><span>02</span><h2>{text("目标模型", "Target models")}</h2></div><b>{selected.length} / 9</b></header>
    <div className="hand-fork-model-list">
      {models.length === 0 && <p>{text("没有已启用的模型", "No enabled models")}</p>}
      {models.map((model) => {
        const checked = selected.includes(model.id);
        const blocked = !checked && selected.length >= 9;
        return <button
          className={checked ? "selected" : ""}
          type="button"
          disabled={blocked}
          aria-pressed={checked}
          onClick={() => onToggle(model.id)}
          key={model.id}
        >
          <ProviderLogo
            providerProfile={model.providerProfile}
            providerType={model.providerType}
            label={model.providerLabel}
            baseUrl={model.providerBaseUrl}
            modelId={model.modelId}
            fallback={model.displayName.slice(0, 1)}
            fallbackStyle={modelTint(model.id)}
          />
          <span className="hand-fork-model-copy"><strong>{model.displayName}</strong><small>{model.providerLabel} · {model.modelId}</small></span>
          <i aria-hidden="true">{checked ? "✓" : "+"}</i>
        </button>;
      })}
    </div>
  </section>;
}

function ForkHistory({ forks, onSelect }: { forks: AdminHandFork[]; onSelect: (id: string) => void }) {
  const { locale, text } = useUiPreferences();
  if (forks.length === 0) return <p className="hand-fork-history-empty">{text("还没有分叉实验", "No hand forks yet")}</p>;
  return <div className="hand-fork-history">
    {forks.slice(0, 12).map((fork) => {
      const progress = handForkProgress(fork);
      return <button type="button" onClick={() => onSelect(fork.id)} key={fork.id}>
        <span className={`hand-fork-status is-${fork.status.toLowerCase()}`}><i />{forkStatusLabel(fork.status, locale)}</span>
        <strong>{fork.source.tournamentName}</strong>
        <small>H{String(fork.source.handNo).padStart(3, "0")} · {fork.source.playerDisplayName} · {fork.targets.length} {text("个模型", "models")}</small>
        <time>{new Date(fork.createdAt).toLocaleString(locale, { dateStyle: "short", timeStyle: "short" })}</time>
        <b>{progress.terminal}/{progress.total}</b>
      </button>;
    })}
  </div>;
}

function HandForkSetup({ csrfToken, onOpenFork }: { csrfToken: string; onOpenFork: (id: string) => void }) {
  const { locale, text } = useUiPreferences();
  const [searchParams, setSearchParams] = useSearchParams();
  const tournaments = useApiResource<{ tournaments: TournamentSummary[] }>("/api/public/tournaments");
  const models = useApiResource<{ models: ModelConfig[] }>("/api/admin/models");
  const forks = useApiResource<{ handForks: AdminHandFork[] }>("/api/admin/hand-forks?limit=12", 4_000);
  const completedTournaments = useMemo(
    () => completedHandForkTournaments(tournaments.data?.tournaments ?? []),
    [tournaments.data?.tournaments],
  );
  const tournamentId = searchParams.get("tournamentId") ?? "";
  const rawHandNo = Number(searchParams.get("handNo"));
  const selectedTournament = completedTournaments.find((tournament) => tournament.id === tournamentId) ?? null;
  const handNo = selectedTournament && Number.isSafeInteger(rawHandNo)
    && rawHandNo >= 1 && rawHandNo <= selectedTournament.publicState.completedHands ? rawHandNo : 0;
  const sources = useApiResource<{ sources: HandForkSourceCandidate[] }>(
    selectedTournament && handNo > 0
      ? `/api/admin/tournaments/${encodeURIComponent(selectedTournament.id)}/hands/${handNo}/hand-fork-sources`
      : null,
  );
  const availableSources = useMemo(
    () => availableHandForkSources(sources.data?.sources ?? []),
    [sources.data?.sources],
  );
  const decisionId = searchParams.get("decisionId") ?? "";
  const selectedSource = availableSources.find((source) => source.decisionId === decisionId) ?? null;
  const enabledModels = (models.data?.models ?? []).filter((model) => model.enabled);
  const [selectedModels, setSelectedModels] = useState<string[]>([]);
  const [sampleCount, setSampleCount] = useState(10);
  const [timeoutSeconds, setTimeoutSeconds] = useState(180);
  const [maxParallelTargets, setMaxParallelTargets] = useState(3);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pendingCreates = useRef<HandForkCreateAttempt[] | null>(null);
  const mounted = useRef(true);
  if (pendingCreates.current === null) pendingCreates.current = loadPendingCreateAttempts();

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (completedTournaments.length === 0) return;
    const fallbackTournament = completedTournaments[0]!;
    const resolvedTournament = selectedTournament ?? fallbackTournament;
    const resolvedHandNo = handNo || resolvedTournament.publicState.completedHands;
    if (selectedTournament && handNo > 0) return;
    setSearchParams((current) => setQueryValues(current, {
      tournamentId: resolvedTournament.id,
      handNo: resolvedHandNo,
      decisionId: null,
    }), { replace: true });
  }, [completedTournaments, handNo, selectedTournament, setSearchParams]);

  useEffect(() => {
    if (!sources.data || availableSources.length === 0 || selectedSource) return;
    setSearchParams((current) => setQueryValues(current, {
      decisionId: availableSources[0]!.decisionId,
    }), { replace: true });
  }, [availableSources, selectedSource, setSearchParams, sources.data]);

  useEffect(() => {
    const enabled = new Set(enabledModels.map((model) => model.id));
    setSelectedModels((current) => current.filter((id) => enabled.has(id)));
  }, [models.data]);

  const updateTournament = (nextId: string) => {
    const tournament = completedTournaments.find((item) => item.id === nextId);
    setSearchParams((current) => setQueryValues(current, {
      tournamentId: nextId,
      handNo: tournament?.publicState.completedHands ?? 1,
      decisionId: null,
    }));
  };
  const updateHand = (value: string) => setSearchParams((current) => setQueryValues(current, {
    handNo: value,
    decisionId: null,
  }));
  const toggleModel = (id: string) => setSelectedModels((current) => current.includes(id)
    ? current.filter((item) => item !== id)
    : current.length < 9 ? [...current, id] : current);

  const runtimeValid = Number.isInteger(sampleCount) && sampleCount >= 1 && sampleCount <= 20
    && Number.isInteger(timeoutSeconds) && timeoutSeconds >= 30 && timeoutSeconds <= 600
    && Number.isInteger(maxParallelTargets) && maxParallelTargets >= 1 && maxParallelTargets <= 3;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedSource || selectedModels.length === 0) {
      setError(text("请选择决策点和至少一个模型", "Select a decision point and at least one model"));
      return;
    }
    if (!runtimeValid) {
      setError(text("请检查样本数、超时和并行数", "Check samples, timeout, and parallelism"));
      return;
    }
    setWorking(true);
    setError(null);
    try {
      const requestParameters = {
        sourceDecisionId: selectedSource.decisionId,
        modelConfigIds: [...selectedModels].sort(),
        sampleCount,
        timeoutMs: timeoutSeconds * 1_000,
        maxParallelTargets,
      };
      const fingerprint = handForkCreateFingerprint(requestParameters);
      const previousAttempt = pendingCreates.current?.find((attempt) => attempt.fingerprint === fingerprint) ?? null;
      const createAttempt = handForkCreateAttempt(
        previousAttempt,
        requestParameters,
        () => crypto.randomUUID(),
      );
      if (!previousAttempt) {
        pendingCreates.current = [...(pendingCreates.current ?? []), createAttempt].slice(-12);
        savePendingCreateAttempts(pendingCreates.current);
      }
      const body: CreateHandForkRequest = {
        clientRequestId: createAttempt.clientRequestId,
        ...requestParameters,
      };
      const response = await apiRequest<{ handFork: AdminHandFork }>("/api/admin/hand-forks", {
        method: "POST",
        csrfToken,
        body: JSON.stringify(body),
      });
      pendingCreates.current = (pendingCreates.current ?? []).filter((attempt) => attempt.clientRequestId !== createAttempt.clientRequestId);
      savePendingCreateAttempts(pendingCreates.current);
      if (mounted.current) onOpenFork(response.handFork.id);
    } catch (reason) {
      if (mounted.current) setError(errorMessage(reason, locale));
    } finally {
      if (mounted.current) setWorking(false);
    }
  };

  const loading = tournaments.loading || models.loading || forks.loading;
  const resourceError = tournaments.error || models.error || forks.error;
  if (loading) return <LoadingBlock label={text("正在读取手牌分叉配置", "Loading hand fork configuration")} />;
  if (resourceError) return <ErrorBlock message={resourceError} onRetry={() => void Promise.all([tournaments.refresh(), models.refresh(), forks.refresh()])} />;
  if (completedTournaments.length === 0) return <div className="hand-fork-admin-page"><div className="admin-heading"><div><h1>{text("手牌分叉", "Hand forks")}</h1></div></div><EmptyState title={text("还没有可复测的赛事", "No eligible tournaments")} body={text("完成一场赛事后即可复现其中的模型决策。", "Complete a tournament to replay its model decisions.")} /></div>;

  const totalCalls = selectedModels.length * sampleCount;
  const unavailableCount = (sources.data?.sources.length ?? 0) - availableSources.length;
  return <div className="hand-fork-admin-page">
    <div className="admin-heading"><div><h1>{text("手牌分叉", "Hand forks")}</h1></div></div>
    <form className="hand-fork-setup" onSubmit={submit}>
      <section className="hand-fork-source-index">
        <header><span>01</span><h2>{text("决策点", "Decision point")}</h2></header>
        <div className="hand-fork-source-fields">
          <label><span>{text("已结束赛事", "Completed tournament")}</span><SelectControl value={selectedTournament?.id ?? ""} onChange={updateTournament} options={completedTournaments.map((tournament) => ({ value: tournament.id, label: tournament.name }))} /></label>
          <label><span>{text("手牌", "Hand")}</span><SelectControl value={handNo > 0 ? String(handNo) : ""} onChange={updateHand} disabled={!selectedTournament} options={selectedTournament ? Array.from({ length: selectedTournament.publicState.completedHands }, (_, index) => selectedTournament.publicState.completedHands - index).map((number) => ({ value: String(number), label: `H${String(number).padStart(3, "0")}` })) : []} /></label>
          <label className="wide"><span>{text("模型行动", "Model decision")}</span><SelectControl value={selectedSource?.decisionId ?? ""} onChange={(value) => setSearchParams((current) => setQueryValues(current, { decisionId: value }))} disabled={sources.loading || availableSources.length === 0} options={availableSources.map((source) => ({ value: source.decisionId, label: decisionLabel(source.source, locale) }))} /></label>
        </div>
        {sources.loading ? <LoadingBlock label={text("正在核验决策点", "Auditing decision points")} /> : sources.error ? <ErrorBlock message={sources.error} onRetry={() => void sources.refresh()} /> : selectedSource ? <SourceSnapshot source={selectedSource.source} integrityHash={selectedSource.sourceIntegrity.visibleInputHash} /> : <EmptyState title={text("本手没有可复测的决策", "No reproducible decision in this hand")} body={text("仅完整留存请求审计的成功决策可用于分叉。", "Only successful decisions with a complete request audit are eligible.")} />}
        {unavailableCount > 0 && <p className="hand-fork-source-audit">{text(`${availableSources.length} 个可用 · ${unavailableCount} 个未通过审计`, `${availableSources.length} available · ${unavailableCount} excluded by audit`)}</p>}
      </section>

      <ModelPicker models={enabledModels} selected={selectedModels} onToggle={toggleModel} />

      <section className="hand-fork-runtime">
        <header><span>03</span><h2>{text("运行参数", "Runtime")}</h2></header>
        <div>
          <label><span>{text("每个模型样本数", "Samples per model")}</span><input type="number" min={1} max={20} step={1} value={sampleCount} onChange={(event) => setSampleCount(Number(event.target.value))} /></label>
          <label><span>{text("单次超时", "Per-call timeout")}</span><div className="hand-fork-unit-field"><input type="number" min={30} max={600} step={10} value={timeoutSeconds} onChange={(event) => setTimeoutSeconds(Number(event.target.value))} /><b>{text("秒", "sec")}</b></div></label>
          <label><span>{text("并行模型", "Parallel models")}</span><SelectControl value={String(maxParallelTargets)} onChange={(value) => setMaxParallelTargets(Number(value))} options={[1, 2, 3].map((value) => ({ value: String(value), label: String(value) }))} /></label>
        </div>
      </section>

      <aside className="hand-fork-launch">
        <div><span>{text("真实 API 调用", "Live API calls")}</span><strong>{Number.isFinite(totalCalls) ? totalCalls : 0}</strong><small>{text(`最多 ${maxParallelTargets} 个模型并行；单个模型的样本严格串行`, `Up to ${maxParallelTargets} models in parallel; samples stay serial within each model`)}</small></div>
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="button primary" disabled={working || !selectedSource || selectedModels.length === 0 || !runtimeValid}>{working ? text("正在冻结配置…", "Freezing configuration…") : text(`开始 ${Number.isFinite(totalCalls) ? totalCalls : 0} 次调用`, `Run ${Number.isFinite(totalCalls) ? totalCalls : 0} calls`)}</button>
      </aside>
    </form>

    <section className="hand-fork-recent">
      <header><h2>{text("最近实验", "Recent runs")}</h2><button type="button" onClick={() => void forks.refresh()}>{text("刷新", "Refresh")}</button></header>
      <ForkHistory forks={forks.data?.handForks ?? []} onSelect={onOpenFork} />
    </section>
  </div>;
}

function ActionDistribution({ summary, trials }: { summary: HandForkTargetSummary | null; trials: HandForkTrial[] }) {
  const { locale } = useUiPreferences();
  const partialDistribution = trials
    .filter((trial) => trial.status === "COMPLETED" && trial.outcome === "MODEL_ACTION" && trial.action)
    .reduce<Record<string, number>>((counts, trial) => {
      counts[trial.action!] = (counts[trial.action!] ?? 0) + 1;
      return counts;
    }, {});
  const entries = summary
    ? actionDistributionEntries(summary)
    : Object.entries(partialDistribution).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) return <span className="hand-fork-empty-metric">—</span>;
  return <div className="hand-fork-distribution">
    {entries.map(([action, count]) => <span className={`is-${action}`} key={action}><b>{actionLabel(action, locale)}</b><i>{count}</i></span>)}
  </div>;
}

function SizingMetric({ summary }: { summary: HandForkTargetSummary | null }) {
  const { locale, text } = useUiPreferences();
  const entries = Object.entries(summary?.sizing ?? {});
  if (entries.length === 0) return <>—</>;
  return <div className="hand-fork-sizing">
    {entries.map(([action, sizing]) => <span key={action}><b>{actionLabel(action, locale)}</b>{text("中位", "median")} {formatChips(sizing.median)}<small>{formatChips(sizing.min)}–{formatChips(sizing.max)}</small></span>)}
  </div>;
}

type ComparisonKey = "model" | "modal" | "pairwise" | "firstTurn" | "history" | "correction" | "fallback" | "infra" | "latency" | "tokens";

function TargetComparison({ targets, onOpenTarget }: { targets: HandForkTarget[]; onOpenTarget: (id: string) => void }) {
  const { locale, text } = useUiPreferences();
  const [sort, setSort] = useState<{ key: ComparisonKey; direction: "asc" | "desc" }>({ key: "pairwise", direction: "desc" });
  const value = (target: HandForkTarget): string | number | null => {
    const summary = target.summary;
    if (sort.key === "model") return target.modelDisplayName.toLocaleLowerCase(locale);
    if (sort.key === "modal") return summary?.modalShare ?? null;
    if (sort.key === "pairwise") return summary?.pairwiseAgreement ?? null;
    if (sort.key === "firstTurn") return summary?.firstTurnValidRate ?? null;
    if (sort.key === "history") return summary?.historyQueryRate ?? null;
    if (sort.key === "correction") return summary?.correctionRate ?? null;
    if (sort.key === "fallback") return summary?.fallbackTrials ?? null;
    if (sort.key === "infra") return summary?.infrastructureErrorTrials ?? null;
    if (sort.key === "latency") return summary?.p95LatencyMs ?? null;
    return summary?.totalTokens ?? null;
  };
  const rows = [...targets].sort((left, right) => {
    const leftValue = value(left);
    const rightValue = value(right);
    if (leftValue === null || rightValue === null) {
      if (leftValue === rightValue) return 0;
      return leftValue === null ? 1 : -1;
    }
    const compared = typeof leftValue === "string" && typeof rightValue === "string"
      ? leftValue.localeCompare(rightValue, locale)
      : Number(leftValue) - Number(rightValue);
    return sort.direction === "asc" ? compared : -compared;
  });
  const heading = (key: ComparisonKey, zh: string, en: string) => <button type="button" onClick={() => setSort((current) => ({
    key,
    direction: current.key === key && current.direction === "desc" ? "asc" : "desc",
  }))}>{text(zh, en)}{sort.key === key && <i aria-hidden="true">{sort.direction === "desc" ? "↓" : "↑"}</i>}</button>;
  const ariaSort = (key: ComparisonKey): "none" | "ascending" | "descending" => sort.key === key
    ? sort.direction === "asc" ? "ascending" : "descending"
    : "none";

  return <section className="hand-fork-comparison">
    <header><h2 id="hand-fork-comparison-heading">{text("模型对比", "Model comparison")}</h2></header>
    <div className="hand-fork-comparison-scroll">
      <table>
        <caption className="visually-hidden">{text("手牌分叉模型指标对比", "Hand fork model metric comparison")}</caption>
        <thead><tr>
          <th scope="col" aria-sort={ariaSort("model")}>{heading("model", "模型", "Model")}</th>
          <th scope="col">{text("行动分布", "Action distribution")}</th>
          <th scope="col" aria-sort={ariaSort("modal")}>{heading("modal", "众数", "Mode")}</th>
          <th scope="col" aria-sort={ariaSort("pairwise")}>{heading("pairwise", "两两一致", "Pairwise")}</th>
          <th scope="col">{text("下注尺度", "Sizing")}</th>
          <th scope="col" aria-sort={ariaSort("firstTurn")}>{heading("firstTurn", "首轮有效", "First-turn valid")}</th>
          <th scope="col" aria-sort={ariaSort("history")}>{heading("history", "查询历史", "History query")}</th>
          <th scope="col" aria-sort={ariaSort("correction")}>{heading("correction", "协议纠错", "Correction")}</th>
          <th scope="col" aria-sort={ariaSort("fallback")}>{heading("fallback", "回退", "Fallback")}</th>
          <th scope="col" aria-sort={ariaSort("infra")}>{heading("infra", "调用失败", "API error")}</th>
          <th scope="col" aria-sort={ariaSort("latency")}>{heading("latency", "平均 / P95", "Avg / P95")}</th>
          <th scope="col" aria-sort={ariaSort("tokens")}>{heading("tokens", "Token", "Tokens")}</th>
        </tr></thead>
        <tbody>{rows.map((target) => {
          const summary = target.summary;
          const trials = target.trials ?? [];
          return <tr key={target.id}>
            <th scope="row">
              <button className="hand-fork-target-name" type="button" onClick={() => onOpenTarget(target.id)}><ProviderLogo providerProfile={target.providerProfile} modelId={target.modelId} label={target.modelDisplayName} fallback={target.modelDisplayName.slice(0, 1)} fallbackStyle={modelTint(target.competitorFamilyId)} /><span className="hand-fork-target-copy"><strong>{target.modelDisplayName}</strong><small>{target.modelId}</small></span></button>
              <span className={`hand-fork-target-status is-${target.status.toLowerCase()}`}>{targetStatusLabel(target.status, locale)} · {target.terminalTrials}/{target.sampleCount}</span>
            </th>
            <td><ActionDistribution summary={summary} trials={trials} /></td>
            <td><strong>{actionLabel(summary?.modalAction ?? null, locale)}</strong><small>{summary ? `${summary.modalCount}/${summary.actionDistributionTrials} · ${percent(summary.modalShare)}` : "—"}</small></td>
            <td><strong>{percent(summary?.pairwiseAgreement)}</strong><small>{summary ? `n=${summary.pairwiseComparisonPairs}` : "—"}</small></td>
            <td><SizingMetric summary={summary} /></td>
            <td><strong>{percent(summary?.firstTurnValidRate)}</strong><small>{summary ? `n=${summary.firstTurnObservedTrials}` : "—"}</small></td>
            <td><strong>{percent(summary?.historyQueryRate)}</strong><small>{summary ? `n=${summary.reliabilityEligibleTrials}` : "—"}</small></td>
            <td><strong>{percent(summary?.correctionRate)}</strong><small>{summary ? `n=${summary.reliabilityEligibleTrials}` : "—"}</small></td>
            <td><strong>{summary?.fallbackTrials ?? "—"}</strong><small>{summary ? `/${summary.completedTrials}` : "—"}</small></td>
            <td><strong>{summary?.infrastructureErrorTrials ?? "—"}</strong><small>{summary ? `/${summary.completedTrials}` : "—"}</small></td>
            <td><strong>{duration(summary?.averageLatencyMs)}</strong><small>{duration(summary?.p95LatencyMs)}</small></td>
            <td><strong>{summary?.totalTokens?.toLocaleString(locale) ?? "—"}</strong><small>{summary ? `n=${summary.tokenObservedTrials}` : "—"}</small></td>
          </tr>;
        })}</tbody>
      </table>
    </div>
  </section>;
}

function TrialTurnList({ trial }: { trial: HandForkTrial }) {
  const { locale, text } = useUiPreferences();
  if (!trial.turns || trial.turns.length === 0) return null;
  return <div className="hand-fork-turns">
    <header><span>{text("轮次", "Turn")}</span><span>{text("结果", "Outcome")}</span><span>{text("耗时", "Latency")}</span><span>{text("输出方式", "Output")}</span><span>Token</span></header>
    {trial.turns.map((turn) => <div key={turn.turnIndex}>
      <span>#{turn.turnIndex}</span>
      <strong className={`is-${turn.outcome.toLowerCase()}`}>{turnOutcomeLabel(turn.outcome, locale)}</strong>
      <span>{duration(turn.latencyMs)}</span>
      <span>{turn.appliedOutputMode ?? "—"}</span>
      <span>{turn.usage?.totalTokens?.toLocaleString(locale) ?? "—"}</span>
    </div>)}
  </div>;
}

function TrialRow({ trial }: { trial: HandForkTrial }) {
  const { locale, text } = useUiPreferences();
  const reason = trial.decisionSummary || trial.errorMessage;
  return <details className={`hand-fork-trial is-${(trial.outcome ?? trial.status).toLowerCase()}`}>
    <summary>
      <span>#{String(trial.sampleIndex).padStart(2, "0")}</span>
      <b>{trialOutcomeLabel(trial, locale)}</b>
      <strong>{actionLabel(trial.action, locale)}{trial.amountTo === null ? "" : ` ${formatChips(trial.amountTo)}`}</strong>
      <small>{duration(trial.totalLatencyMs)}</small>
      <i aria-hidden="true">⌄</i>
    </summary>
    <div className="hand-fork-trial-body">
      <blockquote>{reason || text("未返回决策理由", "No decision reason returned")}</blockquote>
      <dl>
        <div><dt>{text("首轮有效", "First-turn valid")}</dt><dd>{trial.firstTurnValid === null ? "—" : trial.firstTurnValid ? text("是", "Yes") : text("否", "No")}</dd></div>
        <div><dt>{text("查询历史", "History queries")}</dt><dd>{trial.historyQueryCount}</dd></div>
        <div><dt>{text("协议失败", "Protocol failures")}</dt><dd>{trial.protocolFailures}</dd></div>
        <div><dt>{text("基础设施失败", "Infrastructure failures")}</dt><dd>{trial.infrastructureFailures}</dd></div>
        <div><dt>{text("模型调用", "Provider calls")}</dt><dd>{trial.callCount}</dd></div>
        <div><dt>Token</dt><dd>{trial.usage?.totalTokens?.toLocaleString(locale) ?? "—"}</dd></div>
      </dl>
      <TrialTurnList trial={trial} />
    </div>
  </details>;
}

function TrialExplorer({ targets, selectedTargetId, onSelectTarget }: {
  targets: HandForkTarget[];
  selectedTargetId: string | null;
  onSelectTarget: (id: string) => void;
}) {
  const { text } = useUiPreferences();
  const firstWithTrials = targets.find((target) => (target.trials?.length ?? 0) > 0)?.id ?? targets[0]?.id ?? "";
  const targetId = selectedTargetId && targets.some((target) => target.id === selectedTargetId) ? selectedTargetId : firstWithTrials;
  const target = targets.find((item) => item.id === targetId) ?? targets[0];
  if (!target) return null;
  const trials = target.trials ?? [];
  return <section className="hand-fork-trial-explorer">
    <header><div><h2>{text("逐次决策", "Trial decisions")}</h2><span>{text("点击单行展开理由与调用轮次", "Open a row for its reason and provider turns")}</span></div><SelectControl value={target.id} onChange={onSelectTarget} options={targets.map((item) => ({ value: item.id, label: `${item.modelDisplayName} · ${item.terminalTrials}/${item.sampleCount}` }))} /></header>
    {target.errorMessage && <div className="notice error">{target.errorMessage}</div>}
    <div className="hand-fork-trial-head"><span>#</span><span>{text("结果", "Result")}</span><span>{text("决策", "Decision")}</span><span>{text("耗时", "Latency")}</span><span /></div>
    {trials.length > 0 ? <div className="hand-fork-trials">{trials.map((trial) => <TrialRow trial={trial} key={trial.id} />)}</div> : <p className="hand-fork-trials-empty">{text("等待第一个样本", "Waiting for the first sample")}</p>}
  </section>;
}

function HandForkResult({ fork, csrfToken, onBack, onRefresh, refreshError }: {
  fork: AdminHandFork;
  csrfToken: string;
  onBack: () => void;
  onRefresh: () => Promise<void>;
  refreshError?: string | null;
}) {
  const { locale, text } = useUiPreferences();
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedTargetId, setSelectedTargetId] = useState<string | null>(null);
  const progress = handForkProgress(fork);
  const active = isHandForkActive(fork.status);
  const openTarget = (targetId: string) => {
    setSelectedTargetId(targetId);
    window.requestAnimationFrame(() => document.getElementById("hand-fork-trials")?.scrollIntoView({ block: "start" }));
  };
  return <div className="hand-fork-admin-page hand-fork-result-page">
    <header className="hand-fork-result-header">
      <button type="button" onClick={onBack}>← {text("全部实验", "All runs")}</button>
      <div><span>{fork.source.tournamentName} · H{String(fork.source.handNo).padStart(3, "0")}</span><h1>{text("手牌分叉", "Hand fork")}</h1><small>{fork.targets.length} {text("个模型", "models")} × {fork.sampleCount} · {Math.round(fork.timeoutMs / 1_000)}s · {fork.maxParallelTargets} {text("路并行", "parallel")}</small></div>
      <strong className={`hand-fork-status is-${fork.status.toLowerCase()}`}><i />{forkStatusLabel(fork.status, locale)}</strong>
    </header>
    <div className="hand-fork-progress" role="progressbar" aria-label={text("分叉实验进度", "Hand fork progress")} aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.terminal}><i style={{ width: `${progress.ratio * 100}%` }} /><span>{progress.terminal} / {progress.total}</span></div>
    {refreshError && <div className="notice" role="status">{text("实时刷新暂时失败，正在自动重试。", "Live refresh failed temporarily. Retrying automatically.")}</div>}
    {fork.errorMessage && <div className="notice error">{fork.errorMessage}</div>}
    {error && <p className="form-error" role="alert">{error}</p>}
    {active && <div className="hand-fork-running-strip"><span>{text("实验在后台持续运行；每个模型内部严格串行。", "The run continues in the background; samples stay serial within each model.")}</span><button className="button secondary" type="button" disabled={cancelling} onClick={async () => {
      setCancelling(true);
      setError(null);
      try {
        await apiRequest(`/api/admin/hand-forks/${fork.id}/cancel`, { method: "POST", csrfToken, body: "{}" });
        await onRefresh();
      } catch (reason) {
        setError(errorMessage(reason, locale));
      } finally {
        setCancelling(false);
      }
    }}>{cancelling ? text("正在取消…", "Cancelling…") : text("取消实验", "Cancel run")}</button></div>}
    <SourceSnapshot source={fork.source} integrityHash={fork.sourceIntegrity.visibleInputHash} />
    <div className="hand-fork-target-strip">{fork.targets.map((target) => <button type="button" onClick={() => openTarget(target.id)} key={target.id}>
      <span><i className={`hand-fork-run-dot is-${target.status.toLowerCase()}`} />{target.modelDisplayName}</span>
      <strong>{target.terminalTrials}/{target.sampleCount}</strong>
    </button>)}</div>
    <TargetComparison targets={fork.targets} onOpenTarget={openTarget} />
    <div id="hand-fork-trials"><TrialExplorer targets={fork.targets} selectedTargetId={selectedTargetId} onSelectTarget={setSelectedTargetId} /></div>
    <footer className="hand-fork-audit-footer">
      <span>{text("可见输入", "Visible input")} <code>{fork.sourceIntegrity.visibleInputHash.slice(0, 12)}</code></span>
      <span>{text("规则合约", "Legal contract")} <code>{fork.sourceIntegrity.legalContractHash.slice(0, 12)}</code></span>
      <span>{fork.sourceIntegrity.protocolBundleId}</span>
    </footer>
  </div>;
}

function HandForkResultLoader({ id, csrfToken, onBack }: { id: string; csrfToken: string; onBack: () => void }) {
  const { text } = useUiPreferences();
  const detail = useApiResource<{ handFork: AdminHandFork }>(`/api/admin/hand-forks/${encodeURIComponent(id)}`);
  useEffect(() => {
    if (!detail.data && !detail.error) return;
    if (detail.data && TERMINAL_FORK_STATUSES.has(detail.data.handFork.status)) return;
    const timer = window.setTimeout(() => void detail.refresh(), detail.error ? 4_000 : 1_200);
    return () => window.clearTimeout(timer);
  }, [detail.data, detail.error, detail.refresh]);
  if (detail.loading || !detail.data && !detail.error) return <LoadingBlock label={text("正在读取分叉实验", "Loading hand fork")} />;
  if (!detail.data) return <div className="hand-fork-admin-page"><button className="hand-fork-back-button" type="button" onClick={onBack}>← {text("全部实验", "All runs")}</button><ErrorBlock message={detail.error ?? text("实验不存在", "Run not found")} onRetry={() => void detail.refresh()} /></div>;
  return <HandForkResult fork={detail.data.handFork} csrfToken={csrfToken} onBack={onBack} onRefresh={detail.refresh} refreshError={detail.error} />;
}

export function HandForkAdminPage({ csrfToken }: { csrfToken: string }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const forkId = searchParams.get("forkId");
  const openFork = (id: string) => setSearchParams((current) => setQueryValues(current, { forkId: id }));
  const closeFork = () => setSearchParams((current) => setQueryValues(current, { forkId: null }));
  return forkId
    ? <HandForkResultLoader id={forkId} csrfToken={csrfToken} onBack={closeFork} key={forkId} />
    : <HandForkSetup csrfToken={csrfToken} onOpenFork={openFork} />;
}
