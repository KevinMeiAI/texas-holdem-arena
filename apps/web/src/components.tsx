import { type CSSProperties, type ReactNode, useEffect } from "react";
import { Link, NavLink } from "react-router-dom";
import type { ArenaEvent, ArenaPlayer, ArenaState } from "./types";

export function Brand() {
  return (
    <Link className="brand" to="/" aria-label="Texas Hold'em Arena home">
      <span className="brand-mark" aria-hidden="true">A♠</span>
      <span><strong>Texas Hold&apos;em</strong><em>Arena</em></span>
    </Link>
  );
}

export function AppHeader({ admin = false }: { admin?: boolean }) {
  return (
    <header className="site-header">
      <Brand />
      <nav className="site-nav" aria-label="Main navigation">
        <NavLink to="/" end>现场</NavLink>
        <NavLink to="/tournaments">赛事</NavLink>
        <NavLink to="/leaderboard">榜单</NavLink>
        <NavLink className={admin ? "admin-link active" : "admin-link"} to="/admin">控制室</NavLink>
      </nav>
    </header>
  );
}

export function PageFooter() {
  return (
    <footer className="site-footer">
      <span>DETERMINISTIC ENGINE · EVENT SOURCED</span>
      <span>每一次发牌、决策与结算，皆可验证。</span>
    </footer>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const labels: Record<string, string> = {
    RUNNING: "直播中", PAUSED_INFRA: "已暂停", COMPLETED: "已结束", CANCELLED: "已取消", READY: "准备中",
  };
  return <span className={`status-badge status-${status.toLowerCase()}`}><i />{labels[status] ?? status}</span>;
}

export function formatChips(value: number | undefined | null): string {
  return new Intl.NumberFormat("en-US").format(value ?? 0);
}

function cardParts(card: unknown): { rank: string; suit: string; red: boolean } | null {
  const suits: Record<string, string> = { c: "♣", d: "♦", h: "♥", s: "♠" };
  const ranks: Record<number, string> = { 10: "T", 11: "J", 12: "Q", 13: "K", 14: "A" };
  if (typeof card === "string" && card.length === 2 && suits[card[1] ?? ""]) {
    const suitCode = card[1]!;
    return { rank: card[0]!, suit: suits[suitCode]!, red: suitCode === "d" || suitCode === "h" };
  }
  if (card && typeof card === "object" && "rank" in card && "suit" in card) {
    const rankValue = Number((card as { rank: unknown }).rank);
    const suitCode = String((card as { suit: unknown }).suit);
    if (!suits[suitCode]) return null;
    return {
      rank: ranks[rankValue] ?? String(rankValue),
      suit: suits[suitCode]!,
      red: suitCode === "d" || suitCode === "h",
    };
  }
  return null;
}

export function PlayingCard({ card, hidden = false, compact = false }: {
  card?: unknown; hidden?: boolean; compact?: boolean;
}) {
  const parts = cardParts(card);
  if (hidden) return <span className={`playing-card card-back${compact ? " compact" : ""}`} aria-label="Hidden card"><i>A</i></span>;
  if (!parts) return <span className={`playing-card card-empty${compact ? " compact" : ""}`} aria-hidden="true" />;
  return (
    <span className={`playing-card${parts.red ? " red" : ""}${compact ? " compact" : ""}`} aria-label={`${parts.rank}${parts.suit}`}>
      <strong>{parts.rank}</strong><i>{parts.suit}</i>
    </span>
  );
}

export function PokerTable({ state }: { state: ArenaState }) {
  const players = [...state.players].sort((a, b) => a.seat - b.seat);
  const hand = state.hand;
  const board = hand?.boards[0] ?? [];
  const settledPot = hand?.pots.reduce((sum, item) => sum + item.amount, 0) ?? 0;
  const pot = settledPot > 0 ? settledPot : players.reduce((sum, player) => sum + player.totalCommitted, 0);
  const labels = new Map(players.map((player) => [player.id, player.displayName]));
  const champion = players.find((player) => player.id === state.championPlayerId);

  return (
    <section className="table-broadcast" aria-label={`Poker table for ${state.name}`}>
      <div className="table-room-light" />
      <div className="poker-table-shell">
        <div className="poker-table-felt">
          <div className="table-signature"><span>VERIFIABLE DEAL</span><b>ARENA / {String(hand?.handNo ?? state.completedHands).padStart(3, "0")}</b></div>
          <div className="community-cards">
            {Array.from({ length: 5 }, (_, index) => <PlayingCard card={board[index]} key={index} />)}
          </div>
          <div className="pot-display"><span>{hand ? "总底池" : "冠军"}</span><strong>{hand ? formatChips(pot) : champion?.displayName ?? "—"}</strong></div>
          {players.map((player, index) => {
            const angle = -90 + (360 / players.length) * index;
            const radians = angle * Math.PI / 180;
            const style = {
              "--seat-x": `${50 + Math.cos(radians) * 38}%`,
              "--seat-y": `${50 + Math.sin(radians) * 41}%`,
            } as CSSProperties;
            return <TableSeat key={player.id} player={player} state={state} style={style} />;
          })}
        </div>
      </div>
      {hand?.pots && hand.pots.length > 1 && (
        <div className="side-pot-strip" aria-label="Side pots">
          {hand.pots.map((item) => <span key={item.index}>P{item.index + 1} <b>{formatChips(item.amount)}</b> · {item.eligible.map((id) => labels.get(id) ?? id).join(", ")}</span>)}
        </div>
      )}
    </section>
  );
}

function TableSeat({ player, state, style }: { player: ArenaPlayer; state: ArenaState; style: CSSProperties }) {
  const hand = state.hand;
  const isActing = hand?.currentActorId === player.id || hand?.currentVoterId === player.id;
  const isChampion = state.championPlayerId === player.id;
  const position = hand?.positions.button === player.seat ? "D"
    : hand?.positions.smallBlind === player.seat ? "SB"
      : hand?.positions.bigBlind === player.seat ? "BB" : null;
  return (
    <article className={`table-seat${isActing ? " is-acting" : ""}${player.folded ? " is-folded" : ""}${player.status === "ELIMINATED" ? " is-out" : ""}`} style={style}>
      <div className="seat-meta"><span>SEAT {String(player.seat + 1).padStart(2, "0")}</span>{position && <b>{position}</b>}</div>
      <div className="seat-name"><strong>{player.displayName}</strong>{isChampion && <span title="Champion">♛</span>}</div>
      <div className="seat-stack"><span>{player.allIn ? "ALL IN" : player.folded ? "FOLD" : player.status}</span><b>{formatChips(player.stack)}</b></div>
      {player.streetCommitted > 0 && <span className="seat-bet">+{formatChips(player.streetCommitted)}</span>}
    </article>
  );
}

const eventLabels: Record<string, string> = {
  TOURNAMENT_CONFIG_FROZEN: "赛事配置锁定",
  RANDOMNESS_COMMITTED: "随机种子承诺",
  TOURNAMENT_STARTED: "锦标赛开始",
  BLIND_LEVEL_SELECTED: "盲注级别更新",
  HAND_STARTED: "新一手开始",
  FORCED_BET_POSTED: "强制下注",
  HOLE_CARDS_DEALT: "底牌发出",
  BETTING_ROUND_STARTED: "下注轮开始",
  MODEL_DECISION_RECORDED: "模型完成决策",
  ACTION_APPLIED: "行动执行",
  STREET_DEALT: "公共牌发出",
  RUNOUT_VOTE_STARTED: "发牌次数协商",
  RUNOUT_VOTE_CAST: "协商投票",
  RUNOUT_DECIDED: "发牌次数确定",
  SHOWDOWN_REVEALED: "摊牌",
  POT_CREATED: "底池形成",
  POT_AWARDED: "底池结算",
  HAND_COMPLETED: "本手结束",
  PLAYER_ELIMINATED: "玩家淘汰",
  TOURNAMENT_COMPLETED: "冠军产生",
  TOURNAMENT_PAUSED_INFRA: "基础设施暂停",
  TOURNAMENT_PAUSED_ADMIN: "管理员暂停",
  TOURNAMENT_RESUMED: "赛事继续",
  TOURNAMENT_CANCELLED: "赛事取消",
  RANDOMNESS_REVEALED: "随机种子公开",
};

function actionText(event: ArenaEvent, playerNames?: Map<string, string>): string {
  const payload = event.publicPayload;
  const actor = event.actorId ? playerNames?.get(event.actorId) ?? event.actorId.slice(0, 8) : null;
  if (event.type === "ACTION_APPLIED") {
    const command = payload.command as { action?: string; amount_to?: number } | undefined;
    const action = command?.action?.replaceAll("_", " ").toUpperCase() ?? "ACTION";
    const paid = Number(payload.paid ?? 0);
    const amountTo = Number(payload.amountTo ?? command?.amount_to ?? 0);
    const amount = action === "CALL" || action === "ALL IN" ? paid
      : action === "BET" || action === "RAISE" ? amountTo : 0;
    return `${actor ?? "PLAYER"} · ${action}${amount > 0 ? ` · ${formatChips(amount)}` : ""}`;
  }
  if (event.type === "FORCED_BET_POSTED") return `${String(payload.kind ?? "BET").replaceAll("_", " ")} · ${formatChips(Number(payload.amount ?? 0))}`;
  if (event.type === "STREET_DEALT") return `${String(payload.street ?? "BOARD")} · ${Array.isArray(payload.cards) ? payload.cards.length : 0} 张牌`;
  if (event.type === "MODEL_DECISION_RECORDED") return `${actor ?? "MODEL"} · ${Number(payload.providerCalls ?? 0)} CALL${Number(payload.usedFallback) ? " · FALLBACK" : ""}`;
  if (event.type === "POT_AWARDED") {
    const award = payload.award as { playerId?: string; amount?: number } | undefined;
    return `${playerNames?.get(award?.playerId ?? "") ?? award?.playerId ?? "PLAYER"} · +${formatChips(award?.amount)}`;
  }
  if (event.type === "RUNOUT_VOTE_CAST") return `${actor ?? "PLAYER"} · ${payload.acceptRunItTwice ? "RUN IT TWICE" : "RUN IT ONCE"}`;
  return actor ? actor : `EVENT ${String(event.sequence).padStart(4, "0")}`;
}

export function EventTape({ events, players, compact = false }: {
  events: ArenaEvent[]; players?: ArenaPlayer[]; compact?: boolean;
}) {
  const names = new Map(players?.map((player) => [player.id, player.displayName]) ?? []);
  return (
    <div className={`event-tape${compact ? " compact" : ""}`}>
      {events.length === 0 ? (
        <div className="tape-quiet"><i /><p>等待下一条权威事件。</p></div>
      ) : [...events].sort((a, b) => b.sequence - a.sequence).map((event) => (
        <article className="event-row" key={event.sequence}>
          <time>{String(event.sequence).padStart(4, "0")}</time>
          <span className="event-pin" />
          <div><strong>{eventLabels[event.type] ?? event.type.replaceAll("_", " ")}</strong><p>{actionText(event, names)}</p></div>
          {event.handNo && <b>H{event.handNo}</b>}
        </article>
      ))}
    </div>
  );
}

export function SectionHeading({ eyebrow, title, aside }: { eyebrow: string; title: ReactNode; aside?: ReactNode }) {
  return <div className="section-heading"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1></div>{aside && <div className="heading-aside">{aside}</div>}</div>;
}

export function EmptyState({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return <div className="empty-state"><span className="empty-suit">♠</span><h2>{title}</h2><p>{body}</p>{action}</div>;
}

export function Modal({ title, eyebrow, onClose, children }: {
  title: string; eyebrow: string; onClose: () => void; children: ReactNode;
}) {
  useEffect(() => {
    const listener = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [onClose]);
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <header><div><p className="eyebrow">{eyebrow}</p><h2 id="modal-title">{title}</h2></div><button className="icon-button" type="button" onClick={onClose} aria-label="关闭弹窗">×</button></header>
        {children}
      </section>
    </div>
  );
}

export function LoadingBlock({ label = "正在读取权威状态" }: { label?: string }) {
  return <div className="loading-block"><i /><span>{label}</span></div>;
}

export function ErrorBlock({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return <div className="error-block"><span>!</span><div><strong>暂时无法读取</strong><p>{message}</p></div>{onRetry && <button className="text-button" onClick={onRetry}>重试</button>}</div>;
}
