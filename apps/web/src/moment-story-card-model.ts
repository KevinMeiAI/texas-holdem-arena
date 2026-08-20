import type { PublicMomentDto } from "../../../packages/contracts/src/moments";
import type { ProviderBrand } from "./provider-brand";
import {
  localizedMomentCopy,
  momentPublicPlayerIds,
  publicMomentTagLabel,
} from "./moment-presentation";
import type { ArenaBroadcast, ArenaBroadcastPlayer, ArenaState } from "./types";
import type { UiLocale } from "./ui-preferences";

export const MOMENT_STORY_CARD_SIZE = Object.freeze({ width: 1_200, height: 675 });

const PUBLIC_MOMENT_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface MomentStoryCardPlayer {
  playerId: string;
  displayName: string;
  seat: number;
  providerBrand: ProviderBrand | null;
  position: string | null;
  holeCards: string[];
  stack: number | null;
  equityPercent: number | null;
  folded: boolean | null;
  allIn: boolean | null;
}

export interface MomentStoryCardWinner {
  playerId: string;
  displayName: string;
}

export interface MomentStoryCardOutcome {
  winners: MomentStoryCardWinner[];
  netChanges: Record<string, number>;
}

export interface MomentStoryCardViewModel {
  size: typeof MOMENT_STORY_CARD_SIZE;
  locale: UiLocale;
  momentId: string;
  slug: string;
  spoilerMode: PublicMomentDto["spoilerMode"];
  tournamentName: string;
  handNo: number;
  handLabel: string;
  title: string;
  summary: string | null;
  tagLabel: string;
  street: string | null;
  board: string[];
  potChips: number | null;
  potBigBlinds: number | null;
  equityEstimated: boolean;
  equitySamples: number;
  featuredPlayers: MomentStoryCardPlayer[];
  additionalFeaturedCount: number;
  outcome: MomentStoryCardOutcome | null;
}

export interface BuildMomentStoryCardModelInput {
  moment: PublicMomentDto;
  state: ArenaState;
  coverFrame: ArenaBroadcast | null;
  playerBrands: Readonly<Record<string, ProviderBrand | null>>;
  locale: UiLocale;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function equityPercent(player: ArenaBroadcastPlayer | undefined): number | null {
  const equity = finiteOrNull(player?.equity);
  return equity === null ? null : Math.min(100, Math.max(0, equity * 100));
}

function tablePosition(
  seat: number,
  positions: ArenaBroadcast["positions"],
): string | null {
  if (!positions) return null;
  if (positions.headsUp && positions.button === seat) return "D · SB";
  if (positions.button === seat) return "D";
  if (positions.smallBlind === seat) return "SB";
  if (positions.bigBlind === seat) return "BB";
  return null;
}

function featuredPlayers(
  moment: PublicMomentDto,
  state: ArenaState,
  coverFrame: ArenaBroadcast | null,
  playerBrands: Readonly<Record<string, ProviderBrand | null>>,
  revealResult: boolean,
): { players: MomentStoryCardPlayer[]; additionalCount: number } {
  const publicIds = new Set(momentPublicPlayerIds(moment, revealResult));
  const ordered = state.players
    .filter((player) => publicIds.has(player.id))
    .sort((left, right) => left.seat - right.seat || left.id.localeCompare(right.id));
  const broadcastByPlayer = new Map(
    coverFrame?.players.map((player) => [player.playerId, player]) ?? [],
  );
  const causalContenders = !revealResult && coverFrame
    ? ordered.filter((player) => broadcastByPlayer.get(player.id)?.folded !== true)
    : ordered;
  const displayed = causalContenders.length > 0 ? causalContenders : ordered;

  return {
    players: displayed.slice(0, 3).map((player) => {
      const broadcast = broadcastByPlayer.get(player.id);
      const resultStack = revealResult ? finiteOrNull(moment.facts.endingStacks[player.id]) : null;
      return {
        playerId: player.id,
        displayName: player.displayName,
        seat: player.seat,
        providerBrand: playerBrands[player.id] ?? null,
        position: tablePosition(player.seat, coverFrame?.positions ?? null),
        holeCards: [...(broadcast?.holeCards ?? [])].slice(0, 2),
        stack: resultStack ?? finiteOrNull(broadcast?.stack),
        equityPercent: revealResult ? null : equityPercent(broadcast),
        folded: revealResult ? null : broadcast?.folded ?? null,
        allIn: revealResult ? null : broadcast?.allIn ?? null,
      };
    }),
    additionalCount: Math.max(0, displayed.length - 3),
  };
}

function resultOutcome(moment: PublicMomentDto, state: ArenaState): MomentStoryCardOutcome {
  const byId = new Map(state.players.map((player) => [player.id, player]));
  const winners = unique(moment.facts.winnerPlayerIds)
    .map((playerId) => ({ playerId, player: byId.get(playerId) }))
    .sort((left, right) => (
      (left.player?.seat ?? Number.MAX_SAFE_INTEGER)
      - (right.player?.seat ?? Number.MAX_SAFE_INTEGER)
      || left.playerId.localeCompare(right.playerId)
    ))
    .map(({ playerId, player }) => ({
      playerId,
      displayName: player?.displayName ?? playerId,
    }));
  return {
    winners,
    netChanges: { ...moment.facts.netChanges },
  };
}

export function buildMomentStoryCardModel({
  moment,
  state,
  coverFrame,
  playerBrands,
  locale,
}: BuildMomentStoryCardModelInput): MomentStoryCardViewModel {
  const revealResult = moment.spoilerMode === "RESULT";
  const copy = localizedMomentCopy(moment, locale);
  const featured = featuredPlayers(moment, state, coverFrame, playerBrands, revealResult);
  const potChips = revealResult
    ? finiteOrNull(moment.facts.potChips)
    : finiteOrNull(coverFrame?.pot);
  const bigBlind = finiteOrNull(moment.facts.bigBlind);

  return {
    size: MOMENT_STORY_CARD_SIZE,
    locale,
    momentId: moment.id,
    slug: moment.slug,
    spoilerMode: moment.spoilerMode,
    tournamentName: state.name,
    handNo: moment.handNo,
    handLabel: `H${String(moment.handNo).padStart(3, "0")}`,
    title: copy.title,
    summary: copy.summary,
    tagLabel: publicMomentTagLabel(moment, locale, revealResult),
    street: revealResult ? "HAND_COMPLETE" : coverFrame?.street ?? null,
    board: revealResult ? [...moment.facts.board] : [...(coverFrame?.board ?? [])],
    potChips,
    potBigBlinds: revealResult
      ? finiteOrNull(moment.facts.potBigBlinds)
      : potChips !== null && bigBlind !== null && bigBlind > 0
        ? potChips / bigBlind
        : null,
    equityEstimated: coverFrame?.estimated ?? false,
    equitySamples: Math.max(0, Math.trunc(finiteOrNull(coverFrame?.samples) ?? 0)),
    featuredPlayers: featured.players,
    additionalFeaturedCount: featured.additionalCount,
    outcome: revealResult ? resultOutcome(moment, state) : null,
  };
}

function assertPublicSlug(slug: string): string {
  const normalized = slug.trim().toLocaleLowerCase("en-US");
  if (!PUBLIC_MOMENT_SLUG.test(normalized)) {
    throw new TypeError("Moment slug must use lowercase letters, numbers, and single hyphens");
  }
  return normalized;
}

export function canonicalMomentUrl(origin: string, slug: string, locale: UiLocale = "zh-CN"): string {
  const base = new URL(origin);
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    throw new TypeError("Moment links require an HTTP(S) origin");
  }
  const url = new URL(`/moments/${assertPublicSlug(slug)}`, base.origin);
  if (locale === "en") url.searchParams.set("lang", "en");
  return url.href;
}

function safeFilenameSegment(value: string): string {
  return value
    .normalize("NFKD")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "") || "moment";
}

export function momentStoryCardFilename(
  moment: Pick<PublicMomentDto, "handNo" | "slug">,
): string {
  const handNo = Number.isSafeInteger(moment.handNo) && moment.handNo > 0
    ? moment.handNo
    : 0;
  return `arena-h${String(handNo).padStart(3, "0")}-${safeFilenameSegment(moment.slug)}.png`;
}
