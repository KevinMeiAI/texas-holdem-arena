import type { PublicCompetitorProfile } from "../../../packages/contracts/src/competitors";
import { styleProfileLabel } from "./leaderboard-format";
import type { UiLocale } from "./ui-preferences";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface PlayerResultTrendPoint {
  ordinal: number;
  tournamentId: string;
  tournamentName: string;
  completedAt: string;
  finishingPosition: number;
  fieldSize: number;
  netBigBlinds: number;
  countedInCurrentRanking: boolean;
}

export interface PlayerProfileViewModel {
  locale: UiLocale;
  styleLabel: string;
  rates: {
    championship: string;
    topThree: string;
    vpip: string;
    pfr: string;
    threeBet: string;
    showdownWin: string;
    validDecision: string;
    firstPass: string;
    consistencyValidity: string;
    dominantDecision: string;
    pairwiseAgreement: string;
  };
  efficiency: {
    averageLatency: string;
    p95Latency: string;
    tokenCoverage: string;
  };
  sampleWarnings: {
    competition: string | null;
    style: string | null;
    reliability: string | null;
    efficiency: string | null;
  };
  resultTrend: PlayerResultTrendPoint[];
}

function localizedNumber(value: number, locale: UiLocale, maximumFractionDigits: number): string {
  return new Intl.NumberFormat(locale === "zh-CN" ? "zh-CN" : "en-US", {
    maximumFractionDigits,
  }).format(value);
}

function finiteOrNull(value: number | null): number | null {
  return value !== null && Number.isFinite(value) ? value : null;
}

/** Formats a normalized 0–1 rate while keeping unavailable values explicit. */
export function formatProfilePercent(value: number | null, locale: UiLocale = "zh-CN"): string {
  const rate = finiteOrNull(value);
  if (rate === null) return "—";
  return new Intl.NumberFormat(locale === "zh-CN" ? "zh-CN" : "en-US", {
    style: "percent",
    maximumFractionDigits: 1,
  }).format(rate);
}

export function formatProfileLatency(value: number | null, locale: UiLocale): string {
  const milliseconds = finiteOrNull(value);
  if (milliseconds === null) return "—";
  if (milliseconds < 1_000) {
    return locale === "zh-CN"
      ? `${localizedNumber(Math.round(milliseconds), locale, 0)} 毫秒`
      : `${localizedNumber(Math.round(milliseconds), locale, 0)} ms`;
  }
  const seconds = localizedNumber(milliseconds / 1_000, locale, 1);
  return locale === "zh-CN" ? `${seconds} 秒` : `${seconds} s`;
}

export function formatProfileTokens(value: number | null, locale: UiLocale): string {
  const tokens = finiteOrNull(value);
  return tokens === null ? "—" : localizedNumber(Math.max(0, Math.round(tokens)), locale, 0);
}

export function playerProfileTokenCoverageCopy(value: number | null, locale: UiLocale): string {
  const coverage = formatProfilePercent(value, locale);
  return locale === "zh-CN" ? `Token 覆盖 ${coverage}` : `Token coverage ${coverage}`;
}

export function profileStyleLabel(
  profile: PublicCompetitorProfile["style"]["profile"],
  locale: UiLocale,
): string {
  return profile === null ? "—" : styleProfileLabel(profile, locale);
}

export function profileEventClassLabel(
  eventClass: PublicCompetitorProfile["recentResults"][number]["eventClass"],
  locale: UiLocale,
): string {
  if (eventClass === "EXHIBITION") return locale === "zh-CN" ? "表演赛" : "Exhibition";
  return locale === "zh-CN" ? "评级赛" : "Rated";
}

export function profileConsistencyTierLabel(
  tier: NonNullable<PublicCompetitorProfile["consistency"]>["tier"],
  locale: UiLocale,
): string {
  const labels = {
    single: ["单场", "Single"],
    quick: ["快速", "Quick"],
    standard: ["标准", "Standard"],
    full: ["完整", "Full"],
  } as const;
  return locale === "zh-CN" ? labels[tier][0] : labels[tier][1];
}

export function profileResultScopeLabel(
  countedInCurrentRanking: boolean,
  eventClass: PublicCompetitorProfile["recentResults"][number]["eventClass"],
  locale: UiLocale,
): string {
  if (eventClass === "EXHIBITION") return locale === "zh-CN" ? "不计排名" : "Unrated";
  if (countedInCurrentRanking) return locale === "zh-CN" ? "计入当前排名" : "Current cohort";
  return locale === "zh-CN" ? "历史评级组" : "Historical cohort";
}

export function playerProfileSampleWarning(
  sampleWarning: boolean,
  locale: UiLocale,
): string | null {
  if (!sampleWarning) return null;
  return locale === "zh-CN" ? "样本量有限" : "Limited sample";
}

/** Produces immutable, chronological chart points from newest-first API results. */
export function playerResultTrend(
  profile: Pick<PublicCompetitorProfile, "recentResults">,
): PlayerResultTrendPoint[] {
  return [...profile.recentResults]
    .sort((left, right) => (
      left.completedAt.localeCompare(right.completedAt)
      || left.tournamentId.localeCompare(right.tournamentId)
    ))
    .map((result, index) => ({
      ordinal: index + 1,
      tournamentId: result.tournamentId,
      tournamentName: result.name,
      completedAt: result.completedAt,
      finishingPosition: result.finishingPosition,
      fieldSize: result.fieldSize,
      netBigBlinds: result.netBigBlinds,
      countedInCurrentRanking: result.countedInCurrentRanking,
    }));
}

function assertUuid(value: string): string {
  const normalized = value.trim().toLocaleLowerCase("en-US");
  if (!UUID_PATTERN.test(normalized)) {
    throw new TypeError("Player links require a UUID competitor id");
  }
  return normalized;
}

export function canonicalPlayerUrl(origin: string, competitorId: string): string {
  const base = new URL(origin);
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    throw new TypeError("Player links require an HTTP(S) origin");
  }
  return new URL(`/players/${assertUuid(competitorId)}`, base.origin).href;
}

function safeFilenameSegment(value: string): string {
  return value
    .normalize("NFKD")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "") || "player";
}

export function playerStoryCardFilename(
  profile: Pick<PublicCompetitorProfile, "competitor">,
): string {
  const competitorId = assertUuid(profile.competitor.id);
  const name = safeFilenameSegment(profile.competitor.displayName);
  return `arena-player-${name}-${competitorId.slice(0, 8)}.png`;
}

export function buildPlayerProfileModel(
  profile: PublicCompetitorProfile,
  locale: UiLocale,
): PlayerProfileViewModel {
  const warning = (value: boolean) => playerProfileSampleWarning(value, locale);
  const percent = (value: number | null) => formatProfilePercent(value, locale);
  return {
    locale,
    styleLabel: profileStyleLabel(profile.style.profile, locale),
    rates: {
      championship: percent(profile.competition.championshipRate),
      topThree: percent(profile.competition.topThreeRate),
      vpip: percent(profile.style.vpipRate),
      pfr: percent(profile.style.pfrRate),
      threeBet: percent(profile.style.threeBetRate),
      showdownWin: percent(profile.style.showdownWinRate),
      validDecision: percent(profile.reliability.validDecisionRate),
      firstPass: percent(profile.reliability.firstPassRate),
      consistencyValidity: percent(profile.consistency?.validityRate ?? null),
      dominantDecision: percent(profile.consistency?.meanDominantShare ?? null),
      pairwiseAgreement: percent(profile.consistency?.meanPairwiseAgreement ?? null),
    },
    efficiency: {
      averageLatency: formatProfileLatency(profile.efficiency.averageLatencyMs, locale),
      p95Latency: formatProfileLatency(profile.efficiency.p95LatencyMs, locale),
      tokenCoverage: playerProfileTokenCoverageCopy(profile.efficiency.tokenUsageCoverage, locale),
    },
    sampleWarnings: {
      competition: warning(profile.competition.sampleWarning),
      style: warning(profile.style.sampleWarning),
      reliability: warning(profile.reliability.sampleWarning),
      efficiency: warning(profile.efficiency.sampleWarning),
    },
    resultTrend: playerResultTrend(profile),
  };
}
