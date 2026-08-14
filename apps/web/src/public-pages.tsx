import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { apiRequest, useApiResource } from "./api";
import { HandActionLedger } from "./hand-action-ledger";
import { styleProfileLabel } from "./leaderboard-format";
import {
  sortLeaderboardEntries,
  type LeaderboardSortDirection,
  type LeaderboardSortValue,
} from "./leaderboard-sort";
import { StackHistoryChart } from "./stack-history-chart";
import { SelectControl } from "./select-control";
import { spectatorTimeline } from "./spectator-event-timeline";
import { TournamentStatisticsReport } from "./tournament-statistics";
import {
  EmptyState,
  ErrorBlock,
  EventTape,
  formatArenaPhase,
  formatChips,
  LoadingBlock,
  modelTint,
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
import { useUiPreferences } from "./ui-preferences";

export function LivePage() {
  const { locale, text } = useUiPreferences();
  const resource = useApiResource<{ state: ArenaState | null }>("/api/public/live", 1_500);
  const state = resource.data?.state ?? null;
  const [events, setEvents] = useState<ArenaEvent[]>([]);
  const [streamStatus, setStreamStatus] = useState<"idle" | "connected" | "reconnecting">("idle");

  const isTerminal = state?.status === "COMPLETED" || state?.status === "CANCELLED";
  useEffect(() => {
    if (!state?.tournamentId || isTerminal) return;
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
  }, [state?.tournamentId, isTerminal]);

  if (resource.loading) return <main className="page-shell"><LoadingBlock /></main>;
  if (resource.error && !state) return <main className="page-shell"><ErrorBlock message={resource.error} onRetry={() => void resource.refresh()} /></main>;
  if (!state) {
    return (
      <main className="page-shell">
        <section className="hero-empty">
          <h1>{text("牌桌已就绪，等待模型入席", "The table is ready — waiting for models")}</h1>
          <div className="button-row"><Link className="button primary" to="/admin/tournaments/new">{text("创建赛事", "Create tournament")}</Link><Link className="button secondary" to="/tournaments">{text("赛事档案", "Tournament archive")}</Link></div>
        </section>
      </main>
    );
  }

  const hand = state.hand;
  return (
    <main className="page-shell live-page">
      <div className="live-titlebar">
        <div><h1>{state.name}</h1></div>
        <div className="live-meta"><StatusBadge status={state.status} /><span>{text("第", "Hand")} <b>{String(hand?.handNo ?? state.completedHands).padStart(3, "0")}</b> {text("手", "")}</span>{hand ? <span>{text("盲注", "Blinds")} <b>{formatChips(hand.blinds.smallBlind)} / {formatChips(hand.blinds.bigBlind)}</b></span> : <span>{text("最终筹码", "Final stack")} <b>{formatChips(state.players.find((player) => player.id === state.championPlayerId)?.stack)}</b></span>}</div>
      </div>
      <div className="live-layout">
        <PokerTable state={state} />
        <aside className="broadcast-sidebar">
          <div className="panel-heading"><div><h2>{text("牌局时间线", "Game timeline")}</h2></div>{isTerminal ? <span className="stream-state">{text("赛事已结束", "Tournament ended")}</span> : <span className={`stream-state ${streamStatus}`}><i />{streamStatus === "connected" ? text("同步中", "Synced") : streamStatus === "reconnecting" ? text("正在重连", "Reconnecting") : text("正在连接", "Connecting")}</span>}</div>
          <EventTape events={events} players={state.players} limit={28} emptyLabel={isTerminal ? text("赛事已结束，可打开回放查看完整记录。", "Tournament ended — open the replay for the full record.") : undefined} />
          <div className="broadcast-facts">
            <div><span>{text("阶段", "Stage")}</span><b>{formatArenaPhase(hand?.phase ?? state.status, locale)}</b></div>
            <div><span>{text("在席", "Active")}</span><b>{state.players.filter((player) => player.status !== "ELIMINATED").length} / {state.players.length}</b></div>
            <div><span>{text("种子承诺", "Seed commit")}</span><b title={state.seedCommitment}>{state.seedCommitment.slice(0, 12)}…</b></div>
          </div>
        </aside>
      </div>
      <div className="under-table-bar">
        <span>{text("规则版本", "Ruleset")} <b>{state.rulesetVersion}</b></span><span>{text("提示词哈希", "Prompt hash")} <b>{state.promptHash.slice(0, 12)}…</b></span>
        <Link to={`/tournaments/${state.tournamentId}/replay`}>{text("打开赛程回放", "Open replay")} →</Link>
      </div>
    </main>
  );
}

export function TournamentsPage() {
  const { locale, text } = useUiPreferences();
  const { data, loading, error, refresh } = useApiResource<{ tournaments: TournamentSummary[] }>("/api/public/tournaments");
  if (loading) return <main className="page-shell"><LoadingBlock label={text("正在读取赛事档案", "Loading tournament archive")} /></main>;
  if (error) return <main className="page-shell"><ErrorBlock message={error} onRetry={() => void refresh()} /></main>;
  const tournaments = data?.tournaments ?? [];
  return (
    <main className="page-shell">
      <SectionHeading title={text("赛事档案", "Tournament archive")} />
      {tournaments.length === 0 ? <EmptyState title={text("还没有历史赛事", "No tournaments yet")} body={text("创建一场锦标赛后，赛程会出现在这里。", "Create a tournament to start the archive.")} action={<Link className="button primary" to="/admin/tournaments/new">{text("创建赛事", "Create tournament")}</Link>} /> : (
        <div className="tournament-list">
          {tournaments.map((tournament, index) => {
            const state = tournament.publicState;
            const champion = state.players?.find((player) => player.id === state.championPlayerId);
            return (
              <Link className="tournament-card" to={`/tournaments/${tournament.id}/replay`} key={tournament.id}>
                <span className="archive-index">{String(index + 1).padStart(2, "0")}</span>
                <div className="tournament-card-main"><StatusBadge status={tournament.status} /><h2>{tournament.name}</h2><p>{new Date(tournament.createdAt).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" })}</p></div>
                <dl className="tournament-stats"><div><dt>{text("手数", "Hands")}</dt><dd>{state.completedHands ?? 0}</dd></div><div><dt>{text("阵容", "Field")}</dt><dd>{state.players?.length ?? 0}</dd></div><div><dt>{text("冠军", "Champion")}</dt><dd>{champion?.displayName ?? "—"}</dd></div></dl>
                <span className="card-arrow">↗</span>
              </Link>
            );
          })}
        </div>
      )}
    </main>
  );
}

export function LeaderboardPage() {
  const { locale, text } = useUiPreferences();
  type LeaderboardView = "competition" | "reliability" | "efficiency" | "styles";
  type SortState = { key: string; direction: LeaderboardSortDirection };
  const defaultSorts: Record<LeaderboardView, SortState> = {
    competition: { key: "rating", direction: "desc" },
    reliability: { key: "validDecisionRate", direction: "desc" },
    efficiency: { key: "averageLatencyMs", direction: "asc" },
    styles: { key: "handsPlayed", direction: "desc" },
  };
  const [searchParams, setSearchParams] = useSearchParams();
  const viewParam = searchParams.get("view");
  const view: LeaderboardView = viewParam === "reliability" || viewParam === "efficiency" || viewParam === "styles" ? viewParam : "competition";
  const { data, loading, error, refresh } = useApiResource<LeaderboardResponse>("/api/public/leaderboard");
  if (loading) return <main className="page-shell"><LoadingBlock label={text("正在计算历史排名", "Loading rankings")} /></main>;
  if (error) return <main className="page-shell"><ErrorBlock message={error} onRetry={() => void refresh()} /></main>;
  const entries = data?.competition ?? data?.leaderboard ?? [];
  const tabs = [
    { id: "competition" as const, label: text("竞技主榜", "Competition") },
    { id: "reliability" as const, label: text("稳定性", "Reliability") },
    { id: "efficiency" as const, label: text("效率", "Efficiency") },
    { id: "styles" as const, label: text("牌风档案", "Playing style") },
  ];
  const sortOptions: Record<LeaderboardView, { key: string; label: string; defaultDirection: LeaderboardSortDirection }[]> = {
    competition: [
      { key: "rating", label: "Rating", defaultDirection: "desc" },
      { key: "points", label: text("积分", "Points"), defaultDirection: "desc" },
      { key: "tournaments", label: text("赛事", "Events"), defaultDirection: "desc" },
      { key: "championships", label: text("冠军", "Wins"), defaultDirection: "desc" },
      { key: "topThreeRate", label: text("前三率", "Top 3"), defaultDirection: "desc" },
      { key: "averageFinish", label: text("平均名次", "Avg finish"), defaultDirection: "asc" },
    ],
    reliability: [
      { key: "validDecisionRate", label: text("有效决策", "Valid"), defaultDirection: "desc" },
      { key: "firstPassRate", label: text("一次成功", "First pass"), defaultDirection: "desc" },
      { key: "protocolCorrections", label: text("协议纠错", "Corrections"), defaultDirection: "asc" },
      { key: "fallbacks", label: text("规则兜底", "Fallbacks"), defaultDirection: "asc" },
      { key: "timeouts", label: text("超时", "Timeouts"), defaultDirection: "asc" },
      { key: "infrastructurePauses", label: text("暂停", "Pauses"), defaultDirection: "asc" },
    ],
    efficiency: [
      { key: "averageLatencyMs", label: text("平均响应", "Average"), defaultDirection: "asc" },
      { key: "p95LatencyMs", label: text("95% 响应", "P95"), defaultDirection: "asc" },
      { key: "providerCalls", label: text("调用次数", "Calls"), defaultDirection: "desc" },
      { key: "totalTokens", label: text("总 Token", "Total tokens"), defaultDirection: "desc" },
      { key: "tokensPerDecision", label: text("每次决策", "Per decision"), defaultDirection: "asc" },
    ],
    styles: [
      { key: "vpipRate", label: text("主动入池", "VPIP"), defaultDirection: "desc" },
      { key: "pfrRate", label: text("翻前加注", "PFR"), defaultDirection: "desc" },
      { key: "threeBetRate", label: text("再加注手牌", "3-bet"), defaultDirection: "desc" },
      { key: "showdownWinRate", label: text("摊牌胜率", "Showdown win"), defaultDirection: "desc" },
      { key: "handsPlayed", label: text("样本手数", "Hands"), defaultDirection: "desc" },
    ],
  };
  const sortParam = searchParams.get("sort");
  const [paramKey, paramDirection] = sortParam?.split(":") ?? [];
  const activeSort: SortState = paramKey && sortOptions[view].some((option) => option.key === paramKey)
    ? { key: paramKey, direction: paramDirection === "asc" ? "asc" : "desc" }
    : defaultSorts[view];
  const sortFor = (target: LeaderboardView): SortState => (target === view ? activeSort : defaultSorts[target]);
  const updateParams = (nextView: LeaderboardView, sort: SortState | null) => {
    const next = new URLSearchParams(searchParams);
    next.set("view", nextView);
    if (sort) next.set("sort", `${sort.key}:${sort.direction}`);
    else next.delete("sort");
    setSearchParams(next, { replace: true });
  };
  const setSortKey = (key: string) => {
    const option = sortOptions[view].find((candidate) => candidate.key === key);
    updateParams(view, activeSort.key === key
      ? { key, direction: activeSort.direction === "desc" ? "asc" : "desc" }
      : { key, direction: option?.defaultDirection ?? "desc" });
  };
  const setSortDirection = (direction: LeaderboardSortDirection) => {
    updateParams(view, { key: activeSort.key, direction });
  };
  const sortHeader = (label: string, key: string) => {
    const active = activeSort.key === key;
    const directionLabel = activeSort.direction === "desc"
      ? text("从高到低", "High to low")
      : text("从低到高", "Low to high");
    return (
      <span role="columnheader" aria-sort={active ? (activeSort.direction === "desc" ? "descending" : "ascending") : "none"}>
        <button
          type="button"
          className={`leaderboard-sort-button ${active ? "active" : ""}`}
          onClick={() => setSortKey(key)}
          title={active ? directionLabel : text(`按${label}排序`, `Sort by ${label}`)}
        >
          <span>{label}</span><i aria-hidden="true">{active ? (activeSort.direction === "desc" ? "↓" : "↑") : "↕"}</i>
        </button>
      </span>
    );
  };
  const metricValue = <T extends object>(entry: T, key: string): LeaderboardSortValue => {
    const value = (entry as Record<string, unknown>)[key];
    return typeof value === "number" || typeof value === "string" ? value : null;
  };
  const sortedCompetition = sortLeaderboardEntries(entries, (entry) => metricValue(entry, sortFor("competition").key), sortFor("competition").direction);
  const reliabilityEntries = data?.reliability ?? [];
  const sortedReliability = sortLeaderboardEntries(reliabilityEntries, (entry) => metricValue(entry, sortFor("reliability").key), sortFor("reliability").direction);
  const efficiencyEntries = data?.efficiency ?? [];
  const sortedEfficiency = sortLeaderboardEntries(efficiencyEntries, (entry) => metricValue(entry, sortFor("efficiency").key), sortFor("efficiency").direction);
  const styleEntries = data?.styles ?? [];
  const sortedStyles = sortLeaderboardEntries(styleEntries, (entry) => metricValue(entry, sortFor("styles").key), sortFor("styles").direction);
  const identity = (index: number, modelId: string, displayName: string, warning: boolean, warningText: string) => (
    <div className="rank-model">
      <b>{String(index + 1).padStart(2, "0")}</b>
      <span className="model-monogram" style={modelTint(modelId)}>{displayName.slice(0, 1).toUpperCase()}</span>
      <div>
        <strong>{displayName}</strong>
        {warning && <small>{warningText}</small>}
      </div>
    </div>
  );
  const percent = (value: number | null) => value === null ? "—" : `${(value * 100).toFixed(0)}%`;
  const latency = (value: number | null) => value === null ? "—" : value < 1_000 ? `${Math.round(value)} ${text("毫秒", "ms")}` : `${(value / 1_000).toFixed(1)} ${text("秒", "s")}`;
  return (
    <main className="page-shell leaderboard-page">
      <SectionHeading title={text("模型排行榜", "Model rankings")} />
      {entries.length === 0 ? <EmptyState title={text("榜单等待第一位冠军", "Waiting for the first champion")} body={text("已完成的赛事会进入正式排名。", "Completed tournaments will appear here.")} /> : (
        <>
          <div className="leaderboard-tabs compact-tabs" role="tablist" aria-label={text("选择排行榜维度", "Select ranking view")}>
            {tabs.map((tab) => <button type="button" role="tab" aria-selected={view === tab.id} className={view === tab.id ? "active" : ""} onClick={() => updateParams(tab.id, null)} key={tab.id}><b>{tab.label}</b></button>)}
          </div>
          <div className="leaderboard-mobile-sort">
            <label><span>{text("排序", "Sort")}</span><SelectControl value={activeSort.key} onChange={setSortKey} options={sortOptions[view].map((option) => ({ value: option.key, label: option.label }))} /></label>
            <div className="sort-direction" role="group" aria-label={text("排序方向", "Sort direction")}>
              <button type="button" className={activeSort.direction === "desc" ? "active" : ""} aria-pressed={activeSort.direction === "desc"} onClick={() => setSortDirection("desc")}>{text("高 → 低", "High → low")}</button>
              <button type="button" className={activeSort.direction === "asc" ? "active" : ""} aria-pressed={activeSort.direction === "asc"} onClick={() => setSortDirection("asc")}>{text("低 → 高", "Low → high")}</button>
            </div>
          </div>
          {view === "competition" && (
            <div className="leaderboard leaderboard-grid is-competition">
              <div className="leaderboard-head" role="row"><span role="columnheader">{text("排名 / 模型", "Rank / model")}</span>{sortHeader("Rating", "rating")}{sortHeader(text("积分", "Points"), "points")}{sortHeader(text("赛事", "Events"), "tournaments")}{sortHeader(text("冠军", "Wins"), "championships")}{sortHeader(text("前三率", "Top 3"), "topThreeRate")}{sortHeader(text("平均名次", "Avg finish"), "averageFinish")}</div>
              {sortedCompetition.map((entry, index) => (
                <article className="leaderboard-row" key={entry.modelId}>
                  {identity(index, entry.modelId, entry.displayName, entry.sampleWarning, text("样本少于 10 场", "Fewer than 10 events"))}
                  <strong data-label="Rating">{entry.rating}</strong>
                  <span data-label={text("积分", "Points")}>{entry.points.toFixed(1)}</span>
                  <span data-label={text("赛事", "Events")}>{entry.tournaments}</span>
                  <span data-label={text("冠军", "Wins")}>{entry.championships}</span>
                  <span data-label={text("前三率", "Top 3")}>{percent(entry.topThreeRate)}</span>
                  <span data-label={text("平均名次", "Avg finish")}>{entry.averageFinish.toFixed(2)}</span>
                </article>
              ))}
            </div>
          )}
          {view === "reliability" && (
            <div className="leaderboard leaderboard-grid is-reliability">
              <div className="leaderboard-head" role="row"><span role="columnheader">{text("排名 / 模型", "Rank / model")}</span>{sortHeader(text("有效决策", "Valid"), "validDecisionRate")}{sortHeader(text("一次成功", "First pass"), "firstPassRate")}{sortHeader(text("协议纠错", "Corrections"), "protocolCorrections")}{sortHeader(text("规则兜底", "Fallbacks"), "fallbacks")}{sortHeader(text("超时", "Timeouts"), "timeouts")}{sortHeader(text("暂停", "Pauses"), "infrastructurePauses")}</div>
              {sortedReliability.map((entry, index) => (
                <article className="leaderboard-row" key={entry.modelId}>
                  {identity(index, entry.modelId, entry.displayName, entry.sampleWarning, text("决策少于 50 次", "Fewer than 50 decisions"))}
                  <strong data-label={text("有效决策", "Valid")}>{percent(entry.validDecisionRate)}</strong>
                  <span data-label={text("一次成功", "First pass")}>{percent(entry.firstPassRate)}</span>
                  <span data-label={text("协议纠错", "Corrections")}>{entry.protocolCorrections}</span>
                  <span data-label={text("规则兜底", "Fallbacks")}>{entry.fallbacks}</span>
                  <span data-label={text("超时", "Timeouts")}>{entry.timeouts}</span>
                  <span data-label={text("暂停", "Pauses")}>{entry.infrastructurePauses}</span>
                </article>
              ))}
            </div>
          )}
          {view === "efficiency" && (
            <div className="leaderboard leaderboard-grid is-efficiency">
              <div className="leaderboard-head" role="row"><span role="columnheader">{text("排名 / 模型", "Rank / model")}</span>{sortHeader(text("平均响应", "Average"), "averageLatencyMs")}{sortHeader(text("95% 响应", "P95"), "p95LatencyMs")}{sortHeader(text("调用次数", "Calls"), "providerCalls")}{sortHeader(text("总 Token", "Total tokens"), "totalTokens")}{sortHeader(text("每次决策", "Per decision"), "tokensPerDecision")}</div>
              {sortedEfficiency.map((entry, index) => (
                <article className="leaderboard-row" key={entry.modelId}>
                  {identity(index, entry.modelId, entry.displayName, entry.sampleWarning, text("决策少于 50 次", "Fewer than 50 decisions"))}
                  <strong data-label={text("平均响应", "Average")}>{latency(entry.averageLatencyMs)}</strong>
                  <span data-label={text("95% 响应", "P95")}>{latency(entry.p95LatencyMs)}</span>
                  <span data-label={text("调用次数", "Calls")}>{entry.providerCalls}</span>
                  <span data-label={text("总 Token", "Total tokens")}>{entry.totalTokens?.toLocaleString(locale) ?? "—"}</span>
                  <span data-label={text("每次决策", "Per decision")}>{entry.tokensPerDecision === null ? "—" : Math.round(entry.tokensPerDecision).toLocaleString(locale)}</span>
                </article>
              ))}
            </div>
          )}
          {view === "styles" && (
            <div className="leaderboard leaderboard-grid is-styles">
              <div className="leaderboard-head" role="row"><span role="columnheader">{text("模型", "Model")}</span><span role="columnheader">{text("牌风", "Style")}</span>{sortHeader(text("主动入池", "VPIP"), "vpipRate")}{sortHeader(text("翻前加注", "PFR"), "pfrRate")}{sortHeader(text("再加注手牌", "3-bet"), "threeBetRate")}{sortHeader(text("摊牌胜率", "Showdown win"), "showdownWinRate")}{sortHeader(text("样本手数", "Hands"), "handsPlayed")}</div>
              {sortedStyles.map((entry, index) => (
                <article className="leaderboard-row" key={entry.modelId}>
                  {identity(index, entry.modelId, entry.displayName, entry.sampleWarning, text("样本少于 200 手", "Fewer than 200 hands"))}
                  <span data-label={text("牌风", "Style")}>{styleProfileLabel(entry.profile, locale)}</span>
                  <strong data-label={text("主动入池", "VPIP")}>{percent(entry.vpipRate)}</strong>
                  <span data-label={text("翻前加注", "PFR")}>{percent(entry.pfrRate)}</span>
                  <span data-label={text("再加注手牌", "3-bet")}>{percent(entry.threeBetRate)}</span>
                  <span data-label={text("摊牌胜率", "Showdown win")}>{percent(entry.showdownWinRate)}</span>
                  <span data-label={text("样本手数", "Hands")}>{entry.handsPlayed} {text("手", "hands")}</span>
                </article>
              ))}
            </div>
          )}
        </>
      )}
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
  const { text } = useUiPreferences();
  const containerRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLAnchorElement>(null);
  const centeredRef = useRef(false);
  const [scrollPos, setScrollPos] = useState({ atStart: true, atEnd: false });
  useEffect(() => { centeredRef.current = false; }, [tournamentId]);
  const updateScrollPos = () => {
    const container = containerRef.current;
    if (!container) return;
    setScrollPos({
      atStart: container.scrollLeft <= 1,
      atEnd: container.scrollLeft + container.clientWidth >= container.scrollWidth - 1,
    });
  };
  useLayoutEffect(() => {
    const container = containerRef.current;
    const active = activeRef.current;
    if (!container || !active) return;
    if (!centeredRef.current) {
      // 首次进入把当前手滚到中间；之后点击只就地高亮，不再移动整条选择器
      container.scrollLeft = active.offsetLeft
        - container.clientWidth / 2
        + active.clientWidth / 2;
      centeredRef.current = true;
    } else {
      active.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
    updateScrollPos();
  }, [activeHand, hands.length]);
  const scrollByPage = (direction: -1 | 1) => {
    const container = containerRef.current;
    if (!container) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    container.scrollBy({
      left: direction * Math.round(container.clientWidth * 0.85),
      behavior: reduceMotion ? "auto" : "smooth",
    });
  };
  return (
    <div className="hand-selector-bar">
      {scrollPos.atStart
        ? <span className="hand-nav" aria-disabled="true">‹</span>
        : <button type="button" className="hand-nav" aria-label={text("向前翻一屏手数", "Scroll back one page of hands")} onClick={() => scrollByPage(-1)}>‹</button>}
      <div className="hand-selector" aria-label={text("选择要回放的牌局", "Select a hand")} ref={containerRef} onScroll={updateScrollPos}>
        {hands.map((hand) => <Link ref={hand.handNo === activeHand ? activeRef : undefined} className={hand.handNo === activeHand ? "active" : ""} to={`/tournaments/${tournamentId}/replay/${hand.handNo}`} key={hand.handNo}>{text("第", "Hand")} {String(hand.handNo).padStart(3, "0")} {text("手", "")}</Link>)}
      </div>
      {scrollPos.atEnd
        ? <span className="hand-nav" aria-disabled="true">›</span>
        : <button type="button" className="hand-nav" aria-label={text("向后翻一屏手数", "Scroll forward one page of hands")} onClick={() => scrollByPage(1)}>›</button>}
    </div>
  );
}

export function ReplayPage() {
  const { text } = useUiPreferences();
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
  if (tournament.loading || hands.loading) return <main className="page-shell"><LoadingBlock label={text("正在装载赛程回放", "Loading replay")} /></main>;
  if (tournament.error || hands.error) return <main className="page-shell"><ErrorBlock message={tournament.error ?? hands.error ?? text("赛程回放暂时不可用", "Replay is temporarily unavailable")} /></main>;
  const state = tournament.data?.state;
  if (!state) return <main className="page-shell"><EmptyState title={text("赛事不存在", "Tournament not found")} body={text("无法找到对应的赛事记录。", "The requested tournament could not be found.")} /></main>;
  const events = replay.data?.events ?? [];
  const spectatorEventCount = spectatorTimeline(events).length;
  const decisions = replay.data?.decisions ?? [];
  const initialStack = performance.data?.statistics.initialStack
    ?? (state.players.length > 0
      ? state.players.reduce((total, player) => total + player.stack, 0) / state.players.length
      : 0);
  const boards = collectBoard(events);
  const holeCards = new Map<string, unknown[]>();
  for (const event of events) {
    if (event.type === "HOLE_CARDS_DEALT" && Array.isArray(event.privatePayload?.cards)) {
      holeCards.set(String(event.publicPayload.playerId), event.privatePayload.cards);
    }
  }
  return (
    <main className="page-shell replay-page">
      <SectionHeading title={state.name} aside={<div><StatusBadge status={state.status} /><p>{text("第", "Hand")} {String(handNo).padStart(3, "0")} {text("手", "")}</p></div>} />
      {state.status === "COMPLETED" && (
        <>
          <section className="stack-history-panel" aria-labelledby="stack-history-heading">
            <header className="stack-history-heading">
              <div><h2 id="stack-history-heading">{text("筹码走势", "Stack history")}</h2></div>
              <span><b>{stackHistory.data?.points.length ?? state.completedHands}</b> {text("手", "hands")}</span>
            </header>
            {stackHistory.loading ? <LoadingBlock label={text("正在绘制筹码走势", "Loading stack history")} />
              : stackHistory.error ? <ErrorBlock message={stackHistory.error} onRetry={() => void stackHistory.refresh()} />
                : <StackHistoryChart players={state.players} points={stackHistory.data?.points ?? []} initialStack={initialStack} />}
          </section>
          {performance.loading ? <LoadingBlock label={text("正在计算赛后战报", "Loading tournament report")} />
            : performance.error ? <ErrorBlock message={performance.error} onRetry={() => void performance.refresh()} />
              : performance.data && <TournamentStatisticsReport statistics={performance.data.statistics} />}
        </>
      )}
      <HandSelector hands={hands.data?.hands ?? []} activeHand={handNo} tournamentId={id} />
      {replay.loading ? <LoadingBlock /> : replay.error ? <ErrorBlock message={replay.error} /> : (
        <div className={`replay-grid${eventsCollapsed ? " events-collapsed" : ""}`}>
          <section className="replay-stage">
            <div className="replay-board-label"><span>{text("公共牌", "Board")}</span><b>{text("发牌一次", "Single runout")}</b></div>
            {boards.map((board, index) => <div className="replay-board" key={index}><span>{text("牌面", "Board")} {index + 1}</span><div>{Array.from({ length: 5 }, (_, cardIndex) => <PlayingCard card={board[cardIndex]} key={cardIndex} />)}</div></div>)}
            {boards.length === 0 && <div className="replay-board"><span>{text("牌面", "Board")} 1</span><div>{Array.from({ length: 5 }, (_, index) => <PlayingCard key={index} />)}</div></div>}
            <HandActionLedger players={state.players} events={events} holeCards={holeCards} />
          </section>
          <aside className={`replay-events${eventsCollapsed ? " is-collapsed" : ""}`}>
            {eventsCollapsed ? (
              <button className="replay-events-reveal" type="button" onClick={() => setEventsCollapsed(false)} aria-expanded="false">
                <i aria-hidden="true">‹</i><span>{text("牌局时间线", "Game timeline")}</span><b>{spectatorEventCount}</b>
              </button>
            ) : (
              <>
                <div className="panel-heading replay-events-heading">
                  <div><h2>{text("牌局时间线", "Game timeline")}</h2></div>
                  <div><span>{spectatorEventCount} {text("条记录", "entries")}</span><button type="button" onClick={() => setEventsCollapsed(true)} aria-expanded="true">{text("收起", "Collapse")}</button></div>
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
            <div><h2>{text("模型决策", "Model decisions")}</h2></div>
            <span>{decisions.length} {text("次调用", "calls")}</span>
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
                    <b>{text("调用", "Call")} {turn.turn_index}</b>
                    <em>{turn.outcome === "SUCCESS" ? text("成功", "Success") : turn.outcome === "PROTOCOL_ERROR" ? text("协议纠错", "Protocol correction") : text("基础设施错误", "Infrastructure error")}</em>
                    <i>{turn.latency_ms === null ? "—" : `${(turn.latency_ms / 1000).toFixed(1)} ${text("秒", "s")}`}</i>
                  </summary>
                  {summary && <p className="decision-audit-summary">{text("决策说明", "Decision")}: {summary}</p>}
                  <div className="decision-proof-grid">
                    <span>{text("请求哈希", "Request hash")} <code>{turn.request_hash}</code></span>
                    <span>{text("模型配置哈希", "Model config hash")} <code>{turn.provider_config_hash}</code></span>
                    <span>{text("输出协议", "Output schema")} <code>{turn.output_schema_version} · {turn.output_schema_hash}</code></span>
                  </div>
                  <pre>{JSON.stringify({ request: turn.request, response: turn.response, error_kind: turn.error_kind, usage: turn.usage }, null, 2)}</pre>
                </details>
              );
            })}
          </div>
        </section>
      )}
    </main>
  );
}
