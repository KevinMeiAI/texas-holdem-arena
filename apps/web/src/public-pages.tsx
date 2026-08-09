import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { apiRequest, useApiResource } from "./api";
import {
  EmptyState,
  ErrorBlock,
  EventTape,
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
  HandSummary,
  LeaderboardEntry,
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
          <p className="eyebrow">THE QUIET BROADCAST ROOM</p>
          <h1>牌桌已经就绪。<br /><em>等待模型入席。</em></h1>
          <p>配置模型、锁定同一份 system prompt，然后让确定性规则引擎主持一场完整的单桌锦标赛。</p>
          <div className="button-row"><Link className="button primary" to="/admin/tournaments/new">创建首场赛事</Link><Link className="button secondary" to="/tournaments">查看赛事档案</Link></div>
        </section>
        <div className="principle-strip"><span>01 / 同一提示词</span><span>02 / 无补码锦标赛</span><span>03 / 全事件可回放</span><span>04 / 隐藏信息隔离</span></div>
        <PageFooter />
      </main>
    );
  }

  const hand = state.hand;
  return (
    <main className="page-shell live-page">
      <div className="live-titlebar">
        <div><p className="eyebrow">SINGLE TABLE · MODEL CHAMPIONSHIP</p><h1>{state.name}</h1></div>
        <div className="live-meta"><StatusBadge status={state.status} /><span>HAND <b>{String(hand?.handNo ?? state.completedHands).padStart(3, "0")}</b></span>{hand ? <span>BLINDS <b>{formatChips(hand.blinds.smallBlind)} / {formatChips(hand.blinds.bigBlind)}</b></span> : <span>FINAL STACK <b>{formatChips(state.players.find((player) => player.id === state.championPlayerId)?.stack)}</b></span>}</div>
      </div>
      <div className="live-layout">
        <PokerTable state={state} />
        <aside className="broadcast-sidebar">
          <div className="panel-heading"><div><p>LIVE EVENT TAPE</p><h2>权威事件</h2></div><span className={`stream-state ${streamStatus}`}><i />{streamStatus === "connected" ? "同步" : streamStatus === "reconnecting" ? "重连" : "连接"}</span></div>
          <EventTape events={events.slice(-28)} players={state.players} />
          <div className="broadcast-facts">
            <div><span>阶段</span><b>{hand?.phase ?? state.status}</b></div>
            <div><span>在席</span><b>{state.players.filter((player) => player.status !== "ELIMINATED").length} / {state.players.length}</b></div>
            <div><span>种子承诺</span><b title={state.seedCommitment}>{state.seedCommitment.slice(0, 12)}…</b></div>
          </div>
        </aside>
      </div>
      <div className="under-table-bar">
        <span>RULESET <b>{state.rulesetVersion}</b></span><span>PROMPT <b>{state.promptHash.slice(0, 12)}…</b></span>
        <Link to={`/tournaments/${state.tournamentId}/replay`}>进入赛程回放 →</Link>
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
      <SectionHeading eyebrow="TOURNAMENT ARCHIVE" title={<>赛事<em>档案</em></>} aside={<p>从第一条事件到最后一枚筹码，完整保留。</p>} />
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
  const { data, loading, error, refresh } = useApiResource<{ leaderboard: LeaderboardEntry[] }>("/api/public/leaderboard");
  if (loading) return <main className="page-shell"><LoadingBlock label="正在计算历史排名" /></main>;
  if (error) return <main className="page-shell"><ErrorBlock message={error} onRetry={() => void refresh()} /></main>;
  const entries = data?.leaderboard ?? [];
  return (
    <main className="page-shell">
      <SectionHeading eyebrow="ALL-TIME MODEL STANDINGS" title={<>模型<em>排行榜</em></>} aside={<p>仅统计已完成的正式锦标赛；小样本会明确标注。</p>} />
      {entries.length === 0 ? <EmptyState title="榜单等待第一位冠军" body="未完成和已取消赛事不会进入正式历史排名。" /> : (
        <div className="leaderboard">
          <div className="leaderboard-head"><span>排名 / 模型</span><span>冠军</span><span>参赛</span><span>夺冠率</span><span>平均名次</span></div>
          {entries.map((entry, index) => (
            <article className="leaderboard-row" key={entry.modelId}>
              <div className="rank-model"><b>{String(index + 1).padStart(2, "0")}</b><span className="model-monogram">{entry.displayName.slice(0, 1).toUpperCase()}</span><div><strong>{entry.displayName}</strong>{entry.sampleWarning && <small>样本少于 10 场</small>}</div></div>
              <strong data-label="冠军">{entry.championships}</strong><span data-label="参赛">{entry.tournaments}</span><span data-label="夺冠率">{(entry.championshipRate * 100).toFixed(0)}%</span><span data-label="平均名次">{entry.averageFinish.toFixed(2)}</span>
            </article>
          ))}
        </div>
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
    <div className="hand-selector" aria-label="Choose a hand" ref={containerRef}>
      {hands.map((hand) => <Link ref={hand.handNo === activeHand ? activeRef : undefined} className={hand.handNo === activeHand ? "active" : ""} to={`/tournaments/${tournamentId}/replay/${hand.handNo}`} key={hand.handNo}>H{String(hand.handNo).padStart(3, "0")}</Link>)}
    </div>
  );
}

export function ReplayPage() {
  const { id = "", handNo: routeHandNo } = useParams();
  const tournament = useApiResource<{ state: ArenaState }>(id ? `/api/public/tournaments/${id}` : null);
  const hands = useApiResource<{ hands: HandSummary[] }>(id ? `/api/public/tournaments/${id}/hands` : null);
  const handNo = Number(routeHandNo ?? hands.data?.hands.at(-1)?.handNo ?? 0);
  const replay = useApiResource<{ events: ArenaEvent[] }>(handNo > 0 ? `/api/public/tournaments/${id}/hands/${handNo}/replay` : null);
  if (tournament.loading || hands.loading) return <main className="page-shell"><LoadingBlock label="正在装载赛程回放" /></main>;
  if (tournament.error || hands.error) return <main className="page-shell"><ErrorBlock message={tournament.error ?? hands.error ?? "Replay unavailable"} /></main>;
  const state = tournament.data?.state;
  if (!state) return <main className="page-shell"><EmptyState title="赛事不存在" body="无法找到对应的赛事记录。" /></main>;
  const events = replay.data?.events ?? [];
  const boards = collectBoard(events);
  const holeCards = new Map<string, unknown[]>();
  for (const event of events) {
    if (event.type === "HOLE_CARDS_DEALT" && Array.isArray(event.privatePayload?.cards)) {
      holeCards.set(String(event.publicPayload.playerId), event.privatePayload.cards);
    }
  }
  return (
    <main className="page-shell replay-page">
      <SectionHeading eyebrow="AUTHORITATIVE REPLAY" title={state.name} aside={<div><StatusBadge status={state.status} /><p>HAND {String(handNo).padStart(3, "0")}</p></div>} />
      <HandSelector hands={hands.data?.hands ?? []} activeHand={handNo} tournamentId={id} />
      {replay.loading ? <LoadingBlock /> : replay.error ? <ErrorBlock message={replay.error} /> : (
        <div className="replay-grid">
          <section className="replay-stage">
            <div className="replay-board-label"><span>FINAL BOARD</span><b>{boards.length > 1 ? `${boards.length} RUNOUTS` : "RUN IT ONCE"}</b></div>
            {boards.map((board, index) => <div className="replay-board" key={index}><span>BOARD {index + 1}</span><div>{Array.from({ length: 5 }, (_, cardIndex) => <PlayingCard card={board[cardIndex]} key={cardIndex} />)}</div></div>)}
            {boards.length === 0 && <div className="replay-board"><span>BOARD 1</span><div>{Array.from({ length: 5 }, (_, index) => <PlayingCard key={index} />)}</div></div>}
            <div className="hole-card-ledger">
              <div className="ledger-heading"><span>赛后底牌存档</span><b>HAND COMPLETE · VISIBLE</b></div>
              {state.players.map((player) => <div className="ledger-player" key={player.id}><span className="model-monogram">{player.displayName.slice(0, 1)}</span><strong>{player.displayName}</strong><div><PlayingCard card={holeCards.get(player.id)?.[0]} compact /><PlayingCard card={holeCards.get(player.id)?.[1]} compact /></div></div>)}
            </div>
          </section>
          <aside className="replay-events"><div className="panel-heading"><div><p>HAND EVENT TAPE</p><h2>逐事件记录</h2></div><span>{events.length} EVENTS</span></div><EventTape compact events={events} players={state.players} /></aside>
        </div>
      )}
      <div className="fairness-callout"><div><p className="eyebrow">PROVABLY FAIR</p><h2>验证这场比赛没有被改写</h2></div><p>事件哈希链、随机承诺与赛后公开种子共同构成可审计证据。</p><Link to={`/api/public/tournaments/${id}/fairness`} target="_blank">查看公平性 JSON ↗</Link></div>
      <PageFooter />
    </main>
  );
}
