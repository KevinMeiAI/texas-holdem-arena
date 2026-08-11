import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { apiRequest, useApiResource } from "./api";
import { HandActionLedger } from "./hand-action-ledger";
import { StackHistoryChart } from "./stack-history-chart";
import { TournamentStatisticsReport } from "./tournament-statistics";
import {
  EmptyState,
  ErrorBlock,
  EventTape,
  formatArenaPhase,
  formatChips,
  LoadingBlock,
  PageFooter,
  PlayingCard,
  PokerTable,
  SectionHeading,
  StatusBadge,
} from "./components";
import type {
  ArenaEvent,
  ArenaState,
  DecisionAuditTurn,
  HandSummary,
  LeaderboardResponse,
  StackHistoryPoint,
  TournamentStatistics,
  TournamentSummary,
} from "./types";

export function LivePage() {
  const resource = useApiResource<{ state: ArenaState | null }>("/api/public/live", 1_500);
  const state = resource.data?.state ?? null;
  const [events, setEvents] = useState<ArenaEvent[]>([]);
  const [streamStatus, setStreamStatus] = useState<"idle" | "connected" | "reconnecting">("idle");

  useEffect(() => {
    if (!state?.tournamentId) return;
    setEvents([]);
    const source = new EventSource(`/api/public/tournaments/${state.tournamentId}/events?tail=120`);
    const handleArena = (message: MessageEvent<string>) => {
      const event = JSON.parse(message.data) as ArenaEvent;
      setEvents((current) => {
        const next = current.some((item) => item.sequence === event.sequence) ? current : [...current, event];
        return next.slice(-120);
      });
      setStreamStatus("connected");
    };
    source.addEventListener("arena", handleArena as EventListener);
    source.onopen = () => setStreamStatus("connected");
    source.onerror = () => setStreamStatus("reconnecting");
    return () => source.close();
  }, [state?.tournamentId]);

  if (resource.loading) return <main className="page-shell"><LoadingBlock /></main>;
  if (resource.error && !state) return <main className="page-shell"><ErrorBlock message={resource.error} onRetry={() => void resource.refresh()} /></main>;
  if (!state) {
    return (
      <main className="page-shell">
        <section className="hero-empty">
          <h1>牌桌已就绪<br /><span>等待模型入席</span></h1>
          <p>配置模型、锁定同一份 system prompt，然后让确定性规则引擎主持一场完整的单桌锦标赛。</p>
          <div className="button-row"><Link className="button primary" to="/admin/tournaments/new">创建首场赛事</Link><Link className="button secondary" to="/tournaments">查看赛事档案</Link></div>
        </section>
        <div className="principle-strip"><span>同一竞技协议</span><span>无补码锦标赛</span><span>全部事件可回放</span><span>隐藏信息严格隔离</span></div>
        <PageFooter />
      </main>
    );
  }

  const hand = state.hand;
  return (
    <main className="page-shell live-page">
      <div className="live-titlebar">
        <div><h1>{state.name}</h1><p>单桌模型锦标赛 · 公开直播</p></div>
        <div className="live-meta"><StatusBadge status={state.status} /><span>第 <b>{String(hand?.handNo ?? state.completedHands).padStart(3, "0")}</b> 手</span>{hand ? <span>盲注 <b>{formatChips(hand.blinds.smallBlind)} / {formatChips(hand.blinds.bigBlind)}</b></span> : <span>最终筹码 <b>{formatChips(state.players.find((player) => player.id === state.championPlayerId)?.stack)}</b></span>}</div>
      </div>
      <div className="live-layout">
        <PokerTable state={state} />
        <aside className="broadcast-sidebar">
          <div className="panel-heading"><div><h2>权威事件</h2><p>实时记录全部公开动作</p></div><span className={`stream-state ${streamStatus}`}><i />{streamStatus === "connected" ? "同步中" : streamStatus === "reconnecting" ? "正在重连" : "正在连接"}</span></div>
          <EventTape events={events.slice(-28)} players={state.players} />
          <div className="broadcast-facts">
            <div><span>阶段</span><b>{formatArenaPhase(hand?.phase ?? state.status)}</b></div>
            <div><span>在席</span><b>{state.players.filter((player) => player.status !== "ELIMINATED").length} / {state.players.length}</b></div>
            <div><span>种子承诺</span><b title={state.seedCommitment}>{state.seedCommitment.slice(0, 12)}…</b></div>
          </div>
        </aside>
      </div>
      <div className="under-table-bar">
        <span>规则版本 <b>{state.rulesetVersion}</b></span><span>Prompt 哈希 <b>{state.promptHash.slice(0, 12)}…</b></span>
        <Link to={`/tournaments/${state.tournamentId}/replay`}>打开赛程回放 →</Link>
      </div>
      <PageFooter />
    </main>
  );
}

export function TournamentsPage() {
  const { data, loading, error, refresh } = useApiResource<{ tournaments: TournamentSummary[] }>("/api/public/tournaments");
  if (loading) return <main className="page-shell"><LoadingBlock label="正在读取赛事档案" /></main>;
  if (error) return <main className="page-shell"><ErrorBlock message={error} onRetry={() => void refresh()} /></main>;
  const tournaments = data?.tournaments ?? [];
  return (
    <main className="page-shell">
      <SectionHeading title="赛事档案" aside={<p>从第一条事件到最后一枚筹码，完整保留。</p>} />
      {tournaments.length === 0 ? <EmptyState title="还没有历史赛事" body="首场锦标赛结束后，逐手回放和公平性凭证会出现在这里。" action={<Link className="button primary" to="/admin/tournaments/new">创建赛事</Link>} /> : (
        <div className="tournament-list">
          {tournaments.map((tournament, index) => {
            const state = tournament.publicState;
            const champion = state.players?.find((player) => player.id === state.championPlayerId);
            return (
              <Link className="tournament-card" to={`/tournaments/${tournament.id}/replay`} key={tournament.id}>
                <span className="archive-index">{String(index + 1).padStart(2, "0")}</span>
                <div className="tournament-card-main"><StatusBadge status={tournament.status} /><h2>{tournament.name}</h2><p>{new Date(tournament.createdAt).toLocaleString("zh-CN")}</p></div>
                <dl className="tournament-stats"><div><dt>手数</dt><dd>{state.completedHands ?? 0}</dd></div><div><dt>阵容</dt><dd>{state.players?.length ?? 0}</dd></div><div><dt>冠军</dt><dd>{champion?.displayName ?? "—"}</dd></div></dl>
                <span className="card-arrow">↗</span>
              </Link>
            );
          })}
        </div>
      )}
      <PageFooter />
    </main>
  );
}

export function LeaderboardPage() {
  const [view, setView] = useState<"competition" | "reliability" | "efficiency" | "styles">("competition");
  const { data, loading, error, refresh } = useApiResource<LeaderboardResponse>("/api/public/leaderboard");
  if (loading) return <main className="page-shell"><LoadingBlock label="正在计算历史排名" /></main>;
  if (error) return <main className="page-shell"><ErrorBlock message={error} onRetry={() => void refresh()} /></main>;
  const entries = data?.competition ?? data?.leaderboard ?? [];
  const tabs = [
    { id: "competition" as const, label: "竞技主榜", note: "仅由已完成赛事的最终名次决定" },
    { id: "reliability" as const, label: "稳定性", note: "协议成功、纠错、兜底与超时" },
    { id: "efficiency" as const, label: "效率", note: "真实响应耗时与 Token 用量" },
    { id: "styles" as const, label: "牌风档案", note: "描述打法，不判断优劣" },
  ];
  const identity = (index: number, displayName: string, warning: boolean, warningText: string) => (
    <div className="rank-model">
      <b>{String(index + 1).padStart(2, "0")}</b>
      <span className="model-monogram">{displayName.slice(0, 1).toUpperCase()}</span>
      <div><strong>{displayName}</strong>{warning && <small>{warningText}</small>}</div>
    </div>
  );
  const percent = (value: number | null) => value === null ? "—" : `${(value * 100).toFixed(0)}%`;
  const latency = (value: number | null) => value === null ? "—" : value < 1_000 ? `${Math.round(value)} 毫秒` : `${(value / 1_000).toFixed(1)} 秒`;
  return (
    <main className="page-shell leaderboard-page">
      <SectionHeading title="模型排行榜" aside={<p>竞技结果、调用质量与牌风分开评价；小样本会明确标注。</p>} />
      {entries.length === 0 ? <EmptyState title="榜单等待第一位冠军" body="未完成和已取消赛事不会进入正式历史排名。" /> : (
        <>
          <section className="leaderboard-principle">
            <span>主榜原则</span>
            <h2>牌桌胜负决定竞技排名</h2>
            <p>稳定性、响应速度和 Token 消耗均独立展示，不会给竞技 Rating 加分或扣分。</p>
          </section>
          <div className="leaderboard-tabs" role="tablist" aria-label="选择排行榜维度">
            {tabs.map((tab) => <button type="button" role="tab" aria-selected={view === tab.id} className={view === tab.id ? "active" : ""} onClick={() => setView(tab.id)} key={tab.id}><b>{tab.label}</b><span>{tab.note}</span></button>)}
          </div>
          {view === "competition" && (
            <div className="leaderboard leaderboard-grid is-competition">
              <div className="leaderboard-head"><span>排名 / 模型</span><span>Rating</span><span>积分</span><span>冠军</span><span>前三率</span><span>平均名次</span></div>
              {entries.map((entry, index) => (
                <article className="leaderboard-row" key={entry.modelId}>
                  {identity(index, entry.displayName, entry.sampleWarning, "样本少于 10 场")}
                  <strong data-label="Rating">{entry.rating}</strong>
                  <span data-label="积分">{entry.points.toFixed(1)}</span>
                  <span data-label="冠军">{entry.championships} / {entry.tournaments}</span>
                  <span data-label="前三率">{percent(entry.topThreeRate)}</span>
                  <span data-label="平均名次">{entry.averageFinish.toFixed(2)}</span>
                </article>
              ))}
            </div>
          )}
          {view === "reliability" && (
            <div className="leaderboard leaderboard-grid is-reliability">
              <div className="leaderboard-head"><span>排名 / 模型</span><span>有效决策</span><span>一次成功</span><span>协议纠错</span><span>规则兜底</span><span>超时 / 暂停</span></div>
              {(data?.reliability ?? []).map((entry, index) => (
                <article className="leaderboard-row" key={entry.modelId}>
                  {identity(index, entry.displayName, entry.sampleWarning, "决策少于 50 次")}
                  <strong data-label="有效决策">{percent(entry.validDecisionRate)}</strong>
                  <span data-label="一次成功">{percent(entry.firstPassRate)}</span>
                  <span data-label="协议纠错">{entry.protocolCorrections}</span>
                  <span data-label="规则兜底">{entry.fallbacks}</span>
                  <span data-label="超时 / 暂停">{entry.timeouts} / {entry.infrastructurePauses}</span>
                </article>
              ))}
            </div>
          )}
          {view === "efficiency" && (
            <div className="leaderboard leaderboard-grid is-efficiency">
              <div className="leaderboard-head"><span>排名 / 模型</span><span>平均响应</span><span>95% 响应</span><span>调用次数</span><span>总 Token</span><span>每次决策</span></div>
              {(data?.efficiency ?? []).map((entry, index) => (
                <article className="leaderboard-row" key={entry.modelId}>
                  {identity(index, entry.displayName, entry.sampleWarning, "决策少于 50 次")}
                  <strong data-label="平均响应">{latency(entry.averageLatencyMs)}</strong>
                  <span data-label="95% 响应">{latency(entry.p95LatencyMs)}</span>
                  <span data-label="调用次数">{entry.providerCalls}</span>
                  <span data-label="总 Token">{entry.totalTokens?.toLocaleString("zh-CN") ?? "—"}</span>
                  <span data-label="每次决策">{entry.tokensPerDecision === null ? "—" : Math.round(entry.tokensPerDecision).toLocaleString("zh-CN")}</span>
                </article>
              ))}
            </div>
          )}
          {view === "styles" && (
            <div className="leaderboard leaderboard-grid is-styles">
              <div className="leaderboard-head"><span>模型 / 牌风</span><span>主动入池</span><span>翻前加注</span><span>再加注手牌</span><span>摊牌胜率</span><span>样本手数</span></div>
              {(data?.styles ?? []).map((entry, index) => (
                <article className="leaderboard-row" key={entry.modelId}>
                  {identity(index, entry.displayName, entry.sampleWarning, "样本少于 200 手")}
                  <strong data-label="主动入池">{percent(entry.vpipRate)}</strong>
                  <span data-label="翻前加注">{percent(entry.pfrRate)}</span>
                  <span data-label="再加注手牌">{percent(entry.threeBetRate)}</span>
                  <span data-label="摊牌胜率">{percent(entry.showdownWinRate)}</span>
                  <span data-label="牌风 / 样本"><i className="style-profile">{entry.profile}</i>{entry.handsPlayed} 手</span>
                </article>
              ))}
            </div>
          )}
          <p className="leaderboard-method">竞技 Rating 以 1500 为基准，按每场所有模型的两两名次同时更新；六人局积分为 10 / 6 / 4 / 2 / 1 / 0。</p>
        </>
      )}
      <PageFooter />
    </main>
  );
}

function collectBoard(events: ArenaEvent[]): unknown[][] {
  const boards: unknown[][] = [];
  for (const event of [...events].sort((a, b) => a.sequence - b.sequence)) {
    if (event.type !== "STREET_DEALT") continue;
    const index = Number(event.publicPayload.boardIndex ?? 0);
    const cards = Array.isArray(event.publicPayload.cards) ? event.publicPayload.cards : [];
    boards[index] = [...(boards[index] ?? []), ...cards];
  }
  return boards;
}

function HandSelector({ hands, activeHand, tournamentId }: {
  hands: HandSummary[]; activeHand: number; tournamentId: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLAnchorElement>(null);
  useLayoutEffect(() => {
    const container = containerRef.current;
    const active = activeRef.current;
    if (!container || !active) return;
    container.scrollLeft = active.offsetLeft
      - container.clientWidth / 2
      + active.clientWidth / 2;
  }, [activeHand]);
  return (
    <div className="hand-selector" aria-label="选择要回放的牌局" ref={containerRef}>
      {hands.map((hand) => <Link ref={hand.handNo === activeHand ? activeRef : undefined} className={hand.handNo === activeHand ? "active" : ""} to={`/tournaments/${tournamentId}/replay/${hand.handNo}`} key={hand.handNo}>第 {String(hand.handNo).padStart(3, "0")} 手</Link>)}
    </div>
  );
}

export function ReplayPage() {
  const { id = "", handNo: routeHandNo } = useParams();
  const [eventsCollapsed, setEventsCollapsed] = useState(false);
  const tournament = useApiResource<{ state: ArenaState }>(id ? `/api/public/tournaments/${id}` : null);
  const hands = useApiResource<{ hands: HandSummary[] }>(id ? `/api/public/tournaments/${id}/hands` : null);
  const stackHistory = useApiResource<{ points: StackHistoryPoint[] }>(id ? `/api/public/tournaments/${id}/stack-history` : null);
  const performance = useApiResource<{ statistics: TournamentStatistics }>(id ? `/api/public/tournaments/${id}/statistics` : null);
  const handNo = Number(routeHandNo ?? hands.data?.hands.at(-1)?.handNo ?? 0);
  const replay = useApiResource<{
    events: ArenaEvent[];
    decisions: DecisionAuditTurn[];
    decisionAuditAvailable: boolean;
  }>(handNo > 0 ? `/api/public/tournaments/${id}/hands/${handNo}/replay` : null);
  if (tournament.loading || hands.loading) return <main className="page-shell"><LoadingBlock label="正在装载赛程回放" /></main>;
  if (tournament.error || hands.error) return <main className="page-shell"><ErrorBlock message={tournament.error ?? hands.error ?? "赛程回放暂时不可用"} /></main>;
  const state = tournament.data?.state;
  if (!state) return <main className="page-shell"><EmptyState title="赛事不存在" body="无法找到对应的赛事记录。" /></main>;
  const events = replay.data?.events ?? [];
  const decisions = replay.data?.decisions ?? [];
  const boards = collectBoard(events);
  const holeCards = new Map<string, unknown[]>();
  for (const event of events) {
    if (event.type === "HOLE_CARDS_DEALT" && Array.isArray(event.privatePayload?.cards)) {
      holeCards.set(String(event.publicPayload.playerId), event.privatePayload.cards);
    }
  }
  return (
    <main className="page-shell replay-page">
      <SectionHeading title={state.name} aside={<div><StatusBadge status={state.status} /><p>第 {String(handNo).padStart(3, "0")} 手</p></div>} />
      {state.status === "COMPLETED" && (
        <>
          <section className="stack-history-panel" aria-labelledby="stack-history-heading">
            <header className="stack-history-heading">
              <div><h2 id="stack-history-heading">筹码走势</h2><p>每一手结算后的权威筹码快照</p></div>
              <span><b>{stackHistory.data?.points.length ?? state.completedHands}</b> 手</span>
            </header>
            {stackHistory.loading ? <LoadingBlock label="正在绘制筹码走势" />
              : stackHistory.error ? <ErrorBlock message={stackHistory.error} onRetry={() => void stackHistory.refresh()} />
                : <StackHistoryChart players={state.players} points={stackHistory.data?.points ?? []} />}
          </section>
          {performance.loading ? <LoadingBlock label="正在计算赛后战报" />
            : performance.error ? <ErrorBlock message={performance.error} onRetry={() => void performance.refresh()} />
              : performance.data && <TournamentStatisticsReport statistics={performance.data.statistics} />}
        </>
      )}
      <HandSelector hands={hands.data?.hands ?? []} activeHand={handNo} tournamentId={id} />
      {replay.loading ? <LoadingBlock /> : replay.error ? <ErrorBlock message={replay.error} /> : (
        <div className={`replay-grid${eventsCollapsed ? " events-collapsed" : ""}`}>
          <section className="replay-stage">
            <div className="replay-board-label"><span>公共牌结果</span><b>{boards.length > 1 ? `${boards.length} 次发牌` : "发牌一次"}</b></div>
            {boards.map((board, index) => <div className="replay-board" key={index}><span>第 {index + 1} 组</span><div>{Array.from({ length: 5 }, (_, cardIndex) => <PlayingCard card={board[cardIndex]} key={cardIndex} />)}</div></div>)}
            {boards.length === 0 && <div className="replay-board"><span>第 1 组</span><div>{Array.from({ length: 5 }, (_, index) => <PlayingCard key={index} />)}</div></div>}
            <HandActionLedger players={state.players} events={events} holeCards={holeCards} />
          </section>
          <aside className={`replay-events${eventsCollapsed ? " is-collapsed" : ""}`}>
            {eventsCollapsed ? (
              <button className="replay-events-reveal" type="button" onClick={() => setEventsCollapsed(false)} aria-expanded="false">
                <span>逐事件记录</span><b>展开</b>
              </button>
            ) : (
              <>
                <div className="panel-heading replay-events-heading">
                  <div><h2>逐事件记录</h2><p>按执行顺序完整保存</p></div>
                  <div><span>{events.length} 条事件</span><button type="button" onClick={() => setEventsCollapsed(true)} aria-expanded="true">收起</button></div>
                </div>
                <EventTape compact events={events} players={state.players} />
              </>
            )}
          </aside>
        </div>
      )}
      {decisions.length > 0 && (
        <section className="decision-audit-panel">
          <div className="decision-audit-heading">
            <div><h2>模型决策审计</h2><p>牌局结束后公开每轮真实输入、原始输出与冻结配置凭证</p></div>
            <span>{decisions.length} 次调用</span>
          </div>
          <div className="decision-audit-list">
            {decisions.map((turn) => {
              const player = state.players.find((item) => item.id === turn.player_id);
              const parsed = turn.response?.parsed;
              const summary = typeof parsed?.decision_summary === "string" ? parsed.decision_summary : null;
              return (
                <details key={`${turn.decision_id}:${turn.turn_index}`}>
                  <summary>
                    <span>{player?.displayName ?? turn.player_id}</span>
                    <b>调用 {turn.turn_index}</b>
                    <em>{turn.outcome === "SUCCESS" ? "成功" : turn.outcome === "PROTOCOL_ERROR" ? "协议纠错" : "基础设施错误"}</em>
                    <i>{turn.latency_ms === null ? "—" : `${(turn.latency_ms / 1000).toFixed(1)} 秒`}</i>
                  </summary>
                  {summary && <p className="decision-audit-summary">决策说明：{summary}</p>}
                  <div className="decision-proof-grid">
                    <span>请求哈希 <code>{turn.request_hash}</code></span>
                    <span>模型配置哈希 <code>{turn.provider_config_hash}</code></span>
                    <span>输出协议 <code>{turn.output_schema_version} · {turn.output_schema_hash}</code></span>
                  </div>
                  <pre>{JSON.stringify({ request: turn.request, response: turn.response, error_kind: turn.error_kind, usage: turn.usage }, null, 2)}</pre>
                </details>
              );
            })}
          </div>
        </section>
      )}
      <div className="fairness-callout"><h2>验证这场比赛没有被改写</h2><p>事件哈希链、随机承诺与赛后公开种子共同构成可审计证据。</p><Link to={`/api/public/tournaments/${id}/fairness`} target="_blank">查看公平性 JSON ↗</Link></div>
      <PageFooter />
    </main>
  );
}
