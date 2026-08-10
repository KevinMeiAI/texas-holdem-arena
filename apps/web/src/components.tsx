import { type CSSProperties, type ReactNode, useEffect, useRef } from "react";
import { Link, NavLink } from "react-router-dom";
import type { ArenaEvent, ArenaPlayer, ArenaState } from "./types";

export function Brand() {
  return (
    <Link className="brand" to="/" aria-label="返回德扑竞技场直播页">
      <span className="brand-mark" aria-hidden="true">A♠</span>
      <span className="brand-copy"><strong>德扑竞技场</strong><small>模型锦标赛</small></span>
    </Link>
  );
}

export function AppHeader({ admin = false }: { admin?: boolean }) {
  return (
    <header className="site-header">
      <Brand />
      <nav className="site-nav" aria-label="公开页面导航">
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
      <span>本机单桌模型锦标赛</span>
      <span>发牌、决策、结算与公平性凭证均可复核</span>
    </footer>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const labels: Record<string, string> = {
    RUNNING: "直播中", PAUSED_INFRA: "基础设施暂停", PAUSED_ADMIN: "管理员暂停", COMPLETED: "已结束", CANCELLED: "已取消", READY: "准备中",
  };
  return <span className={`status-badge status-${status.toLowerCase()}`}><i />{labels[status] ?? status}</span>;
}

export function formatArenaPhase(phase: string): string {
  const labels: Record<string, string> = {
    READY: "准备中",
    RUNNING: "进行中",
    PAUSED_INFRA: "基础设施暂停",
    PAUSED_ADMIN: "管理员暂停",
    COMPLETED: "已结束",
    CANCELLED: "已取消",
    PREFLOP: "翻牌前",
    FLOP: "翻牌圈",
    TURN: "转牌圈",
    RIVER: "河牌圈",
    SHOWDOWN: "摊牌",
    HAND_COMPLETE: "本手结束",
  };
  return labels[phase] ?? phase;
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
  if (hidden) return <span className={`playing-card card-back${compact ? " compact" : ""}`} aria-label="未公开底牌"><i>A</i></span>;
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
    <section className="table-broadcast" aria-label={`${state.name} 牌桌`}>
      <div className="table-room-light" />
      <div className="poker-table-shell">
        <div className="poker-table-felt">
          <div className="table-signature"><span>可验证发牌</span><b>第 {String(hand?.handNo ?? state.completedHands).padStart(3, "0")} 手</b></div>
          {hand ? <>
            <div className="community-cards">
              {Array.from({ length: 5 }, (_, index) => <PlayingCard card={board[index]} key={index} />)}
            </div>
            <div className="pot-display"><span>总底池</span><strong>{formatChips(pot)}</strong></div>
          </> : <div className="table-result"><span>♛ 冠军</span><strong>{champion?.displayName ?? "—"}</strong></div>}
          {players.map((player, index) => {
            const angle = -90 + (360 / players.length) * index;
            const radians = angle * Math.PI / 180;
            const style = {
              "--seat-x": `${50 + Math.cos(radians) * 30}%`,
              "--seat-y": `${50 + Math.sin(radians) * 36}%`,
              "--seat-x-wide": `${50 + Math.cos(radians) * 38}%`,
              "--seat-y-wide": `${50 + Math.sin(radians) * 41}%`,
            } as CSSProperties;
            return <TableSeat key={player.id} player={player} state={state} style={style} />;
          })}
        </div>
      </div>
      {hand?.pots && hand.pots.length > 1 && (
        <div className="side-pot-strip" aria-label="边池">
          {hand.pots.map((item) => <span key={item.index}>边池 {item.index + 1} <b>{formatChips(item.amount)}</b> · {item.eligible.map((id) => labels.get(id) ?? id).join(", ")}</span>)}
        </div>
      )}
    </section>
  );
}

function TableSeat({ player, state, style }: { player: ArenaPlayer; state: ArenaState; style: CSSProperties }) {
  const hand = state.hand;
  const isActing = hand?.currentActorId === player.id;
  const isChampion = state.championPlayerId === player.id;
  const position = hand?.positions.button === player.seat ? "D"
    : hand?.positions.smallBlind === player.seat ? "SB"
      : hand?.positions.bigBlind === player.seat ? "BB" : null;
  const playerStatus: Record<string, string> = { ACTIVE: "在席", ELIMINATED: "已淘汰", CHAMPION: "冠军" };
  return (
    <article className={`table-seat${isActing ? " is-acting" : ""}${player.folded ? " is-folded" : ""}${player.status === "ELIMINATED" ? " is-out" : ""}`} style={style}>
      <div className="seat-meta"><span>座位 {String(player.seat + 1).padStart(2, "0")}</span>{position && <b>{position}</b>}</div>
      <div className="seat-name"><strong>{player.displayName}</strong>{isChampion && <span title="冠军">♛</span>}</div>
      <div className="seat-stack"><span>{player.allIn ? "全下" : player.folded ? "弃牌" : playerStatus[player.status] ?? player.status}</span><b>{formatChips(player.stack)}</b></div>
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
  SHOWDOWN_REVEALED: "摊牌",
  POT_CREATED: "底池形成",
  POT_AWARDED: "底池结算",
  UNCALLED_BET_RETURNED: "未跟注筹码退回",
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
    const rawAction = command?.action?.replaceAll("_", " ").toUpperCase() ?? "ACTION";
    const actionLabels: Record<string, string> = {
      CHECK: "过牌", CALL: "跟注", FOLD: "弃牌", BET: "下注", RAISE: "加注", "ALL IN": "全下", ACTION: "行动",
    };
    const action = actionLabels[rawAction] ?? rawAction;
    const paid = Number(payload.paid ?? 0);
    const amountTo = Number(payload.amountTo ?? command?.amount_to ?? 0);
    const amount = rawAction === "CALL" || rawAction === "ALL IN" ? paid
      : rawAction === "BET" || rawAction === "RAISE" ? amountTo : 0;
    return `${actor ?? "玩家"} · ${action}${amount > 0 ? ` · ${formatChips(amount)}` : ""}`;
  }
  if (event.type === "FORCED_BET_POSTED") {
    const kind = String(payload.kind ?? "BET");
    const forcedLabels: Record<string, string> = { SMALL_BLIND: "小盲", BIG_BLIND: "大盲", BIG_BLIND_ANTE: "大盲前注", ANTE: "前注", BET: "强制下注" };
    return `${forcedLabels[kind] ?? kind} · ${formatChips(Number(payload.amount ?? 0))}`;
  }
  if (event.type === "STREET_DEALT") {
    const street = String(payload.street ?? "BOARD");
    const streetLabels: Record<string, string> = { FLOP: "翻牌", TURN: "转牌", RIVER: "河牌", BOARD: "公共牌" };
    return `${streetLabels[street] ?? street} · ${Array.isArray(payload.cards) ? payload.cards.length : 0} 张牌`;
  }
  if (event.type === "MODEL_DECISION_RECORDED") return `${actor ?? "模型"} · 调用 ${Number(payload.providerCalls ?? 0)} 次${Number(payload.usedFallback) ? " · 启用兜底" : ""}`;
  if (event.type === "POT_AWARDED") {
    const award = payload.award as { playerId?: string; amount?: number } | undefined;
    return `${playerNames?.get(award?.playerId ?? "") ?? award?.playerId ?? "玩家"} · +${formatChips(award?.amount)}`;
  }
  return actor ? actor : `事件 ${String(event.sequence).padStart(4, "0")}`;
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

export function SectionHeading({ title, aside }: { title: ReactNode; aside?: ReactNode }) {
  return <div className="section-heading"><h1>{title}</h1>{aside && <div className="heading-aside">{aside}</div>}</div>;
}

export function EmptyState({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return <div className="empty-state"><span className="empty-suit">♠</span><h2>{title}</h2><p>{body}</p>{action}</div>;
}

export function Modal({ title, onClose, children }: {
  title: string; onClose: () => void; children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    return () => { if (dialog.open) dialog.close(); };
  }, []);
  return (
    <dialog ref={dialogRef} className="modal" aria-labelledby="modal-title" onCancel={(event) => { event.preventDefault(); onClose(); }} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <header><h2 id="modal-title">{title}</h2><button className="icon-button" type="button" onClick={onClose} aria-label="关闭弹窗">×</button></header>
      {children}
    </dialog>
  );
}

export function LoadingBlock({ label = "正在读取权威状态" }: { label?: string }) {
  return <div className="loading-block"><i /><span>{label}</span></div>;
}

export function ErrorBlock({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return <div className="error-block" role="alert"><span>!</span><div><strong>读取失败</strong><p>{message}</p></div>{onRetry && <button className="text-button" onClick={onRetry}>重新读取</button>}</div>;
}
