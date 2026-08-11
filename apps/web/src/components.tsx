import { type CSSProperties, type ReactNode, useEffect, useRef } from "react";
import { Link, NavLink } from "react-router-dom";
import type { ArenaEvent, ArenaPlayer, ArenaState } from "./types";
import { PreferenceControls, type UiLocale, uiText, useUiPreferences } from "./ui-preferences";

export function Brand() {
  const { text } = useUiPreferences();
  return (
    <Link className="brand" to="/" aria-label={text("返回德扑竞技场直播页", "Return to the live table")}>
      <span className="brand-mark" aria-hidden="true">A♠</span>
      <span className="brand-copy"><strong>{text("德扑竞技场", "Hold'em Arena")}</strong></span>
    </Link>
  );
}

export function AppHeader({ admin = false }: { admin?: boolean }) {
  const { text } = useUiPreferences();
  return (
    <header className="site-header">
      <Brand />
      <nav className="site-nav" aria-label={text("公开页面导航", "Public navigation")}>
        <NavLink to="/" end>{text("现场", "Live")}</NavLink>
        <NavLink to="/tournaments">{text("赛事", "Events")}</NavLink>
        <NavLink to="/leaderboard">{text("榜单", "Ranks")}</NavLink>
        <NavLink className={admin ? "admin-link active" : "admin-link"} to="/admin">{text("控制室", "Admin")}</NavLink>
      </nav>
      <PreferenceControls />
    </header>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const { locale } = useUiPreferences();
  const labels: Record<string, [string, string]> = {
    RUNNING: ["直播中", "Live"], PAUSED_INFRA: ["基础设施暂停", "Infra paused"], PAUSED_ADMIN: ["管理员暂停", "Paused"], COMPLETED: ["已结束", "Completed"], CANCELLED: ["已取消", "Cancelled"], READY: ["准备中", "Ready"],
  };
  const label = labels[status];
  return <span className={`status-badge status-${status.toLowerCase()}`}><i />{label ? uiText(locale, ...label) : status}</span>;
}

export function formatArenaPhase(phase: string, locale: UiLocale = "zh-CN"): string {
  const labels: Record<string, [string, string]> = {
    READY: ["准备中", "Ready"],
    RUNNING: ["进行中", "Running"],
    PAUSED_INFRA: ["基础设施暂停", "Infra paused"],
    PAUSED_ADMIN: ["管理员暂停", "Paused"],
    COMPLETED: ["已结束", "Completed"],
    CANCELLED: ["已取消", "Cancelled"],
    PREFLOP: ["翻牌前", "Pre-flop"],
    FLOP: ["翻牌圈", "Flop"],
    TURN: ["转牌圈", "Turn"],
    RIVER: ["河牌圈", "River"],
    SHOWDOWN: ["摊牌", "Showdown"],
    HAND_COMPLETE: ["本手结束", "Hand complete"],
  };
  const label = labels[phase];
  return label ? uiText(locale, ...label) : phase;
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
  const { text } = useUiPreferences();
  const parts = cardParts(card);
  if (hidden) return <span className={`playing-card card-back${compact ? " compact" : ""}`} aria-label={text("未公开底牌", "Hidden hole card")}><i>A</i></span>;
  if (!parts) return <span className={`playing-card card-empty${compact ? " compact" : ""}`} aria-hidden="true" />;
  return (
    <span className={`playing-card${parts.red ? " red" : ""}${compact ? " compact" : ""}`} aria-label={`${parts.rank}${parts.suit}`}>
      <strong>{parts.rank}</strong><i>{parts.suit}</i>
    </span>
  );
}

export function PokerTable({ state }: { state: ArenaState }) {
  const { text } = useUiPreferences();
  const players = [...state.players].sort((a, b) => a.seat - b.seat);
  const hand = state.hand;
  const board = hand?.boards[0] ?? [];
  const settledPot = hand?.pots.reduce((sum, item) => sum + item.amount, 0) ?? 0;
  const pot = settledPot > 0 ? settledPot : players.reduce((sum, player) => sum + player.totalCommitted, 0);
  const labels = new Map(players.map((player) => [player.id, player.displayName]));
  const champion = players.find((player) => player.id === state.championPlayerId);

  return (
    <section className="table-broadcast" aria-label={`${state.name} ${text("牌桌", "table")}`}>
      <div className="table-room-light" />
      <div className="poker-table-shell">
        <div className="poker-table-felt">
          <div className="table-signature"><b>{text("第", "Hand")} {String(hand?.handNo ?? state.completedHands).padStart(3, "0")} {text("手", "")}</b></div>
          {hand ? <>
            <div className="community-cards">
              {Array.from({ length: 5 }, (_, index) => <PlayingCard card={board[index]} key={index} />)}
            </div>
            <div className="pot-display"><span>{text("总底池", "Pot")}</span><strong>{formatChips(pot)}</strong></div>
          </> : <div className="table-result"><span>♛ {text("冠军", "Champion")}</span><strong>{champion?.displayName ?? "—"}</strong></div>}
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
        <div className="side-pot-strip" aria-label={text("边池", "Side pots")}>
          {hand.pots.map((item) => <span key={item.index}>{text("边池", "Side pot")} {item.index + 1} <b>{formatChips(item.amount)}</b> · {item.eligible.map((id) => labels.get(id) ?? id).join(", ")}</span>)}
        </div>
      )}
    </section>
  );
}

function TableSeat({ player, state, style }: { player: ArenaPlayer; state: ArenaState; style: CSSProperties }) {
  const { text } = useUiPreferences();
  const hand = state.hand;
  const isActing = hand?.currentActorId === player.id;
  const isChampion = state.championPlayerId === player.id;
  const position = hand?.positions.button === player.seat ? "D"
    : hand?.positions.smallBlind === player.seat ? "SB"
      : hand?.positions.bigBlind === player.seat ? "BB" : null;
  const playerStatus: Record<string, string> = { ACTIVE: text("在席", "Active"), ELIMINATED: text("已淘汰", "Out"), CHAMPION: text("冠军", "Champion") };
  return (
    <article className={`table-seat${isActing ? " is-acting" : ""}${player.folded ? " is-folded" : ""}${player.status === "ELIMINATED" ? " is-out" : ""}`} data-acting-label={text("正在决策", "Thinking")} style={style}>
      <div className="seat-meta"><span>{text("座位", "Seat")} {String(player.seat + 1).padStart(2, "0")}</span>{position && <b>{position}</b>}</div>
      <div className="seat-name"><strong>{player.displayName}</strong>{isChampion && <span title={text("冠军", "Champion")}>♛</span>}</div>
      <div className="seat-stack"><span>{player.allIn ? text("全下", "All-in") : player.folded ? text("弃牌", "Folded") : playerStatus[player.status] ?? player.status}</span><b>{formatChips(player.stack)}</b></div>
      {player.streetCommitted > 0 && <span className="seat-bet">+{formatChips(player.streetCommitted)}</span>}
    </article>
  );
}

const eventLabels: Record<string, [string, string]> = {
  TOURNAMENT_CONFIG_FROZEN: ["赛事配置锁定", "Configuration locked"],
  RANDOMNESS_COMMITTED: ["随机种子承诺", "Seed committed"],
  TOURNAMENT_STARTED: ["锦标赛开始", "Tournament started"],
  BLIND_LEVEL_SELECTED: ["盲注级别更新", "Blind level updated"],
  HAND_STARTED: ["新一手开始", "Hand started"],
  FORCED_BET_POSTED: ["强制下注", "Forced bet"],
  HOLE_CARDS_DEALT: ["底牌发出", "Hole cards dealt"],
  BETTING_ROUND_STARTED: ["下注轮开始", "Betting round started"],
  MODEL_DECISION_RECORDED: ["模型完成决策", "Model decision recorded"],
  ACTION_APPLIED: ["行动执行", "Action applied"],
  STREET_DEALT: ["公共牌发出", "Board dealt"],
  SHOWDOWN_REVEALED: ["摊牌", "Showdown"],
  POT_CREATED: ["底池形成", "Pot created"],
  POT_AWARDED: ["底池结算", "Pot awarded"],
  UNCALLED_BET_RETURNED: ["未跟注筹码退回", "Uncalled bet returned"],
  HAND_COMPLETED: ["本手结束", "Hand completed"],
  PLAYER_ELIMINATED: ["玩家淘汰", "Player eliminated"],
  TOURNAMENT_COMPLETED: ["冠军产生", "Champion decided"],
  TOURNAMENT_PAUSED_INFRA: ["基础设施暂停", "Infrastructure paused"],
  TOURNAMENT_PAUSED_ADMIN: ["管理员暂停", "Admin paused"],
  TOURNAMENT_RESUMED: ["赛事继续", "Tournament resumed"],
  TOURNAMENT_CANCELLED: ["赛事取消", "Tournament cancelled"],
  RANDOMNESS_REVEALED: ["随机种子公开", "Seed revealed"],
};

function actionText(event: ArenaEvent, locale: UiLocale, playerNames?: Map<string, string>): string {
  const payload = event.publicPayload;
  const actor = event.actorId ? playerNames?.get(event.actorId) ?? event.actorId.slice(0, 8) : null;
  if (event.type === "ACTION_APPLIED") {
    const command = payload.command as { action?: string; amount_to?: number } | undefined;
    const rawAction = command?.action?.replaceAll("_", " ").toUpperCase() ?? "ACTION";
    const actionLabels: Record<string, [string, string]> = {
      CHECK: ["过牌", "Check"], CALL: ["跟注", "Call"], FOLD: ["弃牌", "Fold"], BET: ["下注", "Bet"], RAISE: ["加注", "Raise"], "ALL IN": ["全下", "All-in"], ACTION: ["行动", "Action"],
    };
    const actionLabel = actionLabels[rawAction];
    const action = actionLabel ? uiText(locale, ...actionLabel) : rawAction;
    const paid = Number(payload.paid ?? 0);
    const amountTo = Number(payload.amountTo ?? command?.amount_to ?? 0);
    const amount = rawAction === "CALL" || rawAction === "ALL IN" ? paid
      : rawAction === "BET" || rawAction === "RAISE" ? amountTo : 0;
    return `${actor ?? uiText(locale, "玩家", "Player")} · ${action}${amount > 0 ? ` · ${formatChips(amount)}` : ""}`;
  }
  if (event.type === "FORCED_BET_POSTED") {
    const kind = String(payload.kind ?? "BET");
    const forcedLabels: Record<string, [string, string]> = { SMALL_BLIND: ["小盲", "Small blind"], BIG_BLIND: ["大盲", "Big blind"], BIG_BLIND_ANTE: ["大盲前注", "Big blind ante"], ANTE: ["前注", "Ante"], BET: ["强制下注", "Forced bet"] };
    const forcedLabel = forcedLabels[kind];
    return `${forcedLabel ? uiText(locale, ...forcedLabel) : kind} · ${formatChips(Number(payload.amount ?? 0))}`;
  }
  if (event.type === "STREET_DEALT") {
    const street = String(payload.street ?? "BOARD");
    const streetLabels: Record<string, [string, string]> = { FLOP: ["翻牌", "Flop"], TURN: ["转牌", "Turn"], RIVER: ["河牌", "River"], BOARD: ["公共牌", "Board"] };
    const streetLabel = streetLabels[street];
    const cardCount = Array.isArray(payload.cards) ? payload.cards.length : 0;
    return `${streetLabel ? uiText(locale, ...streetLabel) : street} · ${cardCount} ${uiText(locale, "张牌", cardCount === 1 ? "card" : "cards")}`;
  }
  if (event.type === "MODEL_DECISION_RECORDED") return `${actor ?? uiText(locale, "模型", "Model")} · ${uiText(locale, "调用", "calls")} ${Number(payload.providerCalls ?? 0)}${uiText(locale, " 次", "")}${Number(payload.usedFallback) ? uiText(locale, " · 启用兜底", " · fallback") : ""}`;
  if (event.type === "POT_AWARDED") {
    const award = payload.award as { playerId?: string; amount?: number } | undefined;
    return `${playerNames?.get(award?.playerId ?? "") ?? award?.playerId ?? uiText(locale, "玩家", "Player")} · +${formatChips(award?.amount)}`;
  }
  return actor ? actor : `${uiText(locale, "事件", "Event")} ${String(event.sequence).padStart(4, "0")}`;
}

export function EventTape({ events, players, compact = false }: {
  events: ArenaEvent[]; players?: ArenaPlayer[]; compact?: boolean;
}) {
  const { locale, text } = useUiPreferences();
  const names = new Map(players?.map((player) => [player.id, player.displayName]) ?? []);
  return (
    <div className={`event-tape${compact ? " compact" : ""}`}>
      {events.length === 0 ? (
        <div className="tape-quiet"><i /><p>{text("等待下一条事件。", "Waiting for the next event.")}</p></div>
      ) : [...events].sort((a, b) => b.sequence - a.sequence).map((event) => (
        <article className="event-row" key={event.sequence}>
          <time>{String(event.sequence).padStart(4, "0")}</time>
          <span className="event-pin" />
          <div><strong>{eventLabels[event.type] ? uiText(locale, ...eventLabels[event.type]!) : event.type.replaceAll("_", " ")}</strong><p>{actionText(event, locale, names)}</p></div>
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
  const { text } = useUiPreferences();
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    return () => { if (dialog.open) dialog.close(); };
  }, []);
  return (
    <dialog ref={dialogRef} className="modal" aria-labelledby="modal-title" onCancel={(event) => { event.preventDefault(); onClose(); }} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <header><h2 id="modal-title">{title}</h2><button className="icon-button" type="button" onClick={onClose} aria-label={text("关闭弹窗", "Close dialog")}>×</button></header>
      {children}
    </dialog>
  );
}

export function LoadingBlock({ label }: { label?: string }) {
  const { text } = useUiPreferences();
  return <div className="loading-block"><i /><span>{label ?? text("正在读取状态", "Loading state")}</span></div>;
}

export function ErrorBlock({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const { text } = useUiPreferences();
  return <div className="error-block" role="alert"><span>!</span><div><strong>{text("读取失败", "Unable to load")}</strong><p>{message}</p></div>{onRetry && <button className="text-button" onClick={onRetry}>{text("重新读取", "Retry")}</button>}</div>;
}
