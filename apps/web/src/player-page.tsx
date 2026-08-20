import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  PublicCompetitorProfile,
} from "../../../packages/contracts/src/competitors";
import { Link, useParams } from "react-router-dom";
import { useApiResource } from "./api";
import { EmptyState, ErrorBlock, LoadingBlock, modelTint } from "./components";
import {
  buildPlayerProfileModel,
  formatProfilePercent,
  formatProfileTokens,
  canonicalPlayerUrl,
  playerStoryCardFilename,
  type PlayerResultTrendPoint,
  profileConsistencyTierLabel,
  profileEventClassLabel,
  profileResultScopeLabel,
} from "./player-profile-model";
import { PlayerStoryCard } from "./player-story-card";
import { localizedMomentCopy, publicMomentTagLabel } from "./moment-presentation";
import { copyShareLink, downloadShareCard } from "./moment-share";
import { ProviderLogo } from "./provider-logo";
import { useUiPreferences } from "./ui-preferences";

interface CompetitorProfileResponse {
  profile: PublicCompetitorProfile;
}

type ShareState = "idle" | "working" | "done" | "error";

function signedBb(value: number): string {
  const rounded = value.toFixed(Math.abs(value) >= 100 ? 0 : 1);
  return `${value > 0 ? "+" : ""}${rounded} BB`;
}

function PlayerFormChart({ results }: { results: readonly PlayerResultTrendPoint[] }) {
  const { locale, text } = useUiPreferences();
  const chronological = useMemo(() => results.slice(-12), [results]);
  if (chronological.length === 0) return null;
  const width = 720;
  const height = 220;
  const inset = { top: 24, right: 20, bottom: 42, left: 48 };
  const values = chronological.map((result) => result.netBigBlinds);
  const minValue = Math.min(0, ...values);
  const maxValue = Math.max(0, ...values);
  const span = Math.max(10, maxValue - minValue);
  const x = (index: number) => inset.left + (chronological.length === 1
    ? (width - inset.left - inset.right) / 2
    : index / (chronological.length - 1) * (width - inset.left - inset.right));
  const y = (value: number) => inset.top + (maxValue - value) / span * (height - inset.top - inset.bottom);
  const points = chronological.map((result, index) => `${x(index)},${y(result.netBigBlinds)}`).join(" ");
  const zeroY = y(0);
  const labelStep = Math.max(1, Math.ceil(chronological.length / 4));
  return (
    <div className="player-form-chart">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={text("近期赛事净大盲走势", "Recent net big-blind trend")}>
        <line className="player-chart-zero" x1={inset.left} x2={width - inset.right} y1={zeroY} y2={zeroY} />
        <text className="player-chart-axis" x={inset.left - 8} y={zeroY + 4} textAnchor="end">0</text>
        <polyline className="player-chart-line" points={points} />
        {chronological.map((result, index) => {
          const edgePoint = index === 0 || index === chronological.length - 1;
          const showLabel = chronological.length <= 5 || edgePoint || index % labelStep === 0;
          const showValue = chronological.length <= 6 || edgePoint || result.finishingPosition === 1;
          return <g className={result.finishingPosition === 1 ? "is-win" : ""} key={result.tournamentId}>
            <title>{`${result.tournamentName}: ${signedBb(result.netBigBlinds)}, #${result.finishingPosition}`}</title>
            <circle className="player-chart-point-halo" cx={x(index)} cy={y(result.netBigBlinds)} r="8" />
            <circle className="player-chart-point" cx={x(index)} cy={y(result.netBigBlinds)} r="4" />
            {showValue && <text className="player-chart-value" x={x(index)} y={y(result.netBigBlinds) - 13} textAnchor="middle">{result.netBigBlinds > 0 ? "+" : ""}{result.netBigBlinds.toFixed(0)}</text>}
            {showLabel && <text className="player-chart-label" x={x(index)} y={height - 14} textAnchor="middle">
              {new Date(result.completedAt).toLocaleDateString(locale, { month: "numeric", day: "numeric" })}
            </text>}
          </g>;
        })}
      </svg>
    </div>
  );
}

function Metric({ label, value, emphasis = false }: { label: string; value: string | number; emphasis?: boolean }) {
  return <div className={emphasis ? "is-emphasis" : ""}><span>{label}</span><strong>{value}</strong></div>;
}

export function PlayerPage() {
  const { competitorId = "" } = useParams();
  const { locale, text } = useUiPreferences();
  const normalizedId = competitorId.trim().toLocaleLowerCase("en-US");
  const resource = useApiResource<CompetitorProfileResponse>(
    normalizedId ? `/api/public/competitors/${encodeURIComponent(normalizedId)}` : null,
  );
  const profile = resource.data?.profile.competitor.id === normalizedId ? resource.data.profile : null;
  const headingRef = useRef<HTMLHeadingElement>(null);
  const exportCardRef = useRef<HTMLElement>(null);
  const copyTimerRef = useRef<number | null>(null);
  const exportTimerRef = useRef<number | null>(null);
  const [copyState, setCopyState] = useState<ShareState>("idle");
  const [exportState, setExportState] = useState<ShareState>("idle");

  useLayoutEffect(() => {
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    if (exportTimerRef.current !== null) window.clearTimeout(exportTimerRef.current);
    copyTimerRef.current = null;
    exportTimerRef.current = null;
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    setCopyState("idle");
    setExportState("idle");
  }, [normalizedId]);
  useLayoutEffect(() => {
    if (profile) headingRef.current?.focus({ preventScroll: true });
  }, [profile]);
  useEffect(() => () => {
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    if (exportTimerRef.current !== null) window.clearTimeout(exportTimerRef.current);
  }, []);
  useEffect(() => {
    if (!profile) return;
    const previous = document.title;
    document.title = `${profile.competitor.displayName} · ${text("德扑竞技场", "Hold'em Arena")}`;
    return () => { document.title = previous; };
  }, [profile, text]);

  if (resource.loading || (normalizedId && !profile && !resource.error)) {
    return <main className="page-shell player-page"><LoadingBlock label={text("正在读取选手档案", "Loading player profile")} /></main>;
  }
  if (resource.errorStatus === 400 || resource.errorStatus === 404) {
    return (
      <main className="page-shell player-page">
        <nav className="analysis-back-nav" aria-label={text("选手档案导航", "Player profile navigation")}>
          <Link className="analysis-back-link" to="/leaderboard"><span aria-hidden="true">←</span>{text("返回模型排行榜", "Back to rankings")}</Link>
        </nav>
        <EmptyState
          title={text("没有这位选手", "Player not found")}
          body={text("这个公开选手档案不存在，或已不再公开。", "This public player profile does not exist or is no longer available.")}
        />
      </main>
    );
  }
  if (resource.error || !profile) {
    return (
      <main className="page-shell player-page">
        <nav className="analysis-back-nav" aria-label={text("选手档案导航", "Player profile navigation")}>
          <Link className="analysis-back-link" to="/leaderboard"><span aria-hidden="true">←</span>{text("返回模型排行榜", "Back to rankings")}</Link>
        </nav>
        <ErrorBlock message={text("无法找到或载入这个选手档案。", "This player profile could not be found or loaded.")} onRetry={() => void resource.refresh()} />
      </main>
    );
  }

  const { competitor, competition, reliability, efficiency, consistency, career } = profile;
  const viewModel = buildPlayerProfileModel(profile, locale);
  const rankingScope = competition.rank === null
    ? text("尚未进入排行榜", "Not yet ranked")
    : profile.competitiveScope.benchmarkCohortId ?? text("当前评级组", "Current rated cohort");
  const copyProfileLink = async () => {
    setCopyState("working");
    try {
      await copyShareLink(canonicalPlayerUrl(window.location.origin, competitor.id));
      setCopyState("done");
    } catch {
      setCopyState("error");
    }
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    copyTimerRef.current = window.setTimeout(() => setCopyState("idle"), 1_800);
  };
  const downloadCard = async () => {
    const node = exportCardRef.current;
    if (!node) return setExportState("error");
    setExportState("working");
    try {
      await downloadShareCard(node, playerStoryCardFilename(profile));
      setExportState("done");
    } catch {
      setExportState("error");
    }
    if (exportTimerRef.current !== null) window.clearTimeout(exportTimerRef.current);
    exportTimerRef.current = window.setTimeout(() => setExportState("idle"), 2_200);
  };
  return (
    <main className="page-shell player-page">
      <nav className="analysis-back-nav" aria-label={text("选手档案导航", "Player profile navigation")}>
        <Link className="analysis-back-link" to="/leaderboard"><span aria-hidden="true">←</span>{text("返回模型排行榜", "Back to rankings")}</Link>
      </nav>

      <header className="player-hero">
        <div className="player-hero-identity">
          <ProviderLogo
            brand={competitor.providerBrand}
            fallback={competitor.displayName.trim().slice(0, 1).toLocaleUpperCase() || "?"}
            fallbackStyle={modelTint(competitor.id)}
            className="player-hero-logo"
          />
          <div>
            <span className={`player-status is-${competitor.status.toLocaleLowerCase()}`}><i />{competitor.status === "ACTIVE" ? text("现役选手", "Active player") : text("已退役", "Retired")}</span>
            <h1 ref={headingRef} tabIndex={-1}>{competitor.displayName}</h1>
            <p>{competitor.currentRevision?.modelId ?? text("暂无当前模型版本", "No current model revision")}{competitor.currentRevision ? ` · R${competitor.currentRevision.revisionNumber}` : ""}</p>
          </div>
        </div>
        <div className="player-hero-rank">
          <div><span>{text("当前排名", "Current rank")}</span><strong>{competition.rank === null ? "—" : `#${String(competition.rank).padStart(2, "0")}`}</strong></div>
          <div><span>Rating</span><strong>{competition.rating ?? "—"}</strong></div>
          <div className="player-hero-scope">
            <small>{rankingScope}</small>
            {competition.sampleWarning && <b>{text("样本有限", "Limited sample")}</b>}
          </div>
        </div>
        <div className="player-hero-actions">
          <button type="button" disabled={copyState === "working"} onClick={() => void copyProfileLink()}>{copyState === "working" ? text("复制中…", "Copying…") : copyState === "done" ? text("已复制", "Copied") : copyState === "error" ? text("复制失败，请重试", "Copy failed — retry") : text("复制链接", "Copy link")}</button>
          <button className="is-secondary" type="button" disabled={exportState === "working"} onClick={() => void downloadCard()}>{exportState === "working" ? text("生成中…", "Exporting…") : exportState === "done" ? text("已下载", "Downloaded") : exportState === "error" ? text("生成失败，请重试", "Export failed — retry") : text("下载选手卡", "Download card")}</button>
          <span aria-live="polite">{copyState === "done" ? text("链接已复制", "Link copied") : copyState === "error" ? text("链接复制失败", "Link copy failed") : ""}</span>
          <span aria-live="polite">{exportState === "done" ? text("图片已下载", "Image downloaded") : exportState === "error" ? text("图片生成失败", "Image export failed") : ""}</span>
        </div>
      </header>

      <section className="player-scoreboard" aria-label={text("竞技成绩", "Competitive record")}>
        <Metric label={text("评级组赛事", "Rated events")} value={competition.tournaments} />
        <Metric label={text("冠军", "Titles")} value={competition.championships} emphasis />
        <Metric label={text("前三率", "Top 3 rate")} value={viewModel.rates.topThree} />
        <Metric label={text("平均名次", "Avg finish")} value={competition.averageFinish === null ? "—" : competition.averageFinish.toFixed(2)} />
        <Metric label={text("积分", "Points")} value={competition.points.toFixed(1)} />
        <Metric label={text("生涯手数", "Career hands")} value={career.handsPlayed.toLocaleString(locale)} />
      </section>

      <div className="player-analysis-grid">
        <section className="player-dossier player-style-panel">
          <header><div><span>{text("牌风档案", "Playing style")}</span><h2>{viewModel.styleLabel}</h2></div>{viewModel.sampleWarnings.style && <b>{viewModel.sampleWarnings.style}</b>}</header>
          <div className="player-metric-grid four">
            <Metric label="VPIP" value={viewModel.rates.vpip} emphasis />
            <Metric label="PFR" value={viewModel.rates.pfr} />
            <Metric label="3-BET" value={viewModel.rates.threeBet} />
            <Metric label={text("摊牌胜率", "Showdown win")} value={viewModel.rates.showdownWin} />
          </div>
        </section>

        <section className="player-dossier">
          <header><div><span>{text("决策可靠性", "Decision reliability")}</span><h2>{viewModel.rates.validDecision}</h2></div>{viewModel.sampleWarnings.reliability && <b>{viewModel.sampleWarnings.reliability}</b>}</header>
          <div className="player-metric-grid three">
            <Metric label={text("一次成功", "First pass")} value={viewModel.rates.firstPass} />
            <Metric label={text("协议纠错", "Corrections")} value={reliability.protocolCorrections} />
            <Metric label={text("规则兜底", "Fallbacks")} value={reliability.fallbacks} />
            <Metric label={text("超时", "Timeouts")} value={reliability.timeouts} />
            <Metric label={text("基础设施暂停", "Infra pauses")} value={reliability.infrastructurePauses} />
            <Metric label={text("决策数", "Decisions")} value={reliability.decisions} />
          </div>
        </section>

        <section className="player-dossier">
          <header><div><span>{text("调用效率", "Model efficiency")}</span><h2>{viewModel.efficiency.averageLatency}</h2></div>{viewModel.sampleWarnings.efficiency && <b>{viewModel.sampleWarnings.efficiency}</b>}</header>
          <div className="player-metric-grid three">
            <Metric label={text("95% 响应", "P95 latency")} value={viewModel.efficiency.p95Latency} />
            <Metric label={text("每次决策", "Per decision")} value={formatProfileTokens(efficiency.tokensPerDecision, locale)} />
            <Metric label={text("总 Token", "Total tokens")} value={formatProfileTokens(efficiency.totalTokens, locale)} />
            <Metric label={text("Token 覆盖", "Token coverage")} value={formatProfilePercent(efficiency.tokenUsageCoverage, locale)} />
            <Metric label={text("调用次数", "Provider calls")} value={efficiency.providerCalls.toLocaleString(locale)} />
          </div>
        </section>

        <section className="player-dossier player-consistency-panel">
          <header><div><span>{text("决策一致性", "Decision consistency")}</span><h2>{viewModel.rates.dominantDecision}</h2></div>{consistency && <b>{profileConsistencyTierLabel(consistency.tier, locale)}</b>}</header>
          {consistency ? <div className="player-metric-grid three">
            <Metric label={text("有效率", "Validity")} value={viewModel.rates.consistencyValidity} />
            <Metric label={text("两两一致", "Pairwise")} value={viewModel.rates.pairwiseAgreement} />
            <Metric label={text("场景", "Scenarios")} value={consistency.scenarioCount} />
            <Metric label={text("样本", "Samples")} value={consistency.completedSamples} />
            <Metric label={text("提示词", "Prompt")} value={consistency.promptName} />
          </div> : <p className="player-panel-empty">{text("当前版本还没有完成一致性检测", "No completed consistency run for this revision")}</p>}
        </section>
      </div>

      <section className="player-section player-results-section">
        <header><div><span>{text("赛事履历", "Tournament record")}</span><h2>{text("近期状态", "Recent form")}</h2></div><strong>{career.appearances} {text("场", "events")}</strong></header>
        <PlayerFormChart results={viewModel.resultTrend} />
        {profile.recentResults.length === 0 ? <p className="player-panel-empty">{text("还没有已完成赛事", "No completed events yet")}</p> : (
          <div className="player-results-table">
            <div className="player-results-head"><span>{text("赛事", "Event")}</span><span>{text("名次", "Finish")}</span><span>{text("净大盲", "Net BB")}</span><span>{text("峰值", "Peak")}</span><span>{text("有效决策", "Valid")}</span><span>Token</span></div>
            {profile.recentResults.map((result) => (
              <Link to={`/tournaments/${result.tournamentId}/replay`} key={`${result.tournamentId}-${result.competitorRevisionId}`}>
                <span>
                  <strong>{result.name}</strong>
                  <small>{new Date(result.completedAt).toLocaleDateString(locale, { dateStyle: "medium" })} · {profileEventClassLabel(result.eventClass, locale)} · {profileResultScopeLabel(result.countedInCurrentRanking, result.eventClass, locale)}</small>
                </span>
                <span className="player-result-cell">
                  <small className="player-result-label">{text("名次", "Finish")}</small>
                  <b className={result.finishingPosition === 1 ? "is-win" : ""}>#{result.finishingPosition}</b>
                </span>
                <span className="player-result-cell">
                  <small className="player-result-label">{text("净大盲", "Net BB")}</small>
                  <b className={result.netBigBlinds >= 0 ? "is-positive" : "is-negative"}>{signedBb(result.netBigBlinds)}</b>
                </span>
                <span className="player-result-cell">
                  <small className="player-result-label">{text("峰值", "Peak")}</small>
                  <b>{result.peakStackBigBlinds.toFixed(1)} BB</b>
                </span>
                <span className="player-result-cell">
                  <small className="player-result-label">{text("有效决策", "Valid")}</small>
                  <b>{formatProfilePercent(result.validDecisionRate, locale)}</b>
                </span>
                <span className="player-result-cell">
                  <small className="player-result-label">Token</small>
                  <b>{formatProfileTokens(result.totalTokens, locale)}</b>
                  {result.totalTokens !== null && result.tokenUsageCoverage !== 1 ? <small className="player-result-coverage">{text("覆盖", "Coverage")} {formatProfilePercent(result.tokenUsageCoverage, locale)}</small> : null}
                </span>
              </Link>
            ))}
          </div>
        )}
      </section>

      {profile.featuredMoments.length > 0 && (
        <section className="player-section player-moments-section">
          <header><div><span>{text("赛场名场面", "Signature hands")}</span><h2>{text("精彩瞬间", "Highlights")}</h2></div><strong>{profile.featuredMoments.length}</strong></header>
          <div className="player-moment-grid">
            {profile.featuredMoments.map((moment) => {
              const copy = localizedMomentCopy(moment, locale);
              return (
                <Link to={`/moments/${moment.slug}`} key={moment.id}>
                  <div><span>H{String(moment.handNo).padStart(3, "0")}</span><b>{publicMomentTagLabel(moment, locale, false)}</b></div>
                  <h3>{copy.title}</h3>
                  {copy.summary && <p>{copy.summary}</p>}
                  <footer><span>{moment.facts.potBigBlinds.toFixed(moment.facts.potBigBlinds % 1 === 0 ? 0 : 1)} BB</span><b>{moment.score}/100</b><i aria-hidden="true">↗</i></footer>
                </Link>
              );
            })}
          </div>
        </section>
      )}

      <section className="player-card-preview">
        <header><div><span>{text("可传播选手身份", "Shareable player identity")}</span><h2>{text("选手卡片", "Player card")}</h2></div><strong>PNG · 1200 × 675</strong></header>
        <PlayerStoryCard profile={profile} locale={locale} />
      </section>
      <div className="player-story-export-host" aria-hidden="true">
        <PlayerStoryCard ref={exportCardRef} profile={profile} locale={locale} fixed />
      </div>
    </main>
  );
}
