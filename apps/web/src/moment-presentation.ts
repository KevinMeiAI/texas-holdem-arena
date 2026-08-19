import type {
  MomentTag,
  PublicMomentDto,
} from "../../../packages/contracts/src/moments";
import type { WindowedBroadcastReplayData } from "./broadcast-replay-player";
import type { ArenaBroadcast, ArenaEvent, ArenaPlayer } from "./types";
import type { UiLocale } from "./ui-preferences";

const MOMENT_TAG_LABELS: Readonly<Record<MomentTag, readonly [zh: string, en: string]>> = {
  FINAL_HAND: ["决胜手", "Final hand"],
  ELIMINATION: ["淘汰", "Elimination"],
  MULTI_ELIMINATION: ["一手多淘汰", "Multi-elimination"],
  HEADS_UP_REACHED: ["进入单挑", "Heads-up reached"],
  ALL_IN: ["全下", "All-in"],
  MULTIWAY_ALL_IN: ["多人全下", "Multiway all-in"],
  LARGE_POT: ["大底池", "Large pot"],
  LEAD_CHANGE: ["领先易主", "Lead change"],
  SHORT_STACK_DOUBLE: ["短码翻倍", "Short-stack double"],
  FOUR_BET_PLUS: ["四次加注+", "Four-bet+"],
  OVERBET: ["超池下注", "Overbet"],
  SIDE_POT: ["边池", "Side pot"],
  SPLIT_POT: ["平分底池", "Split pot"],
  MULTIWAY_SHOWDOWN: ["多人摊牌", "Multiway showdown"],
  EQUITY_REVERSAL: ["胜率反转", "Equity reversal"],
  ALL_IN_UNDERDOG_WIN: ["全下爆冷", "All-in upset"],
  RARE_MADE_HAND: ["稀有成牌", "Rare made hand"],
  LONG_TANK: ["长考", "Long tank"],
};

const SPOILER_REVEALING_TAGS: ReadonlySet<MomentTag> = new Set([
  "FINAL_HAND",
  "ELIMINATION",
  "MULTI_ELIMINATION",
  "HEADS_UP_REACHED",
  "LEAD_CHANGE",
  "SHORT_STACK_DOUBLE",
  "SPLIT_POT",
  "MULTIWAY_SHOWDOWN",
  "EQUITY_REVERSAL",
  "ALL_IN_UNDERDOG_WIN",
  "RARE_MADE_HAND",
]);

export interface LocalizedMomentCopy {
  title: string;
  summary: string | null;
}

export interface MomentOutcomeProjection {
  winnerPlayerIds: string[];
  winners: ArenaPlayer[];
  eliminatedPlayerIds: string[];
  netChanges: Record<string, number>;
}

export interface MomentPublicFactsProjection {
  board: string[] | null;
  potChips: number | null;
  potBigBlinds: number | null;
}

export interface MomentReplayPayload {
  moment: PublicMomentDto;
  timeline: ArenaBroadcast[];
  events: ArenaEvent[];
  initialFrame: ArenaBroadcast | null;
  initialEliminatedPlayerIds: readonly string[];
}

function presentText(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

export function momentTagLabel(tag: MomentTag, locale: UiLocale): string {
  const [zh, en] = MOMENT_TAG_LABELS[tag];
  return locale === "zh-CN" ? zh : en;
}

export function publicMomentTagLabel(
  moment: Pick<PublicMomentDto, "primaryTag" | "spoilerMode">,
  locale: UiLocale,
  replayEnded: boolean,
): string {
  if (moment.spoilerMode === "SUSPENSE"
    && !replayEnded
    && SPOILER_REVEALING_TAGS.has(moment.primaryTag)) {
    return locale === "zh-CN" ? "关键牌局" : "Key hand";
  }
  return momentTagLabel(moment.primaryTag, locale);
}

export function localizedMomentCopy(
  moment: PublicMomentDto,
  locale: UiLocale,
): LocalizedMomentCopy {
  const preferredTitle = locale === "zh-CN" ? moment.titleZh : moment.titleEn;
  const preferredSummary = locale === "zh-CN" ? moment.summaryZh : moment.summaryEn;
  const hand = String(moment.handNo).padStart(3, "0");
  const fallbackTitle = locale === "zh-CN"
    ? `第 ${hand} 手 · ${publicMomentTagLabel(moment, locale, false)}`
    : `Hand ${hand} · ${publicMomentTagLabel(moment, locale, false)}`;

  return {
    title: presentText(preferredTitle) ?? fallbackTitle,
    summary: presentText(preferredSummary),
  };
}

export function sortMomentPlayersBySeat(
  playerIds: readonly string[],
  players: readonly ArenaPlayer[],
): ArenaPlayer[] {
  const included = new Set(playerIds);
  return players
    .filter((player) => included.has(player.id))
    .sort((left, right) => left.seat - right.seat || left.id.localeCompare(right.id));
}

export function momentPublicPlayerIds(
  moment: Pick<PublicMomentDto, "spoilerMode" | "facts">,
  replayEnded: boolean,
): string[] {
  const source = moment.spoilerMode === "SUSPENSE" && !replayEnded
    ? moment.facts.participantPlayerIds
    : moment.facts.featuredPlayerIds;
  return [...new Set(source)];
}

export function momentOutcomeProjection(
  moment: PublicMomentDto,
  players: readonly ArenaPlayer[],
  replayEnded: boolean,
): MomentOutcomeProjection | null {
  if (moment.spoilerMode === "SUSPENSE" && !replayEnded) return null;

  const winnerPlayerIds = [...new Set(moment.facts.winnerPlayerIds)];
  const eliminatedPlayerIds = [...new Set(moment.facts.eliminatedPlayerIds)];
  return {
    winnerPlayerIds,
    winners: sortMomentPlayersBySeat(winnerPlayerIds, players),
    eliminatedPlayerIds,
    netChanges: { ...moment.facts.netChanges },
  };
}

export function momentPublicFactsProjection(
  moment: PublicMomentDto,
  frame: ArenaBroadcast | null,
  replayEnded: boolean,
): MomentPublicFactsProjection {
  if (moment.spoilerMode === "RESULT" || replayEnded) {
    return {
      board: [...moment.facts.board],
      potChips: moment.facts.potChips,
      potBigBlinds: moment.facts.potBigBlinds,
    };
  }
  if (!frame) return { board: null, potChips: null, potBigBlinds: null };
  return {
    board: [...frame.board],
    potChips: frame.pot,
    potBigBlinds: frame.pot / moment.facts.bigBlind,
  };
}

export function momentReplayKey(moment: Pick<PublicMomentDto, "id" | "publicationRevision">): string {
  return `moment:${moment.id}:${moment.publicationRevision}`;
}

export function momentCanonicalUrl(slug: string, origin: string): string {
  return new URL(`/moments/${encodeURIComponent(slug)}`, origin).toString();
}

export function momentReplayData(payload: MomentReplayPayload): WindowedBroadcastReplayData {
  return {
    timeline: [...payload.timeline],
    events: [...payload.events],
    window: {
      startSequence: payload.moment.playbackStartSequence,
      endSequence: payload.moment.playbackEndSequence,
      initialFrame: payload.initialFrame,
      initialEliminatedPlayerIds: [...payload.initialEliminatedPlayerIds],
    },
  };
}
