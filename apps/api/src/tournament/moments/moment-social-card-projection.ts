import {
  MOMENT_SOCIAL_CARD_PROJECTION_VERSION,
  parseSocialCardProjection,
  type PublicMomentIndexPlayer,
  type PublicMomentDto,
  type SocialCardProjection,
} from "../../../../../packages/contracts/src/index.js";
import type { PublicTournamentIdentityContext } from "../arena-service.js";

export type SocialCardLocale = "zh-CN" | "en";
type CommonSocialCardProjection = Pick<
  SocialCardProjection,
  | "version"
  | "locale"
  | "tournamentName"
  | "handNo"
  | "title"
  | "summary"
  | "tagLabel"
  | "additionalPlayerCount"
>;

const REVEALING_TAGS = new Set([
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

const TAG_LABELS: Readonly<Record<PublicMomentDto["primaryTag"], string>> = {
  FINAL_HAND: "Final hand",
  ELIMINATION: "Elimination",
  MULTI_ELIMINATION: "Multi-elimination",
  HEADS_UP_REACHED: "Heads-up reached",
  ALL_IN: "All-in",
  MULTIWAY_ALL_IN: "Multiway all-in",
  LARGE_POT: "Large pot",
  LEAD_CHANGE: "Lead change",
  SHORT_STACK_DOUBLE: "Short-stack double",
  FOUR_BET_PLUS: "Four-bet+",
  OVERBET: "Overbet",
  SIDE_POT: "Side pot",
  SPLIT_POT: "Split pot",
  MULTIWAY_SHOWDOWN: "Multiway showdown",
  EQUITY_REVERSAL: "Equity reversal",
  ALL_IN_UNDERDOG_WIN: "All-in upset",
  RARE_MADE_HAND: "Rare made hand",
  LONG_TANK: "Long tank",
};

function englishText(value: string | null): string | null {
  return value?.trim() || null;
}

function tagLabel(moment: PublicMomentDto): string {
  if (moment.spoilerMode === "SUSPENSE" && REVEALING_TAGS.has(moment.primaryTag)) {
    return "Key hand";
  }
  return TAG_LABELS[moment.primaryTag];
}

function identitiesById(identity: PublicTournamentIdentityContext): Map<string, PublicMomentIndexPlayer> {
  return new Map(identity.players.map((player) => [player.id, player]));
}

function playersByMomentIds(
  identity: PublicTournamentIdentityContext,
  playerIds: readonly string[],
): PublicMomentIndexPlayer[] {
  const included = new Set(playerIds);
  return identity.players
    .filter((player) => included.has(player.id))
    .sort((left, right) => left.seat - right.seat || left.id.localeCompare(right.id));
}

function causalCover(moment: PublicMomentDto): { street: string | null; board: string[]; playerIds: string[] } {
  const actions = moment.facts.actions
    .filter((action) => action.sequence <= moment.coverSequence)
    .sort((left, right) => left.sequence - right.sequence);
  const street = actions.at(-1)?.street.toUpperCase() ?? null;
  const boardLength = street === "FLOP" ? 3 : street === "TURN" ? 4 : 0;
  const recentActors: string[] = [];
  const seen = new Set<string>();
  for (const action of [...actions].reverse()) {
    if (seen.has(action.playerId)) continue;
    seen.add(action.playerId);
    recentActors.push(action.playerId);
  }
  return {
    street,
    board: boardLength > 0 ? [...moment.facts.board].slice(0, boardLength) : [],
    playerIds: recentActors,
  };
}

function neutralPlayers(players: readonly PublicMomentIndexPlayer[]) {
  return players.slice(0, 3).map((player) => ({
    playerId: player.id,
    displayName: player.displayName,
    seat: player.seat,
    providerBrand: player.providerBrand,
    position: null,
    coverStack: null,
    coverEquityPercent: null,
    foldedAtCover: null,
    allInAtCover: null,
  }));
}

function featuredParticipants(
  identity: PublicTournamentIdentityContext,
  participantIds: readonly string[],
  recentActorIds: readonly string[],
): { all: PublicMomentIndexPlayer[]; featured: PublicMomentIndexPlayer[] } {
  const all = playersByMomentIds(identity, participantIds);
  const byId = new Map(all.map((player) => [player.id, player]));
  const selected: PublicMomentIndexPlayer[] = [];
  const selectedIds = new Set<string>();
  for (const playerId of recentActorIds) {
    const player = byId.get(playerId);
    if (!player || selectedIds.has(player.id)) continue;
    selected.push(player);
    selectedIds.add(player.id);
    if (selected.length === 3) break;
  }
  for (const player of all) {
    if (selected.length === 3) break;
    if (selectedIds.has(player.id)) continue;
    selected.push(player);
    selectedIds.add(player.id);
  }
  return {
    all,
    featured: selected.sort((left, right) => left.seat - right.seat || left.id.localeCompare(right.id)),
  };
}

function buildSuspenseProjection(
  moment: PublicMomentDto,
  identity: PublicTournamentIdentityContext,
  common: CommonSocialCardProjection,
): SocialCardProjection {
  // Request-time card generation intentionally does not rebuild the replay.
  // A neutral cover is both cheaper and a stronger non-spoiler boundary. The
  // featured seats come from the hand participant set, never the tournament's
  // first seats and never winner ordering.
  const cover = causalCover(moment);
  const participants = featuredParticipants(
    identity,
    moment.facts.participantPlayerIds,
    cover.playerIds,
  );
  const players = neutralPlayers(participants.featured);
  if (players.length === 0) throw new Error("Moment tournament has no public player identities");
  return parseSocialCardProjection({
    ...common,
    spoilerMode: "SUSPENSE",
    additionalPlayerCount: Math.max(0, participants.all.length - players.length),
    coverStreetLabel: cover.street === "PREFLOP"
      ? "Pre-flop"
      : cover.street === "FLOP"
        ? "Flop"
        : cover.street === "TURN"
          ? "Turn"
          : null,
    coverBoard: cover.board,
    coverPotChips: null,
    coverPotBigBlinds: null,
    players,
  });
}

function buildResultProjection(
  moment: PublicMomentDto,
  identity: PublicTournamentIdentityContext,
  common: CommonSocialCardProjection,
): SocialCardProjection {
  const identityById = identitiesById(identity);
  const featuredIds = [...new Set(moment.facts.featuredPlayerIds)];
  const players = featuredIds.flatMap((playerId) => {
    const publicPlayer = identityById.get(playerId);
    if (!publicPlayer) return [];
    return [{
      playerId,
      displayName: publicPlayer.displayName,
      seat: publicPlayer.seat,
      providerBrand: publicPlayer.providerBrand,
      position: null,
      revealedHoleCards: [],
      endingStack: moment.facts.endingStacks[playerId] ?? null,
    }];
  }).sort((left, right) => left.seat - right.seat);
  if (players.length === 0) throw new Error("Moment has no public featured player identities");
  const winners = [...new Set(moment.facts.winnerPlayerIds)].flatMap((playerId) => {
    const publicPlayer = identityById.get(playerId);
    return publicPlayer ? [{
      playerId,
      displayName: publicPlayer.displayName,
      netChange: moment.facts.netChanges[playerId] ?? 0,
    }] : [];
  });
  if (winners.length === 0) throw new Error("Moment has no public winner identities");
  return parseSocialCardProjection({
    ...common,
    spoilerMode: "RESULT",
    additionalPlayerCount: Math.max(0, featuredIds.length - Math.min(3, players.length)),
    finalStreetLabel: "Result",
    finalBoard: [...moment.facts.board],
    finalPotChips: moment.facts.potChips,
    finalPotBigBlinds: moment.facts.potBigBlinds,
    players: players.slice(0, 3),
    winners,
  });
}

export function buildSocialCardProjection(input: {
  moment: PublicMomentDto;
  identity: PublicTournamentIdentityContext;
  locale: SocialCardLocale;
}): SocialCardProjection {
  const { moment, identity, locale } = input;
  // The v1 renderer deliberately has no host-font dependency. Both URL
  // locales therefore use English image copy while HTML metadata remains
  // localized. This is explicit and readable, unlike silent glyph loss.
  const tag = tagLabel(moment);
  const title = englishText(moment.titleEn) ?? `Hand ${moment.handNo} · ${tag}`;
  const common = {
    version: MOMENT_SOCIAL_CARD_PROJECTION_VERSION,
    locale,
    tournamentName: identity.tournament.name,
    handNo: moment.handNo,
    title,
    summary: englishText(moment.summaryEn),
    tagLabel: tag,
    additionalPlayerCount: 0,
  } satisfies CommonSocialCardProjection;
  return moment.spoilerMode === "SUSPENSE"
    ? buildSuspenseProjection(moment, identity, common)
    : buildResultProjection(moment, identity, common);
}
