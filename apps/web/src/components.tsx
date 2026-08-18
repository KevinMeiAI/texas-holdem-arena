import { type CSSProperties, type ReactNode, useEffect, useRef } from "react";
import { Link, NavLink } from "react-router-dom";
import { ProviderLogo } from "./provider-logo";
import type { ProviderBrand } from "./provider-brand";
import { spectatorTimeline, type SettlementPresentation, type SpectatorEventTone } from "./spectator-event-timeline";
import { tableSeatLayout } from "./table-layout";
import type {
  ArenaBroadcast,
  ArenaBroadcastLastAction,
  ArenaBroadcastPlayer,
  ArenaEvent,
  ArenaPlayer,
  ArenaState,
} from "./types";
import { PreferenceControls, type UiLocale, uiText, useUiPreferences } from "./ui-preferences";

export function Brand() {
  const { text } = useUiPreferences();
  return (
    <Link className="brand" to="/" aria-label={text("返回德扑竞技场观赛室", "Return to the watch room")}>
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
        <NavLink to="/" end>{text("观赛室", "Watch Room")}</NavLink>
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

/** 为模型分配稳定的身份色，与筹码走势图的 9 色系列同源。 */
export function modelTint(id: string): CSSProperties {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) {
    hash = (hash * 31 + id.charCodeAt(index)) >>> 0;
  }
  return { "--tint": `var(--chart-series-${(hash % 9) + 1})` } as CSSProperties;
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

export function PokerTable({
  state,
  broadcast = null,
  playerBrands = {},
  historical = false,
  eliminatedPlayerIds = new Set<string>(),
  settlement = null,
}: {
  state: ArenaState;
  broadcast?: ArenaBroadcast | null;
  playerBrands?: Readonly<Record<string, ProviderBrand | null>>;
  historical?: boolean;
  eliminatedPlayerIds?: ReadonlySet<string>;
  settlement?: SettlementPresentation | null;
}) {
  const { text } = useUiPreferences();
  const players = [...state.players].sort((a, b) => a.seat - b.seat);
  const hand = state.hand;
  const board = broadcast?.board ?? hand?.boards[0] ?? [];
  const settledPot = hand?.pots.reduce((sum, item) => sum + item.amount, 0) ?? 0;
  const pot = broadcast?.pot ?? (settledPot > 0 ? settledPot : players.reduce((sum, player) => sum + player.totalCommitted, 0));
  const labels = new Map(players.map((player) => [player.id, player.displayName]));
  const champion = players.find((player) => player.id === state.championPlayerId);
  const broadcastByPlayer = new Map(broadcast?.players.map((player) => [player.playerId, player]) ?? []);
  const sidePots = broadcast?.pots ?? hand?.pots ?? [];
  const winnerPlayerIds = new Set(settlement?.winnerPlayerIds ?? []);
  const tablePlayers = players.map((player, index) => {
    const placement = tableSeatLayout(players.length, index);
    const style = {
      "--seat-x": `${placement.compact.x}%`,
      "--seat-y": `${placement.compact.y}%`,
      "--seat-x-wide": `${placement.wide.x}%`,
      "--seat-y-wide": `${placement.wide.y}%`,
      "--bet-shift-x": `${placement.compactBetShift.x}rem`,
      "--bet-shift-y": `${placement.compactBetShift.y}rem`,
      "--bet-shift-x-wide": `${placement.wideBetShift.x}rem`,
      "--bet-shift-y-wide": `${placement.wideBetShift.y}rem`,
    } as CSSProperties;
    return { player, style };
  });

  return (
    <section className="table-broadcast" aria-label={`${state.name} ${text("牌桌", "table")}`}>
      <div className="table-room-light" />
      <div className="poker-table-shell" data-player-count={players.length}>
        <div className="poker-table-felt">
          {hand || broadcast ? <>
            <div className="table-center" role="group" aria-label={text("公共牌与底池", "Board and pot")}>
              <div className="community-cards">
                {Array.from({ length: 5 }, (_, index) => <PlayingCard card={board[index]} key={index} />)}
              </div>
              <div className="pot-display"><span>{text("总底池", "Pot")}</span><strong>{formatChips(pot)}</strong></div>
            </div>
          </> : <div className="table-result"><span>♛ {text("冠军", "Champion")}</span><strong>{champion?.displayName ?? "—"}</strong></div>}
          {settlement && tablePlayers.filter(({ player }) => winnerPlayerIds.has(player.id)).map(({ player, style }) => (
            <span className="pot-transfer" style={style} key={`${settlement.sequence}-${player.id}`} aria-hidden="true"><i /><i /><i /></span>
          ))}
          {tablePlayers.map(({ player, style }) => <TableSeat key={player.id} player={player} providerBrand={playerBrands[player.id] ?? null} state={state} broadcast={broadcastByPlayer.get(player.id)} broadcastHandNo={broadcast?.handNo ?? null} currentActorId={broadcast ? broadcast.currentActorId : hand?.currentActorId ?? null} positions={broadcast?.positions ?? hand?.positions ?? null} estimated={broadcast?.estimated === true} samples={broadcast?.samples ?? 0} historical={historical} eliminated={eliminatedPlayerIds.has(player.id)} winnerAmount={settlement?.amountsByPlayer[player.id] ?? null} settlementSequence={settlement?.sequence ?? null} style={style} />)}
        </div>
      </div>
      {sidePots.length > 1 && (!hand || !broadcast || broadcast.handNo === hand.handNo) && (
        <div className="side-pot-strip" aria-label={text("边池", "Side pots")}>
          {sidePots.map((item) => <span key={item.index}>{text("边池", "Side pot")} {item.index + 1} <b>{formatChips(item.amount)}</b> · {item.eligible.map((id) => labels.get(id) ?? id).join(", ")}</span>)}
        </div>
      )}
    </section>
  );
}

function compactActionLabel(action: ArenaBroadcastLastAction, locale: "zh-CN" | "en"): string {
  const format = (value: number) => new Intl.NumberFormat("en-US", { notation: value >= 10_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value);
  const amount = action.classification === "call" ? action.paid : action.amountTo;
  const labels: Record<string, [string, string]> = {
    fold: ["弃牌", "Fold"],
    check: ["过牌", "Check"],
    call: ["跟注", "Call"],
    bet: ["下注至", "Bet to"],
    raise: ["加注至", "Raise to"],
    short_raise: ["加注至", "Raise to"],
  };
  const actionLabel = action.action === "all_in"
    ? locale === "en" ? "All-in" : "全下"
    : labels[action.classification]?.[locale === "en" ? 1 : 0] ?? action.action.toUpperCase();
  return `${action.term ? `${action.term} · ` : ""}${actionLabel}${amount > 0 ? ` ${format(amount)}` : ""}`;
}

function TableSeat({ player, providerBrand, state, broadcast, broadcastHandNo, currentActorId, positions, estimated, samples, historical, eliminated, winnerAmount, settlementSequence, style }: {
  player: ArenaPlayer;
  providerBrand: ProviderBrand | null;
  state: ArenaState;
  broadcast?: ArenaBroadcastPlayer | undefined;
  broadcastHandNo: number | null;
  currentActorId: string | null;
  positions: { button: number; smallBlind: number; bigBlind: number; headsUp: boolean } | null;
  estimated: boolean;
  samples: number;
  historical: boolean;
  eliminated: boolean;
  winnerAmount: number | null;
  settlementSequence: number | null;
  style: CSSProperties;
}) {
  const { locale, text } = useUiPreferences();
  const hand = state.hand;
  const isCurrentHand = broadcastHandNo === null || hand?.handNo === broadcastHandNo;
  const isActing = isCurrentHand && currentActorId === player.id;
  const isChampion = !historical && state.championPlayerId === player.id;
  const position = positions?.headsUp && positions.button === player.seat ? "D · SB"
    : positions?.button === player.seat ? "D"
    : positions?.smallBlind === player.seat ? "SB"
      : positions?.bigBlind === player.seat ? "BB" : null;
  const playerStatus: Record<string, string> = { ACTIVE: text("在席", "Active"), ELIMINATED: text("已淘汰", "Out"), CHAMPION: text("冠军", "Champion") };
  const folded = broadcast?.folded ?? player.folded;
  const allIn = broadcast?.allIn ?? player.allIn;
  const stack = broadcast?.stack ?? player.stack;
  const streetCommitted = broadcast?.streetCommitted ?? player.streetCommitted;
  const cardsReady = (broadcast?.holeCards.length ?? 0) >= 2;
  const equityPercent = broadcast?.equity === null || broadcast?.equity === undefined ? null : broadcast.equity * 100;
  const equityLabel = equityPercent === null ? "—" : `${Math.round(equityPercent)}%`;
  const equityTitle = !cardsReady
    ? text("等待发牌", "Waiting for the deal")
    : equityPercent === null
    ? text("已弃牌，不参与当前胜率计算", "Folded — excluded from live equity")
    : `${estimated ? text("模拟摊牌权益", "Estimated showdown equity") : text("精确摊牌权益", "Exact showdown equity")} ${equityPercent.toFixed(1)}% · ${samples.toLocaleString()} ${text("次牌面", "runouts")}`;
  const statusLabel = isActing ? text("思考中", "Thinking")
    : allIn ? text("全下", "All-in")
      : folded ? text("弃牌", "Folded")
        : historical && eliminated ? text("已淘汰", "Out")
          : historical && broadcast ? text("在席", "Active")
            : playerStatus[player.status] ?? player.status;
  const isPotWinner = winnerAmount !== null;
  const visibleLastAction = broadcast?.lastAction?.classification === "fold" && folded ? null : broadcast?.lastAction;
  return (
    <article className={`table-seat${position ? " has-position" : ""}${isActing ? " is-acting" : ""}${folded ? " is-folded" : ""}${isPotWinner ? " is-pot-winner" : ""}${historical ? eliminated ? " is-out" : "" : player.status === "ELIMINATED" && !broadcast ? " is-out" : ""}`} data-seat={player.seat + 1} style={style}>
      {isPotWinner && <span className="seat-winner-amount" key={`${settlementSequence}-${player.id}`}>+{formatChips(winnerAmount)}</span>}
      {position && <b className="seat-position">{position}</b>}
      <div className="seat-name">
        <ProviderLogo
          brand={providerBrand}
          label={player.displayName}
          fallback={player.displayName.trim().slice(0, 1).toLocaleUpperCase() || "?"}
          fallbackStyle={modelTint(player.id)}
          className="seat-provider-logo"
        />
        <strong title={player.displayName}>{player.displayName}</strong>
        {isChampion && <span className="seat-champion" title={text("冠军", "Champion")}>♛</span>}
      </div>
      {broadcast && <div className="seat-broadcast">
        <div className="seat-hole-cards" aria-label={`${player.displayName} ${text("手牌", "hole cards")}`}>
          <PlayingCard card={broadcast.holeCards[0]} hidden={!cardsReady} compact />
          <PlayingCard card={broadcast.holeCards[1]} hidden={!cardsReady} compact />
        </div>
        <strong className="seat-equity" title={equityTitle}>{equityLabel}</strong>
      </div>}
      <div className="seat-stack"><span className={isActing ? "seat-turn" : ""}>{statusLabel}</span><b>{formatChips(stack)}</b></div>
      {visibleLastAction && <div className={`seat-last-action is-${visibleLastAction.classification}`}>{compactActionLabel(visibleLastAction, locale)}</div>}
      {streetCommitted > 0 && <span className="seat-bet"><i aria-hidden="true" />{formatChips(streetCommitted)}</span>}
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
  ACTION_APPLIED: ["玩家行动", "Player action"],
  STREET_DEALT: ["公共牌发出", "Board dealt"],
  SHOWDOWN_REVEALED: ["摊牌", "Showdown"],
  POT_CREATED: ["底池形成", "Pot created"],
  POT_AWARDED: ["赢得底池", "Pot won"],
  UNCALLED_BET_RETURNED: ["收回筹码", "Chips returned"],
  HAND_COMPLETED: ["本手结束", "Hand completed"],
  PLAYER_ELIMINATED: ["玩家淘汰", "Player eliminated"],
  TOURNAMENT_COMPLETED: ["冠军产生", "Champion decided"],
  TOURNAMENT_PAUSED_INFRA: ["基础设施暂停", "Infrastructure paused"],
  TOURNAMENT_PAUSED_ADMIN: ["管理员暂停", "Admin paused"],
  TOURNAMENT_RESUMED: ["赛事继续", "Tournament resumed"],
  TOURNAMENT_CANCELLED: ["赛事取消", "Tournament cancelled"],
  RANDOMNESS_REVEALED: ["随机种子公开", "Seed revealed"],
};

function actionLabel(event: ArenaEvent, locale: UiLocale): string {
  const command = event.publicPayload.command as { action?: string } | undefined;
  const rawAction = command?.action?.replaceAll("_", " ").toUpperCase() ?? "ACTION";
  const labels: Record<string, [string, string]> = {
    CHECK: ["过牌", "Check"],
    CALL: ["跟注", "Call"],
    FOLD: ["弃牌", "Fold"],
    BET: ["下注", "Bet"],
    RAISE: ["加注", "Raise"],
    "ALL IN": ["全下", "All-in"],
    ACTION: ["玩家行动", "Player action"],
  };
  const label = labels[rawAction];
  return label ? uiText(locale, ...label) : rawAction;
}

function eventTitle(event: ArenaEvent, locale: UiLocale): string {
  if (event.type === "ACTION_APPLIED") return actionLabel(event, locale);
  if (event.type === "FORCED_BET_POSTED") {
    const kind = String(event.publicPayload.kind ?? "BET");
    const labels: Record<string, [string, string]> = {
      SMALL_BLIND: ["小盲", "Small blind"],
      BIG_BLIND: ["大盲", "Big blind"],
      BIG_BLIND_ANTE: ["大盲前注", "Big blind ante"],
      ANTE: ["前注", "Ante"],
      BET: ["强制下注", "Forced bet"],
    };
    const label = labels[kind];
    return label ? uiText(locale, ...label) : kind;
  }
  if (event.type === "STREET_DEALT") {
    const street = String(event.publicPayload.street ?? "BOARD");
    const labels: Record<string, [string, string]> = {
      FLOP: ["翻牌", "Flop"],
      TURN: ["转牌", "Turn"],
      RIVER: ["河牌", "River"],
      BOARD: ["公共牌", "Board"],
    };
    const label = labels[street];
    return label ? uiText(locale, ...label) : street;
  }
  const label = eventLabels[event.type];
  return label ? uiText(locale, ...label) : event.type.replaceAll("_", " ");
}

function actionText(event: ArenaEvent, locale: UiLocale, playerNames?: Map<string, string>): string {
  const payload = event.publicPayload;
  const payloadPlayerId = typeof payload.playerId === "string" ? payload.playerId : null;
  const actorId = event.actorId ?? payloadPlayerId;
  const actor = actorId ? playerNames?.get(actorId) ?? actorId.slice(0, 8) : null;
  if (event.type === "ACTION_APPLIED") {
    const command = payload.command as { action?: string; amount_to?: number } | undefined;
    const rawAction = command?.action?.replaceAll("_", " ").toUpperCase() ?? "ACTION";
    const paid = Number(payload.paid ?? 0);
    const amountTo = Number(payload.amountTo ?? command?.amount_to ?? 0);
    const amount = rawAction === "CALL" || rawAction === "ALL IN" ? paid
      : rawAction === "BET" || rawAction === "RAISE" ? amountTo : 0;
    return `${actor ?? uiText(locale, "玩家", "Player")}${amount > 0 ? ` · ${formatChips(amount)}` : ""}`;
  }
  if (event.type === "FORCED_BET_POSTED") {
    return `${actor ? `${actor} · ` : ""}${formatChips(Number(payload.amount ?? 0))}`;
  }
  if (event.type === "BLIND_LEVEL_SELECTED") {
    const level = payload.level as { smallBlind?: number; bigBlind?: number; bigBlindAnte?: number } | undefined;
    if (!level) return "";
    const blinds = `${formatChips(level.smallBlind)} / ${formatChips(level.bigBlind)}`;
    return Number(level.bigBlindAnte ?? 0) > 0 ? `${blinds} · BBA ${formatChips(level.bigBlindAnte)}` : blinds;
  }
  if (event.type === "STREET_DEALT") {
    const cardCount = Array.isArray(payload.cards) ? payload.cards.length : 0;
    return `${cardCount} ${uiText(locale, "张公共牌", cardCount === 1 ? "community card" : "community cards")}`;
  }
  if (event.type === "HOLE_CARDS_DEALT") return uiText(locale, "底牌已发给所有在席玩家", "Hole cards dealt to every active player");
  if (event.type === "SHOWDOWN_REVEALED") {
    const revealed = Array.isArray(payload.players) ? payload.players : [];
    const names = revealed.flatMap((item) => {
      if (!item || typeof item !== "object" || !("playerId" in item) || typeof item.playerId !== "string") return [];
      return [playerNames?.get(item.playerId) ?? item.playerId.slice(0, 8)];
    });
    return names.join(" · ");
  }
  if (event.type === "POT_AWARDED") {
    const award = payload.award as { playerId?: string; amount?: number } | undefined;
    return `${playerNames?.get(award?.playerId ?? "") ?? award?.playerId ?? uiText(locale, "玩家", "Player")} · ${uiText(locale, "赢得", "wins")} ${formatChips(award?.amount)}`;
  }
  if (event.type === "UNCALLED_BET_RETURNED") return `${actor ?? uiText(locale, "玩家", "Player")} · ${uiText(locale, "收回未跟注筹码", "uncalled chips returned")} ${formatChips(Number(payload.amount ?? 0))}`;
  if (event.type === "PLAYER_ELIMINATED") return `${actor ?? uiText(locale, "玩家", "Player")} · ${uiText(locale, "第", "finishes")} ${Number(payload.finishingPosition ?? 0)} ${uiText(locale, "名", "")}`;
  return actor ?? "";
}

function eventToneLabel(tone: SpectatorEventTone, locale: UiLocale): string {
  const labels: Record<SpectatorEventTone, [string, string]> = {
    aggressive: ["下注或加注", "Bet or raise"],
    passive: ["跟注或过牌", "Call or check"],
    fold: ["弃牌", "Fold"],
    deal: ["牌局流程", "Game flow"],
    result: ["牌局结果", "Result"],
    warning: ["赛事状态", "Tournament status"],
  };
  return uiText(locale, ...labels[tone]);
}

export function EventTape({ events, players, compact = false, emptyLabel, limit }: {
  events: ArenaEvent[]; players?: ArenaPlayer[]; compact?: boolean; emptyLabel?: string | undefined; limit?: number | undefined;
}) {
  const { locale, text } = useUiPreferences();
  const names = new Map(players?.map((player) => [player.id, player.displayName]) ?? []);
  const timeline = spectatorTimeline(events);
  const visibleTimeline = typeof limit === "number" ? timeline.slice(-limit) : timeline;
  return (
    <div className={`event-tape${compact ? " compact" : ""}`}>
      {visibleTimeline.length === 0 ? (
        <div className="tape-quiet"><i /><p>{emptyLabel ?? text("等待下一条事件。", "Waiting for the next event.")}</p></div>
      ) : [...visibleTimeline].reverse().map(({ event, tone }) => {
        const detail = actionText(event, locale, names);
        return (
          <article className="event-row" key={event.sequence}>
            <time>{String(event.sequence).padStart(4, "0")}</time>
            <span className={`event-pin is-${tone}`} role="img" aria-label={eventToneLabel(tone, locale)} title={eventToneLabel(tone, locale)} />
            <div><strong>{eventTitle(event, locale)}</strong>{detail && <p>{detail}</p>}</div>
            {event.handNo && <b>H{event.handNo}</b>}
          </article>
        );
      })}
    </div>
  );
}

export function SiteFooter() {
  const { text } = useUiPreferences();
  return (
    <footer className="site-footer">
      <span>{text("模型德州扑克竞技 · 发牌种子承诺、模型决策与 API 调用全程留痕，可独立验证。", "A verifiable Texas Hold'em arena for AI models — seed commitments, model decisions and API calls are fully auditable.")}</span>
    </footer>
  );
}

export function SectionHeading({ title, aside }: { title: ReactNode; aside?: ReactNode }) {
  return <div className="section-heading"><h1>{title}</h1>{aside && <div className="heading-aside">{aside}</div>}</div>;
}

export function EmptyState({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return <div className="empty-state"><span className="empty-suit">♠</span><h2>{title}</h2><p>{body}</p>{action}</div>;
}

export function Modal({ title, onClose, children, className = "" }: {
  title: string; onClose: () => void; children: ReactNode; className?: string;
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
    <dialog ref={dialogRef} className={`modal${className ? ` ${className}` : ""}`} aria-labelledby="modal-title" onCancel={(event) => { event.preventDefault(); onClose(); }} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
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
