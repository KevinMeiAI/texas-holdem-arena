import { useState } from "react";
import { Link } from "react-router-dom";
import { formatChips, modelTint } from "./components";
import { playerProfilePath } from "./player-profile-model";
import type { ProviderBrand } from "./provider-brand";
import { ProviderLogo } from "./provider-logo";
import type { TournamentPlayerStatistics, TournamentStatistics } from "./types";
import { type UiLocale, uiText, useUiPreferences } from "./ui-preferences";

type ReportView = "competition" | "poker" | "reliability" | "efficiency";

interface ReportMetric {
  label: string;
  value: string;
  detail?: string;
  tone?: "positive" | "negative" | undefined;
}

function formatRate(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(0)}%`;
}

function formatBigBlinds(value: number): string {
  const prefix = value > 0 ? "+" : "";
  return `${prefix}${value.toFixed(1)} BB`;
}

function formatLatency(value: number | null, locale: UiLocale): string {
  if (value === null) return "—";
  return value < 1_000 ? `${Math.round(value)} ${uiText(locale, "毫秒", "ms")}` : `${(value / 1_000).toFixed(1)} ${uiText(locale, "秒", "s")}`;
}

function formatCount(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function metricsFor(player: TournamentPlayerStatistics, view: ReportView, locale: UiLocale): ReportMetric[] {
  if (view === "competition") {
    return [
      { label: uiText(locale, "淘汰", "Knockouts"), value: formatCount(player.knockouts) },
      { label: uiText(locale, "存活", "Survival"), value: `${player.handsPlayed} ${uiText(locale, "手", "hands")}`, detail: `${uiText(locale, "赢得", "Won")} ${player.potsWon} ${uiText(locale, "个底池", "pots")}` },
      { label: uiText(locale, "领跑", "Chip lead"), value: formatRate(player.chipLeadRate), detail: `${player.chipLeadHands} ${uiText(locale, "手结束时第一", "hands in first")}` },
      { label: uiText(locale, "峰值", "Peak stack"), value: formatChips(player.peakStack), detail: `${player.peakStackBigBlinds.toFixed(1)} BB` },
      {
        label: uiText(locale, "净赢大盲", "Net BB"),
        value: formatBigBlinds(player.netBigBlinds),
        tone: player.netBigBlinds > 0 ? "positive" : player.netBigBlinds < 0 ? "negative" : undefined,
      },
    ];
  }
  if (view === "poker") {
    return [
      { label: uiText(locale, "主动入池", "VPIP"), value: formatRate(player.vpipRate), detail: `${player.vpipHands}/${player.handsPlayed}` },
      { label: uiText(locale, "翻前加注", "PFR"), value: formatRate(player.pfrRate), detail: `${player.pfrHands}/${player.handsPlayed}` },
      { label: uiText(locale, "再加注率", "3-bet"), value: formatRate(player.threeBetRate), detail: `${player.threeBetHands}/${player.threeBetOpportunities} ${uiText(locale, "次机会", "opportunities")}` },
      { label: uiText(locale, "摊牌胜率", "Showdown win"), value: formatRate(player.showdownWinRate), detail: `${player.showdownWins}/${player.showdownHands}` },
      {
        label: uiText(locale, "全下运气差", "All-in luck"),
        value: player.allInHands === 0 ? "—" : formatBigBlinds(player.allInLuckBigBlinds),
        detail: player.allInHands === 0
          ? uiText(locale, "没有终局全下", "No terminal all-in")
          : `${player.allInHands} · ${player.allInEstimatedHands > 0 ? `${player.allInEstimatedHands} ${uiText(locale, "次估算", "estimated")}` : uiText(locale, "精确枚举", "Exact")}`,
        tone: player.allInLuckBigBlinds > 0 ? "positive" : player.allInLuckBigBlinds < 0 ? "negative" : undefined,
      },
    ];
  }
  if (view === "reliability") {
    return [
      { label: uiText(locale, "有效决策", "Valid decisions"), value: formatRate(player.validDecisionRate), detail: `${player.validDecisions}/${player.decisions}` },
      { label: uiText(locale, "一次成功", "First pass"), value: formatRate(player.firstPassRate), detail: `${player.firstPassDecisions}/${player.decisions}` },
      { label: uiText(locale, "协议纠错", "Corrections"), value: String(player.protocolCorrections) },
      { label: uiText(locale, "超时 / 暂停", "Timeouts / pauses"), value: `${player.timeouts} / ${player.infrastructurePauses}`, detail: `${player.infrastructureRetries} ${uiText(locale, "次重试", "retries")}` },
      { label: uiText(locale, "规则兜底", "Fallbacks"), value: String(player.fallbacks), tone: player.fallbacks > 0 ? "negative" : undefined },
    ];
  }
  return [
    { label: uiText(locale, "平均响应", "Average"), value: formatLatency(player.averageLatencyMs, locale) },
    { label: uiText(locale, "95% 响应", "P95"), value: formatLatency(player.p95LatencyMs, locale) },
    { label: uiText(locale, "供应商调用", "Provider calls"), value: String(player.providerCalls), detail: `${player.decisions} ${uiText(locale, "次决策", "decisions")}` },
    { label: "Token", value: player.totalTokens === null ? "—" : player.totalTokens.toLocaleString(locale) },
    { label: uiText(locale, "用量覆盖", "Usage coverage"), value: formatRate(player.tokenUsageCoverage) },
  ];
}

export function TournamentStatisticsReport({
  statistics,
  playerBrands,
  playerCompetitorIds,
}: {
  statistics: TournamentStatistics;
  playerBrands: Readonly<Record<string, ProviderBrand | null>>;
  playerCompetitorIds: Readonly<Record<string, string>>;
}) {
  const { locale, text } = useUiPreferences();
  const [view, setView] = useState<ReportView>("competition");
  const reportViews: { id: ReportView; label: string }[] = [
    { id: "competition", label: text("竞技表现", "Competition") },
    { id: "poker", label: text("牌风数据", "Playing style") },
    { id: "reliability", label: text("调用稳定性", "Reliability") },
    { id: "efficiency", label: text("响应效率", "Efficiency") },
  ];
  const activeView = reportViews.find((item) => item.id === view)!;
  const champion = statistics.players.find((player) => player.finishingPosition === 1);
  const championIdentity = champion && <>
    <ProviderLogo
      brand={playerBrands[champion.playerId] ?? null}
      fallback={champion.displayName.trim().slice(0, 1).toLocaleUpperCase() || "—"}
      fallbackStyle={modelTint(champion.playerId)}
    />
    <div><small>{text("本场冠军", "Champion")}</small><strong title={champion.displayName}>{champion.displayName}</strong></div>
  </>;
  const championCompetitorId = champion ? playerCompetitorIds[champion.playerId] : undefined;

  return (
    <section className="tournament-report" aria-labelledby="tournament-report-heading">
      <header className="tournament-report-heading">
        <div>
          <h2 id="tournament-report-heading">{text("赛后战报", "Tournament report")}</h2>
        </div>
      </header>
      <div className="report-overview">
        <div className="report-champion">
          {championIdentity && championCompetitorId
            ? <Link className="report-champion-link" to={playerProfilePath(championCompetitorId)} aria-label={text(`查看 ${champion?.displayName} 的选手档案`, `View ${champion?.displayName} player profile`)}>{championIdentity}</Link>
            : championIdentity ?? <div><small>{text("本场冠军", "Champion")}</small><strong>{text("尚未产生", "Pending")}</strong></div>}
        </div>
        <dl>
          <div><dt>{text("完成手数", "Hands")}</dt><dd>{statistics.completedHands}</dd></div>
          <div><dt>{text("参赛模型", "Models")}</dt><dd>{statistics.players.length}</dd></div>
          <div><dt>{text("总筹码", "Total chips")}</dt><dd>{formatChips(statistics.totalChips)}</dd></div>
        </dl>
      </div>
      <div className="report-tabs compact-tabs" role="tablist" aria-label={text("选择赛事统计维度", "Select report view")}>
        {reportViews.map((item) => (
          <button
            type="button"
            role="tab"
            aria-selected={item.id === view}
            className={item.id === view ? "active" : ""}
            onClick={() => setView(item.id)}
            key={item.id}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div className="report-players" role="table" aria-label={`${activeView.label} ${text("排名", "ranking")}`}>
        {statistics.players.map((player) => {
          const identity = <>
            <ProviderLogo
              brand={playerBrands[player.playerId] ?? null}
              fallback={player.displayName.trim().slice(0, 1).toLocaleUpperCase() || "?"}
              fallbackStyle={modelTint(player.playerId)}
            />
            <div><strong title={player.displayName}>{player.displayName}</strong><small>{player.finishingPosition === 1 ? text("冠军", "Champion") : `${text("第", "Rank")} ${player.finishingPosition ?? "—"} ${text("名", "")}`}</small></div>
          </>;
          const competitorId = playerCompetitorIds[player.playerId];
          return <article className="report-player" role="row" key={player.playerId}>
            <div className="report-player-identity" role="rowheader">
              <b>{player.finishingPosition ?? "—"}</b>
              {competitorId
                ? <Link className="report-player-profile-link" to={playerProfilePath(competitorId)} aria-label={text(`查看 ${player.displayName} 的选手档案`, `View ${player.displayName} player profile`)}>{identity}</Link>
                : <span className="report-player-profile-link">{identity}</span>}
            </div>
            <div className="report-player-metrics">
              {metricsFor(player, view, locale).map((metric) => (
                <div role="cell" className={metric.tone ? `is-${metric.tone}` : ""} key={metric.label}>
                  <span>{metric.label}</span>
                  <strong>{metric.value}</strong>
                  <small>{metric.detail}</small>
                </div>
              ))}
            </div>
          </article>;
        })}
      </div>
    </section>
  );
}
