import { type FormEvent, useMemo, useState } from "react";
import { apiRequest, useApiResource } from "./api";
import { formatArenaPhase, formatChips, Modal, PlayingCard } from "./components";
import { SelectControl } from "./select-control";
import type {
  ConsistencyRun,
  ConsistencyRunStatus,
  ConsistencySample,
  ConsistencyScenario,
  ConsistencyScenarioRegistry,
  ConsistencyTier,
  ModelConfig,
  ScenarioConsistencySummary,
  SystemPromptVersion,
} from "./types";
import { type UiLocale, uiText, useUiPreferences } from "./ui-preferences";

const ACTION_ORDER = ["fold", "check", "call", "bet", "raise", "all_in"];
const DIMENSIONS = ["street", "tableSize", "potType", "position", "stackDepth", "handClass"] as const;

function percent(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : `${Math.round(value * 100)}%`;
}

function duration(milliseconds: number | null | undefined): string {
  if (milliseconds === null || milliseconds === undefined) return "—";
  if (milliseconds < 1_000) return `${Math.round(milliseconds)}ms`;
  return `${(milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 1 : 0)}s`;
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

function tierLabel(tier: ConsistencyTier, locale: UiLocale): string {
  const labels: Record<ConsistencyTier, [string, string]> = {
    single: ["单场景", "Single"],
    quick: ["快速", "Quick"],
    standard: ["标准", "Standard"],
    full: ["完整", "Full"],
  };
  return uiText(locale, ...labels[tier]);
}

function runStatusLabel(status: ConsistencyRunStatus, locale: UiLocale): string {
  const labels: Record<ConsistencyRunStatus, [string, string]> = {
    QUEUED: ["排队中", "Queued"],
    RUNNING: ["测试中", "Running"],
    COMPLETED: ["已完成", "Completed"],
    CANCELLED: ["已取消", "Cancelled"],
    FAILED: ["已停止", "Stopped"],
  };
  return uiText(locale, ...labels[status]);
}

function outcomeLabel(outcome: ConsistencySample["outcome"], locale: UiLocale): string {
  const labels: Record<ConsistencySample["outcome"], [string, string]> = {
    VALID_ACTION: ["有效决策", "Valid"],
    INVALID_DECISION: ["非法决策", "Illegal"],
    PROTOCOL_ERROR: ["协议错误", "Protocol error"],
    INFRA_ERROR: ["调用错误", "API error"],
  };
  return uiText(locale, ...labels[outcome]);
}

function dimensionLabel(dimension: typeof DIMENSIONS[number], locale: UiLocale): string {
  const labels: Record<typeof DIMENSIONS[number], [string, string]> = {
    street: ["阶段", "Street"],
    tableSize: ["人数", "Table size"],
    potType: ["底池", "Pot type"],
    position: ["位置", "Position"],
    stackDepth: ["筹码", "Stack depth"],
    handClass: ["牌型", "Hand class"],
  };
  return uiText(locale, ...labels[dimension]);
}

function dimensionValue(value: string, locale: UiLocale): string {
  const labels: Record<string, [string, string]> = {
    PREFLOP: ["翻牌前", "Pre-flop"], FLOP: ["翻牌", "Flop"], TURN: ["转牌", "Turn"], RIVER: ["河牌", "River"],
    UNOPENED: ["未开池", "Unopened"], OPEN_RAISED: ["已开池", "Open-raised"], HEADS_UP: ["单挑池", "Heads-up"], MULTIWAY: ["多人池", "Multiway"], SIDE_POT: ["边池", "Side pot"],
    EARLY: ["前位", "Early"], IN_POSITION: ["有利位置", "In position"], OUT_OF_POSITION: ["不利位置", "Out of position"], SANDWICH: ["夹心位", "Sandwich"],
    SHORT: ["短码", "Short"], MEDIUM: ["中筹", "Medium"], DEEP: ["深筹", "Deep"],
  };
  const label = labels[value];
  if (label) return uiText(locale, ...label);
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function playerLabel(playerId: unknown, locale: UiLocale): string {
  if (playerId === "hero") return uiText(locale, "测试模型", "Model");
  const match = typeof playerId === "string" ? /opponent-seat-(\d+)/.exec(playerId) : null;
  return match ? uiText(locale, `${match[1]} 号位`, `Seat ${match[1]}`) : String(playerId ?? "—");
}

function compactHistoryItem(event: Record<string, unknown>, locale: UiLocale): string | null {
  if (event.type === "forced_bet") {
    const kind = event.kind === "SMALL_BLIND" ? "SB" : event.kind === "BIG_BLIND" ? "BB" : String(event.kind ?? "Ante");
    return `${playerLabel(event.player_id, locale)} ${kind} ${formatChips(Number(event.amount ?? 0))}`;
  }
  if (event.type === "action") {
    const amount = Number(event.amount_to ?? 0);
    const amountText = amount > 0 && ["bet", "raise", "all_in"].includes(String(event.action)) ? ` ${formatChips(amount)}` : "";
    return `${playerLabel(event.player_id, locale)} ${actionLabel(String(event.action ?? ""), locale)}${amountText}`;
  }
  return null;
}

function ScenarioCards({ scenario }: { scenario: ConsistencyScenario }) {
  return <div className="consistency-cards">
    <div>{scenario.preview.holeCards.map((card) => <PlayingCard key={card} card={card} compact />)}</div>
    <i />
    <div>{Array.from({ length: 5 }, (_, index) => <PlayingCard key={index} card={scenario.preview.board[index]} compact />)}</div>
  </div>;
}

function ScenarioPreview({ scenario, open = false }: { scenario: ConsistencyScenario; open?: boolean }) {
  const { locale, text } = useUiPreferences();
  const history = scenario.preview.actionHistory
    .map((event) => compactHistoryItem(event, locale))
    .filter((item): item is string => item !== null);
  return <details className="consistency-scenario" open={open}>
    <summary>
      <span>{scenario.id}</span>
      <div><strong>{locale === "zh-CN" ? scenario.title.zh : scenario.title.en}</strong><small>{locale === "zh-CN" ? scenario.summary.zh : scenario.summary.en}</small></div>
      <b>{formatArenaPhase(scenario.tags.street, locale)}</b>
    </summary>
    <div className="consistency-scenario-body">
      <ScenarioCards scenario={scenario} />
      <dl>
        <div><dt>{text("位置", "Position")}</dt><dd>{scenario.preview.heroPosition}</dd></div>
        <div><dt>{text("剩余筹码", "Stack")}</dt><dd>{formatChips(scenario.preview.heroStack)} · {scenario.preview.heroStackBb.toFixed(1)} BB</dd></div>
        <div><dt>{text("行动前底池", "Pot before action")}</dt><dd>{formatChips(scenario.preview.potBeforeAction)}</dd></div>
        <div><dt>{text("在池玩家", "Contenders")}</dt><dd>{scenario.tags.contenders}</dd></div>
      </dl>
      <div className="consistency-action-chain" aria-label={text("行动链", "Action chain")}>
        {history.map((item, index) => <span key={`${item}-${index}`}>{item}</span>)}
        <strong>{text("测试模型行动", "Model to act")}</strong>
      </div>
      <div className="consistency-legal"><span>{text("合法动作", "Legal actions")}</span>{scenario.preview.legalActions.map((item) => <b key={item}>{actionLabel(item, locale)}</b>)}</div>
    </div>
  </details>;
}

function RunHistory({ runs, onSelect }: { runs: ConsistencyRun[]; onSelect: (id: string) => void }) {
  const { locale, text } = useUiPreferences();
  if (runs.length === 0) return <p className="consistency-history-empty">{text("还没有测试记录", "No test runs yet")}</p>;
  return <div className="consistency-history">
    {runs.slice(0, 8).map((run) => <button type="button" key={run.id} onClick={() => onSelect(run.id)}>
      <span><strong>{tierLabel(run.tier, locale)}</strong><small>{new Date(run.createdAt).toLocaleString(locale, { dateStyle: "short", timeStyle: "short" })}</small></span>
      <span><b className={`consistency-run-dot is-${run.status.toLowerCase()}`} />{runStatusLabel(run.status, locale)}</span>
    </button>)}
  </div>;
}

function ConsistencySetup({
  model,
  csrfToken,
  registry,
  prompts,
  runs,
  onStarted,
  onSelectRun,
  onRunsChanged,
}: {
  model: ModelConfig;
  csrfToken: string;
  registry: ConsistencyScenarioRegistry;
  prompts: SystemPromptVersion[];
  runs: ConsistencyRun[];
  onStarted: (id: string) => void;
  onSelectRun: (id: string) => void;
  onRunsChanged: () => Promise<void>;
}) {
  const { locale, text } = useUiPreferences();
  const [tier, setTier] = useState<ConsistencyTier>("quick");
  const [scenarioId, setScenarioId] = useState(registry.scenarios[0]?.id ?? "");
  const [sampleCount, setSampleCount] = useState(10);
  const [timeoutSeconds, setTimeoutSeconds] = useState(180);
  const compatiblePrompts = prompts.filter((prompt) => prompt.status === "ACTIVE" && prompt.protocolBundleId === "arena-native-v11");
  const [promptId, setPromptId] = useState(compatiblePrompts.find((prompt) => prompt.isDefault)?.id ?? compatiblePrompts[0]?.id ?? "");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedIds = tier === "single" ? [scenarioId] : registry.presets[tier];
  const selectedScenarios = selectedIds.map((id) => registry.scenarios.find((scenario) => scenario.id === id)).filter((scenario): scenario is ConsistencyScenario => Boolean(scenario));
  const totalCalls = selectedScenarios.length * sampleCount;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setWorking(true);
    setError(null);
    try {
      const body = {
        tier,
        sampleCount,
        systemPromptVersionId: promptId,
        timeoutMs: timeoutSeconds * 1_000,
        ...(tier === "single" ? { scenarioId } : {}),
      };
      const response = await apiRequest<{ run: ConsistencyRun }>(`/api/admin/models/${model.id}/consistency-runs`, {
        method: "POST", csrfToken, body: JSON.stringify(body),
      });
      await onRunsChanged();
      onStarted(response.run.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : text("无法开始一致性测试", "Unable to start consistency test"));
    } finally { setWorking(false); }
  };

  return <form className="consistency-setup" onSubmit={submit}>
    <aside className="consistency-config">
      <section>
        <h3>{text("测试范围", "Test scope")}</h3>
        <div className="consistency-tier-grid">
          {(["quick", "standard", "full"] as const).map((value) => <button className={tier === value ? "selected" : ""} type="button" key={value} onClick={() => setTier(value)}>
            <strong>{tierLabel(value, locale)}</strong><span>{registry.presets[value].length} {text("场景", "scenarios")}</span>
          </button>)}
          <button className={tier === "single" ? "selected" : ""} type="button" onClick={() => setTier("single")}><strong>{tierLabel("single", locale)}</strong><span>{text("用于调试", "Diagnostic")}</span></button>
        </div>
        {tier === "single" && <label className="consistency-field"><span>{text("选择场景", "Scenario")}</span><SelectControl value={scenarioId} onChange={setScenarioId} options={registry.scenarios.map((scenario) => ({ value: scenario.id, label: `${scenario.id} · ${locale === "zh-CN" ? scenario.title.zh : scenario.title.en}` }))} /></label>}
      </section>
      <section>
        <h3>{text("重复次数", "Samples per scenario")}</h3>
        <div className="consistency-choice-row">{[10, 20, 30].map((value) => <button className={sampleCount === value ? "selected" : ""} type="button" key={value} onClick={() => setSampleCount(value)}>{value}</button>)}</div>
      </section>
      <section className="consistency-runtime-fields">
        <label className="consistency-field"><span>System Prompt</span><SelectControl value={promptId} onChange={setPromptId} required options={compatiblePrompts.map((prompt) => ({ value: prompt.id, label: `${prompt.name}${prompt.isDefault ? text(" · 默认", " · Default") : ""}` }))} /></label>
        <label className="consistency-field"><span>{text("单次超时", "Per-call timeout")}</span><div className="consistency-duration-field"><input type="number" min={30} max={600} step={10} value={timeoutSeconds} onChange={(event) => setTimeoutSeconds(Number(event.target.value))} /><b>{text("秒", "sec")}</b></div></label>
      </section>
      <div className="consistency-call-total"><span>{text("本次真实调用", "Live API calls")}</span><strong>{totalCalls}</strong><small>{text("串行执行；供应商可能产生费用", "Runs serially; provider charges may apply")}</small></div>
      {error && <p className="form-error">{error}</p>}
      <button className="button primary wide" disabled={working || !promptId || selectedScenarios.length === 0}>{working ? text("正在创建…", "Starting…") : text(`开始 ${totalCalls} 次调用`, `Run ${totalCalls} calls`)}</button>
      <section className="consistency-past-runs"><h3>{text("最近测试", "Recent runs")}</h3><RunHistory runs={runs} onSelect={onSelectRun} /></section>
    </aside>
    <main className="consistency-registry">
      <header><div><span>{registry.version}</span><h3>{text(`${selectedScenarios.length} 个规则引擎场景`, `${selectedScenarios.length} engine-built scenarios`)}</h3></div><dl><div><dt>{text("翻牌前", "Pre-flop")}</dt><dd>{selectedScenarios.filter((scenario) => scenario.tags.street === "PREFLOP").length}</dd></div><div><dt>{text("翻牌后", "Post-flop")}</dt><dd>{selectedScenarios.filter((scenario) => scenario.tags.street !== "PREFLOP").length}</dd></div><div><dt>{text("多人池", "Multiway")}</dt><dd>{selectedScenarios.filter((scenario) => scenario.tags.contenders > 2).length}</dd></div></dl></header>
      <div className="consistency-scenario-list">{selectedScenarios.map((scenario, index) => <ScenarioPreview key={scenario.id} scenario={scenario} open={selectedScenarios.length === 1 || index === 0} />)}</div>
    </main>
  </form>;
}

function ActionDistribution({ summary }: { summary: ScenarioConsistencySummary }) {
  const { locale } = useUiPreferences();
  const entries = ACTION_ORDER.map((action) => [action, summary.actionDistribution[action] ?? 0] as const).filter(([, count]) => count > 0);
  if (entries.length === 0) return <span>—</span>;
  return <div className="consistency-distribution">
    {entries.map(([action, count]) => <div key={action}><span><b>{actionLabel(action, locale)}</b><i>{count}</i></span><em><i style={{ width: `${summary.validActions > 0 ? count / summary.validActions * 100 : 0}%` }} /></em></div>)}
  </div>;
}

function SampleRows({ samples }: { samples: ConsistencySample[] }) {
  const { locale, text } = useUiPreferences();
  return <div className="consistency-samples">
    <div className="consistency-sample-head"><span>#</span><span>{text("结果", "Result")}</span><span>{text("动作", "Action")}</span><span>{text("理由 / 错误", "Reason / error")}</span><span>{text("耗时", "Latency")}</span></div>
    {samples.map((sample) => <div className={`is-${sample.outcome.toLowerCase()}`} key={sample.id}>
      <span>{sample.sampleIndex}</span>
      <span>{outcomeLabel(sample.outcome, locale)}</span>
      <strong>{actionLabel(sample.action, locale)}{sample.amountTo !== null ? ` ${formatChips(sample.amountTo)}` : ""}</strong>
      <p>{sample.decisionSummary || sample.errorMessage || "—"}</p>
      <time>{duration(sample.latencyMs)}</time>
    </div>)}
  </div>;
}

function ScenarioResult({ scenario, summary, samples }: { scenario: ConsistencyScenario; summary: ScenarioConsistencySummary; samples: ConsistencySample[] }) {
  const { locale, text } = useUiPreferences();
  const sizes = Object.entries(summary.sizing);
  return <details className="consistency-result-scenario">
    <summary>
      <span>{scenario.id}</span>
      <div><strong>{locale === "zh-CN" ? scenario.title.zh : scenario.title.en}</strong><small>{actionLabel(summary.dominantAction, locale)} · {summary.dominantCount}/{summary.validActions}</small></div>
      <b>{percent(summary.pairwiseAgreement)}</b>
      <i>{percent(summary.validityRate)}</i>
    </summary>
    <div className="consistency-result-detail">
      <section><ScenarioCards scenario={scenario} /><ActionDistribution summary={summary} />{sizes.length > 0 && <div className="consistency-sizing">{sizes.map(([action, sizing]) => <span key={action}><b>{actionLabel(action, locale)}</b>{text("中位", "median")} {formatChips(sizing.median)} · {formatChips(sizing.min)}–{formatChips(sizing.max)}</span>)}</div>}</section>
      <SampleRows samples={samples} />
    </div>
  </details>;
}

function ConsistencyResult({ run, csrfToken, onBack }: { run: ConsistencyRun; csrfToken: string; onBack: () => void }) {
  const { locale, text } = useUiPreferences();
  const [dimension, setDimension] = useState<typeof DIMENSIONS[number]>("street");
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const summary = run.summary;
  const progress = run.totalSamples > 0 ? run.completedSamples / run.totalSamples : 0;
  const dimensionEntries = Object.entries(summary?.dimensions[dimension] ?? {}).sort(([left], [right]) => left.localeCompare(right));
  const scenarios = run.scenarios ?? [];
  const samples = run.samples ?? [];

  return <div className="consistency-result">
    <header className="consistency-result-header">
      <button type="button" onClick={onBack}>← {text("新测试", "New test")}</button>
      <div><span>{tierLabel(run.tier, locale)} · {run.scenarioIds.length} {text("场景", "scenarios")} × {run.sampleCount}</span><h3>{run.modelDisplayName}</h3><small>{run.promptName} · {run.effectiveOutputMode} · {Math.round(run.timeoutMs / 1_000)}s</small></div>
      <strong className={`is-${run.status.toLowerCase()}`}><i />{runStatusLabel(run.status, locale)}</strong>
    </header>
    <div className="consistency-progress"><i style={{ width: `${Math.max(2, progress * 100)}%` }} /><span>{run.completedSamples} / {run.totalSamples}</span></div>
    {run.errorMessage && <div className="notice error">{run.errorMessage}</div>}
    {error && <p className="form-error">{error}</p>}
    {(run.status === "QUEUED" || run.status === "RUNNING") && <div className="consistency-running-note"><span>{text("每个样本使用完全相同的可见输入；测试将在后台继续。", "Every sample uses the same visible input; the run continues in the background.")}</span><button className="button secondary" type="button" disabled={cancelling} onClick={async () => { setCancelling(true); setError(null); try { await apiRequest(`/api/admin/consistency-runs/${run.id}/cancel`, { method: "POST", csrfToken }); } catch (reason) { setError(reason instanceof Error ? reason.message : text("取消失败", "Unable to cancel")); } finally { setCancelling(false); } }}>{cancelling ? text("正在取消…", "Cancelling…") : text("取消测试", "Cancel run")}</button></div>}
    <section className="consistency-metrics">
      <article><span>{text("主导动作占比", "Modal action share")}</span><strong>{percent(summary?.meanDominantShare)}</strong><small>{text("各场景平均", "Mean across scenarios")}</small></article>
      <article><span>{text("两两一致率", "Pairwise agreement")}</span><strong>{percent(summary?.meanPairwiseAgreement)}</strong><small>{text("任取两次动作相同的概率", "Chance two actions match")}</small></article>
      <article><span>{text("协议有效率", "Protocol validity")}</span><strong>{percent(summary?.validityRate)}</strong><small>{summary ? `${summary.validActions} / ${summary.completedSamples}` : "—"}</small></article>
      <article><span>P95 {text("耗时", "latency")}</span><strong>{duration(summary?.p95LatencyMs)}</strong><small>{summary?.totalTokens ? `${formatChips(summary.totalTokens)} tokens` : text("Token 未完整上报", "Token usage unavailable")}</small></article>
    </section>
    {summary && <section className="consistency-dimensions">
      <header><h3>{text("行为画像", "Behavior profile")}</h3><div>{DIMENSIONS.map((item) => <button className={dimension === item ? "selected" : ""} type="button" key={item} onClick={() => setDimension(item)}>{dimensionLabel(item, locale)}</button>)}</div></header>
      <div className="consistency-dimension-table"><div><span>{dimensionLabel(dimension, locale)}</span><span>{text("场景", "Scenarios")}</span><span>{text("主导占比", "Modal share")}</span><span>{text("两两一致", "Pairwise")}</span><span>{text("有效率", "Validity")}</span></div>{dimensionEntries.map(([value, metrics]) => <div key={value}><strong>{dimensionValue(value, locale)}</strong><span>{metrics.scenarios}</span><span>{percent(metrics.meanDominantShare)}</span><span>{percent(metrics.meanPairwiseAgreement)}</span><span>{percent(metrics.validityRate)}</span></div>)}</div>
    </section>}
    <section className="consistency-results-list">
      <header><div><h3>{text("逐场景结果", "Scenario results")}</h3><span>{text("展开查看每次决策理由", "Expand for every decision reason")}</span></div><div><b>{text("两两一致", "Pairwise")}</b><i>{text("有效率", "Validity")}</i></div></header>
      {scenarios.map((scenario) => {
        const scenarioSummary = summary?.scenarios.find((item) => item.scenarioId === scenario.id);
        if (!scenarioSummary) return null;
        return <ScenarioResult key={scenario.id} scenario={scenario} summary={scenarioSummary} samples={samples.filter((sample) => sample.scenarioId === scenario.id)} />;
      })}
    </section>
    <footer className="consistency-run-audit"><span>{text("输入指纹", "Input fingerprint")} {run.modelConfigurationHash.slice(0, 10)} / {run.systemPromptHash.slice(0, 10)} / {run.outputSchemaHash.slice(0, 10)}</span><span>{run.scenarioRegistryVersion}</span></footer>
  </div>;
}

export function ConsistencyTestModal({ model, csrfToken, onClose }: { model: ModelConfig; csrfToken: string; onClose: () => void }) {
  const { text } = useUiPreferences();
  const registry = useApiResource<ConsistencyScenarioRegistry>("/api/admin/consistency/scenarios");
  const prompts = useApiResource<{ versions: SystemPromptVersion[] }>("/api/admin/system-prompts");
  const runs = useApiResource<{ runs: ConsistencyRun[] }>(`/api/admin/consistency-runs?modelConfigId=${encodeURIComponent(model.id)}`);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const runDetail = useApiResource<{ run: ConsistencyRun }>(selectedRunId ? `/api/admin/consistency-runs/${selectedRunId}` : null, selectedRunId ? 1_500 : 0);
  const loading = registry.loading || prompts.loading || runs.loading;
  const error = registry.error || prompts.error || runs.error;
  const currentRun = runDetail.data?.run;

  const content = useMemo(() => {
    if (loading) return <div className="consistency-modal-state"><i /><span>{text("正在读取场景注册库", "Loading scenario registry")}</span></div>;
    if (error || !registry.data || !prompts.data || !runs.data) return <div className="consistency-modal-state is-error"><strong>!</strong><span>{error ?? text("测试配置不可用", "Test configuration unavailable")}</span><button className="button secondary" type="button" onClick={() => void Promise.all([registry.refresh(), prompts.refresh(), runs.refresh()])}>{text("重新读取", "Retry")}</button></div>;
    if (selectedRunId) {
      if (!currentRun) return <div className="consistency-modal-state"><i /><span>{text("正在读取测试结果", "Loading run results")}</span></div>;
      return <ConsistencyResult run={currentRun} csrfToken={csrfToken} onBack={() => setSelectedRunId(null)} />;
    }
    return <ConsistencySetup model={model} csrfToken={csrfToken} registry={registry.data} prompts={prompts.data.versions} runs={runs.data.runs} onStarted={setSelectedRunId} onSelectRun={setSelectedRunId} onRunsChanged={runs.refresh} />;
  }, [csrfToken, currentRun, error, loading, model, prompts.data, registry.data, runs.data, selectedRunId, text]);

  return <Modal className="consistency-modal" title={`${text("行为一致性", "Behavior consistency")} · ${model.displayName}`} onClose={onClose}>{content}</Modal>;
}
