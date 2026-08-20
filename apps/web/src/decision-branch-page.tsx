import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import type {
  DecisionBranchActionHistoryItem,
  DecisionBranchTarget,
  PublicDecisionBranchDto,
} from "../../../packages/contracts/src/decision-branches";
import { useApiResource } from "./api";
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
  buildDecisionBranchActionMatrix,
  decisionBranchActionLabel,
  decisionBranchActionWithAmountLabel,
  decisionBranchForcedBetLabel,
  decisionBranchLegalActionPresentations,
  localizedDecisionBranchCopy,
  type DecisionBranchActionCell,
  type DecisionBranchActionMatrixRow,
} from "./decision-branch-page-model";
import { copyShareLink } from "./moment-share";
import { playerProfilePath } from "./player-profile-model";
import { ProviderLogo } from "./provider-logo";
import { type UiLocale, useUiPreferences } from "./ui-preferences";

interface PublicDecisionBranchResponse {
  decisionBranch: PublicDecisionBranchDto;
}

type BranchSource = PublicDecisionBranchDto["snapshot"]["source"];
type BranchPlayer = BranchSource["players"][number];
type BranchTrial = DecisionBranchTarget["trials"][number];
type CopyState = "idle" | "working" | "done" | "error";

function percent(value: number | null, locale: UiLocale): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(locale, {
    style: "percent",
    maximumFractionDigits: 1,
  }).format(value);
}

function duration(milliseconds: number | null, locale: UiLocale): string {
  if (milliseconds === null || !Number.isFinite(milliseconds)) return "—";
  if (milliseconds < 1_000) return locale === "zh-CN"
    ? `${Math.round(milliseconds)} 毫秒`
    : `${Math.round(milliseconds)} ms`;
  const seconds = milliseconds / 1_000;
  return locale === "zh-CN"
    ? `${seconds.toFixed(seconds < 10 ? 1 : 0)} 秒`
    : `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`;
}

function playerStatus(player: BranchPlayer, locale: UiLocale): string | null {
  if (player.folded) return locale === "zh-CN" ? "已弃牌" : "Folded";
  if (player.allIn) return locale === "zh-CN" ? "已全下" : "All-in";
  return null;
}

function PlayerIdentity({ player, className = "" }: { player: BranchPlayer; className?: string }) {
  const content = <>
    <ProviderLogo
      brand={player.providerBrand}
      fallback={player.displayName.trim().slice(0, 1).toLocaleUpperCase() || "?"}
      fallbackStyle={modelTint(player.competitorId ?? player.playerId)}
      className="decision-branch-player-logo"
    />
    <span><strong title={player.displayName}>{player.displayName}</strong><small>{player.position ?? `S${player.seat + 1}`}</small></span>
  </>;
  return player.competitorId
    ? <Link className={`decision-branch-player-identity ${className}`} to={playerProfilePath(player.competitorId)}>{content}</Link>
    : <span className={`decision-branch-player-identity ${className}`}>{content}</span>;
}

function TargetIdentity({ target, compact = false }: { target: DecisionBranchTarget; compact?: boolean }) {
  return (
    <Link
      className={`decision-branch-target-identity${compact ? " is-compact" : ""}`}
      to={playerProfilePath(target.competitorId)}
    >
      <ProviderLogo
        brand={target.providerBrand}
        fallback={target.displayName.trim().slice(0, 1).toLocaleUpperCase() || "?"}
        fallbackStyle={modelTint(target.competitorId)}
        className="decision-branch-target-logo"
      />
      <span><strong title={target.displayName}>{target.displayName}</strong><small title={target.modelId}>{target.modelId}</small></span>
    </Link>
  );
}

function actionHistoryText(
  item: DecisionBranchActionHistoryItem,
  source: BranchSource,
  locale: UiLocale,
): string {
  const player = item.playerId
    ? source.players.find((candidate) => candidate.playerId === item.playerId)?.displayName
      ?? (locale === "zh-CN" ? "未知选手" : "Unknown player")
    : null;
  const amount = item.amount === null ? "" : ` ${formatChips(item.amount)}`;
  if (item.type === "FORCED_BET") {
    return `${player ?? "—"} · ${decisionBranchForcedBetLabel(item.label, locale)}${amount}`;
  }
  if (item.type === "STREET_STARTED") {
    return locale === "zh-CN"
      ? `进入${formatArenaPhase(item.street ?? source.street, locale)}`
      : `${formatArenaPhase(item.street ?? source.street, locale)} begins`;
  }
  if (item.type === "BOARD_DEALT") {
    const cards = item.cards.join(" ");
    return `${formatArenaPhase(item.street ?? source.street, locale)} · ${cards}`;
  }
  if (item.type === "UNCALLED_BET_RETURNED") {
    return locale === "zh-CN"
      ? `${player ?? "—"} · 退回未跟注筹码${amount}`
      : `${player ?? "—"} · Uncalled bet returned${amount}`;
  }
  if (item.type === "ACTION" && item.action) {
    let action = decisionBranchActionWithAmountLabel(item.action, item.amountTo, locale);
    const actionAmount = item.action === "all_in"
      ? item.amountTo ?? item.amount
      : item.action === "call" ? item.amount : null;
    if (actionAmount !== null && actionAmount > 0) {
      action = `${action} ${formatChips(actionAmount)}`;
    }
    return `${player ?? "—"} · ${action}`;
  }
  return item.label ?? item.type;
}

function SourceDecision({ source }: { source: BranchSource }) {
  const { locale, text } = useUiPreferences();
  const hero = source.players.find((player) => player.playerId === source.heroPlayerId) ?? null;
  const legalActions = decisionBranchLegalActionPresentations(source.legalActions, locale);
  const players = [...source.players].sort((left, right) => left.seat - right.seat);
  const history = [...source.actionHistory].sort((left, right) => left.sequence - right.sequence);
  const board = Array.from({ length: 5 }, (_, index) => source.board[index]);
  const allInAmountTo = source.legalActions.all_in?.resulting_street_commitment ?? null;
  return (
    <section className="decision-branch-section decision-branch-source" aria-labelledby="decision-branch-source-title">
      <header className="decision-branch-section-heading">
        <div><span>{text("决策点", "Decision point")}</span><h2 id="decision-branch-source-title">{source.heroDisplayName}</h2></div>
        <b>#{source.actionSequence}</b>
      </header>

      <div className="decision-branch-source-grid">
        <div className="decision-branch-card-stage">
          <div className="decision-branch-card-group">
            <span>{text("手牌", "Hole cards")}</span>
            <div>{source.heroHoleCards.map((card) => <PlayingCard card={card} compact key={card} />)}</div>
          </div>
          <div className="decision-branch-card-group is-board">
            <span>{text("公共牌", "Board")}</span>
            <div>{board.map((card, index) => <PlayingCard card={card} compact key={`${card ?? "empty"}-${index}`} />)}</div>
          </div>
        </div>

        <dl className="decision-branch-facts">
          <div><dt>{text("位置", "Position")}</dt><dd>{source.heroPosition}</dd></div>
          <div><dt>{text("剩余筹码", "Stack")}</dt><dd>{hero ? `${formatChips(hero.stack)} · ${hero.stackBigBlinds.toFixed(1)} BB` : "—"}</dd></div>
          <div><dt>{text("行动前底池", "Pot before action")}</dt><dd>{formatChips(source.potBeforeAction)} · {source.potBigBlinds.toFixed(1)} BB</dd></div>
          <div><dt>{text("跟注额", "To call")}</dt><dd>{formatChips(source.callAmount)}</dd></div>
          <div><dt>{text("当前下注", "Current bet")}</dt><dd>{formatChips(source.currentBet)}</dd></div>
          <div><dt>{text("盲注", "Blinds")}</dt><dd>{formatChips(source.blinds.smallBlind)} / {formatChips(source.blinds.bigBlind)}{source.blinds.bigBlindAnte > 0 ? ` · ${text("大盲前注", "BBA")} ${formatChips(source.blinds.bigBlindAnte)}` : ""}</dd></div>
        </dl>
      </div>

      <div className="decision-branch-original">
        <div>
          <span>{text("原模型决策", "Original decision")}</span>
          <strong>{decisionBranchActionWithAmountLabel(source.originalDecision.action, source.originalDecision.amountTo, locale, allInAmountTo)}</strong>
          {source.originalDecision.usedFallback && <small>{text("规则回退", "Protocol fallback")}</small>}
        </div>
        <blockquote>{source.originalDecision.decisionSummary ?? text("原决策没有公开理由。", "No public reason was recorded for the original decision.")}</blockquote>
      </div>

      <div className="decision-branch-legal-actions" aria-label={text("合法动作", "Legal actions")}>
        <span>{text("合法动作", "Legal actions")}</span>
        <div>{legalActions.map((action) => <b key={action.action}>{action.text}</b>)}</div>
      </div>

      <div
        className="decision-branch-lineup"
        style={{ "--decision-lineup-columns": players.length <= 6 ? players.length : Math.ceil(players.length / 2) } as CSSProperties}
      >
        {players.map((player) => {
          const status = playerStatus(player, locale);
          return <article className={player.playerId === source.heroPlayerId ? "is-hero" : ""} key={player.playerId}>
            <PlayerIdentity player={player} />
            <div>
              <b>{formatChips(player.stack)}</b>
              <small>{player.stackBigBlinds.toFixed(1)} BB</small>
              {player.streetCommitted > 0 && <small>{text("本街已投入", "Committed")} {formatChips(player.streetCommitted)}</small>}
            </div>
            {status && <em>{status}</em>}
          </article>;
        })}
      </div>

      {history.length > 0 && <details className="decision-branch-history">
        <summary>{text(`查看此前 ${history.length} 个公开事件`, `Show ${history.length} prior public events`)}</summary>
        <ol>{history.map((item) => <li key={item.sequence}><span>#{item.sequence}</span><p>{actionHistoryText(item, source, locale)}</p></li>)}</ol>
      </details>}
    </section>
  );
}

function MatrixCell({ cell }: { cell: DecisionBranchActionCell }) {
  const { locale, text } = useUiPreferences();
  const share = cell.share;
  const style = {
    "--decision-share": `${Math.round((share ?? 0) * 58)}%`,
  } as CSSProperties;
  return (
    <div className={`decision-branch-matrix-cell${cell.isModal ? " is-modal" : ""}${share === null ? " is-empty" : ""}`} style={style}>
      <strong>{share === null ? "—" : cell.count}</strong>
      <small>{share === null ? text("无有效动作", "No valid action") : percent(share, locale)}</small>
      {cell.isModal && <em>{text("众数", "Mode")}</em>}
    </div>
  );
}

function MatrixOutcome({ row }: { row: DecisionBranchActionMatrixRow }) {
  const { locale, text } = useUiPreferences();
  return <div className="decision-branch-matrix-outcome">
    <span><b>{row.modelActionTrials}</b><small>{text("有效动作", "valid actions")}</small></span>
    <span><b>{row.fallbackTrials}</b><small>{text("回退", "fallbacks")}</small></span>
    <span><b>{row.infrastructureErrorTrials}</b><small>{text("调用失败", "API errors")}</small></span>
    <span><b>{percent(row.pairwiseAgreement, locale)}</b><small>{text("两两一致", "pairwise")}</small></span>
  </div>;
}

function DecisionMatrix({ branch }: { branch: PublicDecisionBranchDto }) {
  const { locale, text } = useUiPreferences();
  const matrix = useMemo(() => buildDecisionBranchActionMatrix(branch.snapshot), [branch.snapshot]);
  const targets = new Map(branch.snapshot.targets.map((target) => [target.ordinal, target]));
  const allInAmountTo = branch.snapshot.source.legalActions.all_in?.resulting_street_commitment ?? null;
  return (
    <section className="decision-branch-section decision-branch-comparison" aria-labelledby="decision-branch-comparison-title">
      <header className="decision-branch-section-heading">
        <div>
          <span>{text("同一输入，多次决策", "Same input, repeated decisions")}</span>
          <h2 id="decision-branch-comparison-title">{text("模型决策矩阵", "Model decision matrix")}</h2>
        </div>
        <p>{text("百分比仅以模型成功返回的有效动作为分母；规则回退与调用失败单独列出。", "Percentages use valid model actions only; protocol fallbacks and API errors are reported separately.")}</p>
      </header>

      <div className="decision-branch-matrix-scroll">
        <table>
          <caption className="visually-hidden">{text("原决策与目标模型动作分布", "Original decision and target-model action distribution")}</caption>
          <thead><tr>
            <th scope="col">{text("模型", "Model")}</th>
            {matrix.columns.map((column) => <th scope="col" className={!column.legal ? "is-anomaly" : ""} key={column.action}>
              {decisionBranchActionLabel(column.action, locale)}
            </th>)}
            <th scope="col">{text("样本结果", "Sample outcomes")}</th>
          </tr></thead>
          <tbody>
            <tr className="is-original">
              <th scope="row"><span>{text("原决策", "Original")}</span><strong>{branch.snapshot.source.heroDisplayName}</strong></th>
              {matrix.columns.map((column) => <td key={column.action}>{matrix.original.action === column.action
                ? <div className="decision-branch-original-cell"><strong>{decisionBranchActionWithAmountLabel(matrix.original.action, matrix.original.amountTo, locale, allInAmountTo)}</strong><small>{text("实际选择", "Observed choice")}</small></div>
                : <span className="decision-branch-cell-dash">—</span>}</td>)}
              <td><span className="decision-branch-single-sample">1 × {text("真实决策", "live decision")}</span></td>
            </tr>
            {matrix.rows.map((row) => {
              const target = targets.get(row.ordinal);
              if (!target) return null;
              return <tr key={row.ordinal}>
                <th scope="row"><TargetIdentity target={target} compact /></th>
                {row.cells.map((cell) => <td key={cell.action}><MatrixCell cell={cell} /></td>)}
                <td><MatrixOutcome row={row} /></td>
              </tr>;
            })}
          </tbody>
        </table>
      </div>

      <div className="decision-branch-mobile-matrix">
        <article className="is-original">
          <header><span>{text("原决策", "Original")}</span><strong>{branch.snapshot.source.heroDisplayName}</strong></header>
          <b>{decisionBranchActionWithAmountLabel(matrix.original.action, matrix.original.amountTo, locale, allInAmountTo)}</b>
        </article>
        {matrix.rows.map((row) => {
          const target = targets.get(row.ordinal);
          if (!target) return null;
          return <article key={row.ordinal}>
            <TargetIdentity target={target} compact />
            <div className="decision-branch-mobile-actions">{row.cells.map((cell) => <div key={cell.action}>
              <span>{decisionBranchActionLabel(cell.action, locale)}</span><MatrixCell cell={cell} />
            </div>)}</div>
            <MatrixOutcome row={row} />
          </article>;
        })}
      </div>
    </section>
  );
}

function trialOutcomeLabel(trial: BranchTrial, locale: UiLocale): string {
  const labels: Record<BranchTrial["outcome"], [string, string]> = {
    MODEL_ACTION: ["模型动作", "Model action"],
    PROTOCOL_FALLBACK: ["协议回退", "Protocol fallback"],
    INFRA_ERROR: ["调用失败", "API error"],
    CANCELLED: ["未完成", "Cancelled"],
  };
  return labels[trial.outcome][locale === "zh-CN" ? 0 : 1];
}

function trialReason(trial: BranchTrial, locale: UiLocale): string {
  if (trial.decisionSummary) return trial.decisionSummary;
  if (trial.outcome === "PROTOCOL_FALLBACK") return locale === "zh-CN"
    ? "模型输出未通过协议校验，规则引擎执行了安全回退。"
    : "The model output failed protocol validation, so the rules engine applied a safe fallback.";
  if (trial.outcome === "INFRA_ERROR") return locale === "zh-CN"
    ? "本次供应商调用失败，不计入动作分布。"
    : "This provider call failed and is excluded from the action distribution.";
  if (trial.outcome === "CANCELLED") return locale === "zh-CN"
    ? "本次样本没有完成。"
    : "This sample did not complete.";
  return locale === "zh-CN" ? "模型没有返回公开理由。" : "The model returned no public reason.";
}

function TrialRow({ trial, allInAmountTo }: { trial: BranchTrial; allInAmountTo: number | null }) {
  const { locale, text } = useUiPreferences();
  return <li className={`is-${trial.outcome.toLocaleLowerCase()}`}>
    <span>#{String(trial.sampleIndex).padStart(2, "0")}</span>
    <div><b>{trialOutcomeLabel(trial, locale)}</b><strong>{trial.action
      ? decisionBranchActionWithAmountLabel(trial.action, trial.amountTo, locale, allInAmountTo)
      : "—"}</strong></div>
    <p>{trialReason(trial, locale)}</p>
    {trial.usedFallback && <small>{text("不计入模型动作分布", "Excluded from model-action distribution")}</small>}
  </li>;
}

function Metric({ label, value, note }: { label: string; value: ReactNode; note?: ReactNode }) {
  return <div><span>{label}</span><strong>{value}</strong>{note && <small>{note}</small>}</div>;
}

function TargetEvidence({ target, allInAmountTo }: { target: DecisionBranchTarget; allInAmountTo: number | null }) {
  const { locale, text } = useUiPreferences();
  const trials = [...target.trials].sort((left, right) => left.sampleIndex - right.sampleIndex);
  return (
    <details className="decision-branch-target-evidence">
      <summary>
        <TargetIdentity target={target} />
        <div className="decision-branch-evidence-summary">
          <span><small>{text("有效动作", "Valid actions")}</small><b>{target.modelActionTrials}/{target.requestedSamples}</b></span>
          <span><small>{text("两两一致", "Pairwise")}</small><b>{percent(target.pairwiseAgreement, locale)}</b></span>
          <span><small>{text("平均耗时", "Avg latency")}</small><b>{duration(target.averageLatencyMs, locale)}</b></span>
        </div>
        <i aria-hidden="true">＋</i>
      </summary>
      <div className="decision-branch-evidence-body">
        <div className="decision-branch-evidence-metrics">
          <Metric label={text("首轮有效", "First-turn valid")} value={percent(target.firstTurnValidRate, locale)} />
          <Metric label={text("查询历史", "History query")} value={percent(target.historyQueryRate, locale)} />
          <Metric label={text("协议纠错", "Correction")} value={percent(target.correctionRate, locale)} />
          <Metric label={text("规则回退", "Fallbacks")} value={target.fallbackTrials} note={`/ ${target.completedTrials}`} />
          <Metric label={text("调用失败", "API errors")} value={target.infrastructureErrorTrials} note={`/ ${target.completedTrials}`} />
          <Metric label="P95" value={duration(target.p95LatencyMs, locale)} />
        </div>
        {target.sizing.length > 0 && <div className="decision-branch-sizing">
          <span>{text("下注尺度", "Bet sizing")}</span>
          {target.sizing.map((entry) => <p key={entry.action}>
            <b>{decisionBranchActionLabel(entry.action, locale)}</b>
            {text("中位数", "median")} {formatChips(entry.median)}
            <small>{formatChips(entry.min)}–{formatChips(entry.max)}</small>
          </p>)}
        </div>}
        <ol className="decision-branch-trials">{trials.map((trial) => <TrialRow trial={trial} allInAmountTo={allInAmountTo} key={trial.sampleIndex} />)}</ol>
      </div>
    </details>
  );
}

function Evidence({ targets, allInAmountTo }: { targets: DecisionBranchTarget[]; allInAmountTo: number | null }) {
  const { text } = useUiPreferences();
  return (
    <section className="decision-branch-section decision-branch-evidence" aria-labelledby="decision-branch-evidence-title">
      <header className="decision-branch-section-heading">
        <div><span>{text("逐次证据", "Trial evidence")}</span><h2 id="decision-branch-evidence-title">{text("查看每一次独立输出", "Inspect every independent output")}</h2></div>
        <p>{text("展开模型即可查看每次动作与公开理由。", "Open a model to inspect every action and public reason.")}</p>
      </header>
      <div>{[...targets].sort((left, right) => left.ordinal - right.ordinal).map((target) => <TargetEvidence target={target} allInAmountTo={allInAmountTo} key={target.competitorRevisionId} />)}</div>
    </section>
  );
}

function Methodology({ branch }: { branch: PublicDecisionBranchDto }) {
  const { locale, text } = useUiPreferences();
  const methodology = branch.snapshot.methodology;
  return (
    <section className="decision-branch-methodology" aria-labelledby="decision-branch-methodology-title">
      <div>
        <span>{text("方法", "Method")}</span>
        <h2 id="decision-branch-methodology-title">{text("只重跑当前决策", "Decision-only rerun")}</h2>
      </div>
      <dl>
        <div><dt>{text("输入", "Input")}</dt><dd>{text("所有模型读取同一份可见状态", "Every model receives the same visible state")}</dd></div>
        <div><dt>{text("范围", "Scope")}</dt><dd>{text("不模拟后续行动、公共牌或赛果", "No later actions, board cards, or outcomes are simulated")}</dd></div>
        <div><dt>{text("样本", "Samples")}</dt><dd>{methodology.targetCount} × {methodology.sampleCountPerModel}</dd></div>
        <div><dt>{text("完成时间", "Completed")}</dt><dd>{new Date(methodology.completedAt).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" })}</dd></div>
      </dl>
    </section>
  );
}

export function DecisionBranchPage() {
  const { slug = "" } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { locale, text } = useUiPreferences();
  const normalizedSlug = slug.trim().toLocaleLowerCase("en-US");
  const resource = useApiResource<PublicDecisionBranchResponse>(
    normalizedSlug ? `/api/public/decision-branches/${encodeURIComponent(normalizedSlug)}` : null,
  );
  const branch = resource.data?.decisionBranch.slug.toLocaleLowerCase("en-US") === normalizedSlug
    ? resource.data.decisionBranch
    : null;
  const copy = useMemo(() => branch ? localizedDecisionBranchCopy(branch, locale) : null, [branch, locale]);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const copyTimerRef = useRef<number | null>(null);
  const [copyState, setCopyState] = useState<CopyState>("idle");

  useLayoutEffect(() => {
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    copyTimerRef.current = null;
    setCopyState("idle");
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }, [normalizedSlug]);
  useLayoutEffect(() => {
    if (branch) headingRef.current?.focus({ preventScroll: true });
  }, [branch]);
  useEffect(() => {
    if (!branch || slug === branch.slug) return;
    navigate(`/branches/${branch.slug}`, { replace: true, state: location.state });
  }, [branch, location.state, navigate, slug]);
  useEffect(() => () => {
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
  }, []);
  useEffect(() => {
    if (!copy) return;
    const previous = document.title;
    document.title = `${copy.title} · ${text("德扑竞技场", "Hold'em Arena")}`;
    return () => { document.title = previous; };
  }, [copy, text]);

  if (resource.loading || (normalizedSlug && !branch && !resource.error)) {
    return <main className="page-shell decision-branch-page"><LoadingBlock label={text("正在读取决策分叉", "Loading decision branch")} /></main>;
  }
  if (resource.errorStatus === 404) {
    return <main className="page-shell decision-branch-page">
      <nav className="analysis-back-nav" aria-label={text("决策分叉导航", "Decision branch navigation")}>
        <Link className="analysis-back-link" to="/tournaments"><span aria-hidden="true">←</span>{text("返回赛事列表", "Back to events")}</Link>
      </nav>
      <EmptyState
        title={text("没有这个决策分叉", "Decision branch not found")}
        body={text("它不存在、尚未公开，或已经停止公开。", "It does not exist, is not published yet, or is no longer public.")}
      />
    </main>;
  }
  if (resource.error || !branch || !copy) {
    return <main className="page-shell decision-branch-page">
      <nav className="analysis-back-nav" aria-label={text("决策分叉导航", "Decision branch navigation")}>
        <Link className="analysis-back-link" to="/tournaments"><span aria-hidden="true">←</span>{text("返回赛事列表", "Back to events")}</Link>
      </nav>
      <ErrorBlock message={text("暂时无法载入这份决策分叉报告。", "This decision branch report could not be loaded.")} onRetry={() => void resource.refresh()} />
    </main>;
  }

  const source = branch.snapshot.source;
  const returnPath = `/tournaments/${source.tournamentId}/replay/${source.handNo}`;
  const copyLink = async () => {
    setCopyState("working");
    const url = new URL(`/branches/${branch.slug}`, window.location.origin);
    if (locale === "en") url.searchParams.set("lang", "en");
    try {
      await copyShareLink(url.href);
      setCopyState("done");
    } catch {
      setCopyState("error");
    }
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    copyTimerRef.current = window.setTimeout(() => setCopyState("idle"), 2_000);
  };

  return (
    <main className="page-shell decision-branch-page">
      <nav className="analysis-back-nav" aria-label={text("决策分叉导航", "Decision branch navigation")}>
        <Link className="analysis-back-link" to={returnPath}><span aria-hidden="true">←</span>{text(`返回第 ${String(source.handNo).padStart(3, "0")} 手解析`, `Back to hand ${String(source.handNo).padStart(3, "0")}`)}</Link>
      </nav>

      <header className="decision-branch-hero">
        <div className="decision-branch-hero-copy">
          <span>{source.tournamentName} · H{String(source.handNo).padStart(3, "0")} · {formatArenaPhase(source.street, locale)}</span>
          <h1 ref={headingRef} tabIndex={-1}>{copy.title}</h1>
          {copy.summary && <p>{copy.summary}</p>}
        </div>
        <div className="decision-branch-hero-meta">
          <div><small>{text("方法", "Method")}</small><strong>{text("仅当前决策", "Decision only")}</strong></div>
          <div><small>{text("样本", "Samples")}</small><strong>{branch.snapshot.methodology.targetCount} × {branch.snapshot.methodology.sampleCountPerModel}</strong></div>
          <button type="button" disabled={copyState === "working"} onClick={() => void copyLink()}>
            {copyState === "working" ? text("复制中…", "Copying…") : copyState === "done" ? text("已复制", "Copied") : copyState === "error" ? text("复制失败", "Copy failed") : text("复制链接", "Copy link")}
          </button>
        </div>
      </header>

      <SourceDecision source={source} />
      <DecisionMatrix branch={branch} />
      <Evidence
        targets={branch.snapshot.targets}
        allInAmountTo={source.legalActions.all_in?.resulting_street_commitment ?? null}
      />
      <Methodology branch={branch} />
    </main>
  );
}
