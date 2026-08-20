import type { Pool } from "pg";
import { z } from "zod";
import {
  publicCompetitorProfileSchema,
  type ProviderBrand,
  type PublicCompetitorProfile,
  type PublicCompetitorResult,
} from "../../../../packages/contracts/src/competitors.js";
import { resolveProviderBrand } from "../../../../packages/providers/src/provider-brand.js";
import type { ArenaService } from "../tournament/arena-service.js";
import type { ArenaLeaderboards } from "../tournament/statistics.js";
import type { MomentService } from "../tournament/moments/moment-service.js";
import type { CompetitorIdentityService } from "./identity-service.js";

interface RevisionRow {
  id: string;
  revision_number: number;
  model_id: string;
  competitor_display_name: string;
  provider_type: string;
  provider_profile: string;
  provider_label: string;
  base_url: string | null;
  is_available_current: boolean;
  is_model_current: boolean;
  created_at: Date;
}

interface TournamentEntryRow {
  tournament_id: string;
  name: string;
  event_class: "RATED" | "EXHIBITION";
  benchmark_cohort_id: string;
  benchmark_track_id: string;
  completed_at: Date;
  competitor_revision_id: string;
  display_name_at_entry: string;
}

interface ConsistencyRow {
  id: string;
  competitor_revision_id: string;
  tier: "single" | "quick" | "standard" | "full";
  scenario_registry_version: string;
  prompt_name: string;
  summary: unknown;
  completed_samples: number;
  scenario_count: number;
  completed_at: Date;
}

const consistencySummarySchema = z.object({
  completedSamples: z.number().int().nonnegative(),
  validityRate: z.number().min(0).max(1).nullable(),
  meanDominantShare: z.number().min(0).max(1).nullable(),
  meanPairwiseAgreement: z.number().min(0).max(1).nullable(),
}).passthrough();

type IdentityReader = Pick<CompetitorIdentityService, "getFamily">;
type ArenaReader = Pick<ArenaService, "leaderboard" | "tournamentStatistics">;
type MomentReader = Pick<MomentService, "listPublicForPlayers">;

function competitionFor(
  leaderboards: ArenaLeaderboards,
  competitorId: string,
): PublicCompetitorProfile["competition"] {
  const rankIndex = leaderboards.competition.findIndex((entry) => entry.competitorId === competitorId);
  const entry = rankIndex >= 0 ? leaderboards.competition[rankIndex] : null;
  return entry ? {
    rank: rankIndex + 1,
    rating: entry.rating,
    points: entry.points,
    tournaments: entry.tournaments,
    championships: entry.championships,
    championshipRate: entry.championshipRate,
    topThree: entry.topThree,
    topThreeRate: entry.topThreeRate,
    averageFinish: entry.averageFinish,
    sampleWarning: entry.sampleWarning,
  } : {
    rank: null,
    rating: null,
    points: 0,
    tournaments: 0,
    championships: 0,
    championshipRate: null,
    topThree: 0,
    topThreeRate: null,
    averageFinish: null,
    sampleWarning: true,
  };
}

function styleFor(
  leaderboards: ArenaLeaderboards,
  competitorId: string,
): PublicCompetitorProfile["style"] {
  const entry = leaderboards.styles.find((candidate) => candidate.competitorId === competitorId);
  return entry ? {
    handsPlayed: entry.handsPlayed,
    vpipRate: entry.vpipRate,
    pfrRate: entry.pfrRate,
    threeBetRate: entry.threeBetRate,
    showdownWinRate: entry.showdownWinRate,
    profile: entry.profile,
    sampleWarning: entry.sampleWarning,
  } : {
    handsPlayed: 0,
    vpipRate: null,
    pfrRate: null,
    threeBetRate: null,
    showdownWinRate: null,
    profile: null,
    sampleWarning: true,
  };
}

function reliabilityFor(
  leaderboards: ArenaLeaderboards,
  competitorId: string,
): PublicCompetitorProfile["reliability"] {
  const entry = leaderboards.reliability.find((candidate) => candidate.competitorId === competitorId);
  return entry ? {
    decisions: entry.decisions,
    validDecisionRate: entry.validDecisionRate,
    firstPassRate: entry.firstPassRate,
    protocolCorrections: entry.protocolCorrections,
    fallbacks: entry.fallbacks,
    timeouts: entry.timeouts,
    infrastructurePauses: entry.infrastructurePauses,
    sampleWarning: entry.sampleWarning,
  } : {
    decisions: 0,
    validDecisionRate: null,
    firstPassRate: null,
    protocolCorrections: 0,
    fallbacks: 0,
    timeouts: 0,
    infrastructurePauses: 0,
    sampleWarning: true,
  };
}

function efficiencyFor(
  leaderboards: ArenaLeaderboards,
  competitorId: string,
): PublicCompetitorProfile["efficiency"] {
  const entry = leaderboards.efficiency.find((candidate) => candidate.competitorId === competitorId);
  return entry ? {
    providerCalls: entry.providerCalls,
    averageLatencyMs: entry.averageLatencyMs,
    p95LatencyMs: entry.p95LatencyMs,
    totalTokens: entry.totalTokens,
    tokensPerDecision: entry.tokensPerDecision,
    tokenUsageCoverage: entry.tokenUsageCoverage,
    sampleWarning: entry.sampleWarning,
  } : {
    providerCalls: 0,
    averageLatencyMs: null,
    p95LatencyMs: null,
    totalTokens: null,
    tokensPerDecision: null,
    tokenUsageCoverage: null,
    sampleWarning: true,
  };
}

function consistencyFor(
  row: ConsistencyRow | undefined,
): PublicCompetitorProfile["consistency"] {
  if (!row) return null;
  const summary = consistencySummarySchema.parse(row.summary);
  if (summary.completedSamples !== row.completed_samples) {
    throw new Error(`Completed consistency summary is out of sync: ${row.id}`);
  }
  return {
    runId: row.id,
    competitorRevisionId: row.competitor_revision_id,
    tier: row.tier,
    scenarioRegistryVersion: row.scenario_registry_version,
    promptName: row.prompt_name,
    validityRate: summary.validityRate,
    meanDominantShare: summary.meanDominantShare,
    meanPairwiseAgreement: summary.meanPairwiseAgreement,
    completedSamples: summary.completedSamples,
    scenarioCount: row.scenario_count,
    completedAt: row.completed_at.toISOString(),
  };
}

function currentProviderBrand(row: RevisionRow | undefined): ProviderBrand | null {
  return row ? resolveProviderBrand({
    providerProfile: row.provider_profile,
    providerType: row.provider_type,
    label: row.provider_label,
    baseUrl: row.base_url,
    modelId: row.model_id,
  }) : null;
}

export class CompetitorProfileService {
  constructor(
    private readonly pool: Pool,
    private readonly identities: IdentityReader,
    private readonly arena: ArenaReader,
    private readonly moments: MomentReader,
  ) {}

  async getProfile(competitorId: string): Promise<PublicCompetitorProfile | null> {
    const [family, revisionResult, entryResult] = await Promise.all([
      this.identities.getFamily(competitorId),
      // A family may retain archived runtime configurations. Its public
      // revision is the newest available current revision, then the newest
      // retained current revision, then the newest historical revision.
      this.pool.query<RevisionRow>(
        `select r.id, r.revision_number, r.model_id,
                r.competitor_display_name, r.provider_type, r.provider_profile,
                p.label as provider_label, r.base_url,
                (m.current_revision_id = r.id
                  and m.deleted_at is null and m.enabled = true
                  and p.deleted_at is null) as is_available_current,
                (m.current_revision_id = r.id) as is_model_current,
                r.created_at
           from competitor_revisions r
           join model_configs m on m.id = r.model_config_id
           join provider_connections p on p.id = r.provider_connection_id
          where r.competitor_family_id = $1
          order by is_available_current desc, is_model_current desc,
                   r.created_at desc, r.revision_number desc, r.id`,
        [competitorId],
      ),
      this.pool.query<TournamentEntryRow>(
        `select t.id as tournament_id, t.name, t.event_class,
                t.benchmark_cohort_id, t.benchmark_track_id,
                t.updated_at as completed_at,
                e.competitor_revision_id, e.display_name_at_entry
           from tournament_entries e
           join competitor_revisions r on r.id = e.competitor_revision_id
           join tournaments t on t.id = e.tournament_id
          where r.competitor_family_id = $1 and t.status = 'COMPLETED'
          order by t.updated_at desc, t.id`,
        [competitorId],
      ),
    ]);
    if (!family) return null;

    const revisions = revisionResult.rows;
    const currentRevision = revisions[0];
    const revisionIds = revisions.map((revision) => revision.id);
    const consistencyPromise = currentRevision
      ? this.pool.query<ConsistencyRow>(
        `select r.id, r.competitor_revision_id, r.tier,
                r.scenario_registry_version, p.name as prompt_name,
                r.summary, r.completed_samples,
                jsonb_array_length(r.scenario_ids)::integer as scenario_count,
                r.completed_at
           from consistency_runs r
           join system_prompt_versions p on p.id = r.system_prompt_version_id
          where r.competitor_revision_id = $1
            and r.status = 'COMPLETED'
            and r.summary is not null
            and r.completed_at is not null
          order by r.completed_at desc, r.id desc
          limit 1`,
        [currentRevision.id],
      )
      : Promise.resolve({ rows: [] as ConsistencyRow[], rowCount: 0 });

    const uniqueTournamentIds = [...new Set(entryResult.rows.map((entry) => entry.tournament_id))];
    const [leaderboards, consistencyResult, featuredMoments, statisticsReports] = await Promise.all([
      this.arena.leaderboard(),
      consistencyPromise,
      this.moments.listPublicForPlayers(revisionIds, 6),
      Promise.all(uniqueTournamentIds.map(async (tournamentId) => (
        [tournamentId, await this.arena.tournamentStatistics(tournamentId, false)] as const
      ))),
    ]);
    const reportByTournament = new Map(statisticsReports);

    const results = entryResult.rows.map((entry): PublicCompetitorResult => {
      const report = reportByTournament.get(entry.tournament_id);
      const player = report?.statistics.players.find((candidate) => (
        candidate.playerId === entry.competitor_revision_id
      ));
      if (!report || !player || player.finishingPosition === null) {
        throw new Error(
          `Completed tournament statistics are missing for competitor entry: ${entry.tournament_id}/${entry.competitor_revision_id}`,
        );
      }
      return {
        tournamentId: entry.tournament_id,
        name: entry.name,
        eventClass: entry.event_class,
        benchmarkCohortId: entry.benchmark_cohort_id,
        benchmarkTrackId: entry.benchmark_track_id,
        completedAt: entry.completed_at.toISOString(),
        competitorRevisionId: entry.competitor_revision_id,
        displayNameAtEntry: entry.display_name_at_entry,
        providerBrand: report.playerBrands[entry.competitor_revision_id] ?? null,
        fieldSize: report.statistics.players.length,
        finishingPosition: player.finishingPosition,
        handsPlayed: player.handsPlayed,
        netBigBlinds: player.netBigBlinds,
        peakStackBigBlinds: player.peakStackBigBlinds,
        knockouts: player.knockouts,
        validDecisionRate: player.validDecisionRate,
        firstPassRate: player.firstPassRate,
        totalTokens: player.totalTokens,
        tokenUsageCoverage: player.tokenUsageCoverage,
        countedInCurrentRanking: entry.event_class === "RATED"
          && entry.benchmark_cohort_id === leaderboards.benchmarkCohortId,
      };
    });

    const chronology = [...results].sort((left, right) => left.completedAt.localeCompare(right.completedAt));
    const firstPlayedAt = chronology[0]?.completedAt ?? null;
    const lastPlayedAt = chronology.at(-1)?.completedAt ?? null;
    const profile: PublicCompetitorProfile = {
      schemaVersion: "arena-competitor-profile-v1",
      competitor: {
        id: family.id,
        displayName: family.displayName,
        status: family.status,
        providerBrand: currentProviderBrand(currentRevision),
        currentRevision: currentRevision ? {
          id: currentRevision.id,
          revisionNumber: currentRevision.revision_number,
          modelId: currentRevision.model_id,
          displayNameAtRevision: currentRevision.competitor_display_name,
          createdAt: currentRevision.created_at.toISOString(),
        } : null,
        revisionCount: family.revisionCount,
        createdAt: family.createdAt,
        updatedAt: family.updatedAt,
      },
      competitiveScope: {
        eventClass: "RATED",
        benchmarkCohortId: leaderboards.benchmarkCohortId,
        rankedCompetitors: leaderboards.competition.length,
      },
      competition: competitionFor(leaderboards, competitorId),
      style: styleFor(leaderboards, competitorId),
      reliability: reliabilityFor(leaderboards, competitorId),
      efficiency: efficiencyFor(leaderboards, competitorId),
      consistency: consistencyFor(consistencyResult.rows[0]),
      career: {
        appearances: results.length,
        ratedAppearances: results.filter((result) => result.eventClass === "RATED").length,
        exhibitionAppearances: results.filter((result) => result.eventClass === "EXHIBITION").length,
        wins: results.filter((result) => result.finishingPosition === 1).length,
        podiums: results.filter((result) => result.finishingPosition <= 3).length,
        handsPlayed: results.reduce((total, result) => total + result.handsPlayed, 0),
        decisions: entryResult.rows.reduce((total, entry) => {
          const report = reportByTournament.get(entry.tournament_id);
          const player = report?.statistics.players.find((candidate) => (
            candidate.playerId === entry.competitor_revision_id
          ));
          return total + (player?.decisions ?? 0);
        }, 0),
        firstPlayedAt,
        lastPlayedAt,
      },
      recentResults: results.slice(0, 50),
      featuredMoments,
      methodology: {
        competition: "Rating, rank, playing style, reliability, and efficiency use only the latest comparable rated benchmark cohort.",
        career: "Career totals are historical facts from completed rated and exhibition tournaments; ratings are never merged across cohorts.",
        consistency: "Consistency is the latest completed run for the competitor's current revision; validity is reported alongside legal-action agreement.",
      },
    };
    return publicCompetitorProfileSchema.parse(profile);
  }
}
