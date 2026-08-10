import { useState } from "react";
import { formatChips } from "./components";
import type { TournamentPlayerStatistics, TournamentStatistics } from "./types";

type ReportView = "competition" | "poker" | "reliability" | "efficiency";

const REPORT_VIEWS: { id: ReportView; label: string; description: string }[] = [
  { id: "competition", label: "竞技表现", description: "名次、淘汰与按当手大盲折算的筹码表现" },
  { id: "poker", label: "牌风数据", description: "只描述打法，不参与竞技主榜计分" },
  { id: "reliability", label: "调用稳定性", description: "模型是否能持续交付可执行的合法决策" },
  { id: "efficiency", label: "响应效率", description: "调用耗时与已记录的 Token 消耗" },
];

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

function formatLatency(value: number | null): string {
  if (value === null) return "—";
  return value < 1_000 ? `${Math.round(value)} 毫秒` : `${(value / 1_000).toFixed(1)} 秒`;
}

function formatCount(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function metricsFor(player: TournamentPlayerStatistics, view: ReportView): ReportMetric[] {
  if (view === "competition") {
    return [
      { label: "淘汰", value: formatCount(player.knockouts), detail: "多人平分淘汰记分" },
      { label: "存活", value: `${player.handsPlayed} 手`, detail: `赢得 ${player.potsWon} 个底池` },
      { label: "领跑", value: formatRate(player.chipLeadRate), detail: `${player.chipLeadHands} 手结束时筹码第一` },
      { label: "峰值", value: formatChips(player.peakStack), detail: `${player.peakStackBigBlinds.toFixed(1)} BB` },
      {
        label: "净赢大盲",
        value: formatBigBlinds(player.netBigBlinds),
        detail: "逐手按当时大盲折算",
        tone: player.netBigBlinds > 0 ? "positive" : player.netBigBlinds < 0 ? "negative" : undefined,
      },
    ];
  }
  if (view === "poker") {
    return [
      { label: "主动入池", value: formatRate(player.vpipRate), detail: `VPIP · ${player.vpipHands}/${player.handsPlayed}` },
      { label: "翻前加注", value: formatRate(player.pfrRate), detail: `PFR · ${player.pfrHands}/${player.handsPlayed}` },
      { label: "再加注手牌", value: formatRate(player.threeBetRate), detail: `3-Bet · ${player.threeBetHands} 手` },
      { label: "摊牌胜率", value: formatRate(player.showdownWinRate), detail: `${player.showdownWins}/${player.showdownHands} 次摊牌` },
      {
        label: "全下运气差",
        value: player.allInHands === 0 ? "—" : formatBigBlinds(player.allInLuckBigBlinds),
        detail: player.allInHands === 0
          ? "没有进入终局全下"
          : `${player.allInHands} 次 · ${player.allInEstimatedHands > 0 ? `${player.allInEstimatedHands} 次抽样估算` : "精确枚举"}`,
        tone: player.allInLuckBigBlinds > 0 ? "positive" : player.allInLuckBigBlinds < 0 ? "negative" : undefined,
      },
    ];
  }
  if (view === "reliability") {
    return [
      { label: "有效决策", value: formatRate(player.validDecisionRate), detail: `${player.validDecisions}/${player.decisions} 次无需兜底` },
      { label: "一次成功", value: formatRate(player.firstPassRate), detail: `${player.firstPassDecisions}/${player.decisions} 次无需纠错或重试` },
      { label: "协议纠错", value: String(player.protocolCorrections), detail: "格式、动作或查询协议" },
      { label: "超时 / 暂停", value: `${player.timeouts} / ${player.infrastructurePauses}`, detail: `${player.infrastructureRetries} 次基础设施重试` },
      { label: "规则兜底", value: String(player.fallbacks), detail: player.fallbacks === 0 ? "全部由模型完成" : "由引擎执行安全动作", tone: player.fallbacks > 0 ? "negative" : undefined },
    ];
  }
  return [
    { label: "平均响应", value: formatLatency(player.averageLatencyMs), detail: "所有已完成供应商调用" },
    { label: "95% 响应", value: formatLatency(player.p95LatencyMs), detail: "较慢调用的边界" },
    { label: "供应商调用", value: String(player.providerCalls), detail: `${player.decisions} 次牌桌决策` },
    { label: "Token", value: player.totalTokens === null ? "—" : player.totalTokens.toLocaleString("zh-CN"), detail: "输入与输出合计" },
    { label: "用量覆盖", value: formatRate(player.tokenUsageCoverage), detail: "供应商返回 Token 的调用占比" },
  ];
}

export function TournamentStatisticsReport({ statistics }: { statistics: TournamentStatistics }) {
  const [view, setView] = useState<ReportView>("competition");
  const activeView = REPORT_VIEWS.find((item) => item.id === view)!;
  const champion = statistics.players.find((player) => player.finishingPosition === 1);

  return (
    <section className="tournament-report" aria-labelledby="tournament-report-heading">
      <header className="tournament-report-heading">
        <div>
          <span>赛事统计</span>
          <h2 id="tournament-report-heading">赛后战报</h2>
          <p>全部指标从不可改写的牌局事件与模型调用记录重新计算。</p>
        </div>
        <i>已审计</i>
      </header>
      <div className="report-overview">
        <div className="report-champion">
          <span className="model-monogram">{champion?.displayName.slice(0, 1).toUpperCase() ?? "—"}</span>
          <div><small>本场冠军</small><strong>{champion?.displayName ?? "尚未产生"}</strong></div>
        </div>
        <dl>
          <div><dt>完成手数</dt><dd>{statistics.completedHands}</dd></div>
          <div><dt>参赛模型</dt><dd>{statistics.players.length}</dd></div>
          <div><dt>总筹码</dt><dd>{formatChips(statistics.totalChips)}</dd></div>
        </dl>
      </div>
      <div className="report-tabs" role="tablist" aria-label="选择赛事统计维度">
        {REPORT_VIEWS.map((item) => (
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
      <p className="report-view-description">{activeView.description}</p>
      <div className="report-players" role="table" aria-label={`${activeView.label}排名`}>
        {statistics.players.map((player) => (
          <article className="report-player" role="row" key={player.playerId}>
            <div className="report-player-identity" role="rowheader">
              <b>{player.finishingPosition ?? "—"}</b>
              <span className="model-monogram">{player.displayName.slice(0, 1).toUpperCase()}</span>
              <div><strong>{player.displayName}</strong><small>{player.finishingPosition === 1 ? "冠军" : `第 ${player.finishingPosition ?? "—"} 名`}</small></div>
            </div>
            <div className="report-player-metrics">
              {metricsFor(player, view).map((metric) => (
                <div role="cell" className={metric.tone ? `is-${metric.tone}` : ""} key={metric.label}>
                  <span>{metric.label}</span>
                  <strong>{metric.value}</strong>
                  <small>{metric.detail}</small>
                </div>
              ))}
            </div>
          </article>
        ))}
      </div>
      <footer className="report-methodology">
        <b>口径说明</b>
        <p>{view === "competition" ? "筹码输赢先按每一手当时的大盲换算，避免盲注上涨造成数值失真。"
          : view === "poker" ? "牌风指标只用于描述模型打法；样本较少时不代表长期水平。全下运气差为实际赢得减理论期望。"
            : view === "reliability" ? "有效决策指规则引擎无需启用安全兜底；基础设施表现不会改变竞技名次。"
              : "货币成本需要冻结各供应商单价后才能可靠计算，当前只展示真实返回的 Token。"}</p>
      </footer>
    </section>
  );
}
