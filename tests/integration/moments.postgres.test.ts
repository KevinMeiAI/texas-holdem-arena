import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import {
  tournamentMomentFactsSchema,
  type TournamentMomentFacts,
} from "../../packages/contracts/src/moments.js";
import { runMigrations } from "../../db/migrate.js";
import {
  type MomentAuditAction,
  type MomentAuditEvent,
  MomentSupersededPublicationError,
  PgMomentRepository,
} from "../../apps/api/src/tournament/moments/moment-repository.js";
import { MomentService } from "../../apps/api/src/tournament/moments/moment-service.js";
import {
  createIsolatedPostgresSchema,
  type IsolatedPostgresSchema,
} from "./postgres-test-schema.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;
const TOURNAMENT_ID = "00000000-0000-4000-8000-000000000101";
const ADMIN_ID = "00000000-0000-4000-8000-000000000102";
const MOMENT_ONE = "00000000-0000-5000-8000-000000000111";
const MOMENT_TWO = "00000000-0000-5000-8000-000000000112";
const MOMENT_THREE = "00000000-0000-5000-8000-000000000113";
const MOMENT_FOUR = "00000000-0000-5000-8000-000000000114";
const MOMENT_FIVE = "00000000-0000-5000-8000-000000000115";
const MOMENT_SIX = "00000000-0000-5000-8000-000000000116";
const MOMENT_SEVEN = "00000000-0000-5000-8000-000000000117";
const UNKNOWN_ADMIN_ID = "00000000-0000-4000-8000-000000000199";

let testSchema: IsolatedPostgresSchema | null = null;
let pool: Pool | null = null;

function facts(id: string, handNo: number, score: number): TournamentMomentFacts {
  const hashDigit = String((handNo % 8) + 1);
  const startSequence = handNo * 10;
  return tournamentMomentFactsSchema.parse({
    id,
    tournamentId: TOURNAMENT_ID,
    handNo,
    startSequence,
    focusSequence: startSequence + 3,
    endSequence: startSequence + 9,
    factsVersion: "arena-moment-facts-v1",
    detectorVersion: "arena-moment-detector-v1",
    scoringVersion: "arena-moment-scoring-v1",
    broadcastViewVersion: "arena-broadcast-view-v1",
    equityVersion: "arena-broadcast-equity-v1",
    source: {
      eventHash: hashDigit.repeat(64),
      eventCount: 10,
      startEventHash: "a".repeat(64),
      endEventHash: "b".repeat(64),
    },
    score,
    scoreBreakdown: { potImpact: 20, tournamentImpact: 20, actionDrama: 10, equityDrama: 10, rarity: score - 60 },
    recommendationRank: handNo,
    primaryTag: "LARGE_POT",
    tags: ["LARGE_POT"],
    participantPlayerIds: ["a", "b"],
    featuredPlayerIds: ["a"],
    winnerPlayerIds: ["a"],
    eliminatedPlayerIds: [],
    showdownPlayerIds: ["a", "b"],
    board: ["2c", "3d", "4h", "8s", "Tc"],
    bigBlind: 10,
    potChips: 200,
    potBigBlinds: 20,
    totalChipShare: 0.5,
    startingStacks: { a: 200, b: 200 },
    endingStacks: { a: 300, b: 100 },
    netChanges: { a: 100, b: -100 },
    actionCount: 2,
    preflopRaiseCount: 1,
    overbetSequences: [],
    sidePotCount: 0,
    splitPot: false,
    leadChange: false,
    maxDecisionLatencyMs: null,
    winningHandCategories: [],
    actions: [],
    allInLock: null,
    equityTransitions: [],
  });
}

function audit(
  action: MomentAuditAction,
  targetType: MomentAuditEvent["targetType"],
  targetId: string,
  metadata: Record<string, unknown> = {},
  adminUserId = ADMIN_ID,
): MomentAuditEvent {
  return { adminUserId, action, targetType, targetId, metadata };
}

async function waitForBlockedTournamentLock(): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const blocked = await pool!.query<{ blocked: boolean }>(
      `select exists (
         select 1
           from pg_stat_activity
          where datname = current_database()
            and pid <> pg_backend_pid()
            and wait_event_type = 'Lock'
            and query like '%for update of t%'
       ) as blocked`,
    );
    if (blocked.rows[0]?.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for the publication transaction to block");
}

describePostgres("tournament moment persistence", () => {
  beforeAll(async () => {
    testSchema = await createIsolatedPostgresSchema(databaseUrl!, "moments", 3);
    pool = testSchema.pool;
    await runMigrations(pool!);
    await pool!.query(
      "insert into admin_users (id, email, password_hash) values ($1, 'moments@test.local', 'test')",
      [ADMIN_ID],
    );
    await pool!.query(
      `insert into tournaments
         (id, name, status, ruleset_version, protocol_bundle_id,
          benchmark_track_id, benchmark_cohort_id, public_state)
       values ($1, 'Moment fixture', 'COMPLETED', 'arena-rules-v2', 'arena-native-v11',
               'track', 'cohort', $2::jsonb)`,
      [TOURNAMENT_ID, JSON.stringify({ tournamentId: TOURNAMENT_ID, status: "COMPLETED" })],
    );
  });

  afterAll(async () => {
    await testSchema?.dispose();
  });

  it("keeps editorial publications while superseding stale candidates and enforcing one primary", async () => {
    const repository = new PgMomentRepository(pool!);
    const service = new MomentService(repository);
    const one = facts(MOMENT_ONE, 1, 64);
    const two = facts(MOMENT_TWO, 2, 65);
    const three = facts(MOMENT_THREE, 3, 66);
    const identityConstraint = await pool!.query<{ definition: string }>(
      `select pg_get_constraintdef(oid) as definition
         from pg_constraint
        where conrelid = 'tournament_moments'::regclass
          and conname = 'tournament_moments_versioned_source_unique'`,
    );
    expect(identityConstraint.rows[0]?.definition).toContain("scoring_version");
    expect(identityConstraint.rows[0]?.definition).toContain("equity_version");
    await repository.upsertDetectedMoments(
      TOURNAMENT_ID,
      [one, two, three],
      audit("tournament_moments.generate", "tournament", TOURNAMENT_ID),
    );

    await service.publish(MOMENT_ONE, {
      slug: "first-highlight",
      titleEn: "First highlight",
      isPrimary: true,
    }, null, ADMIN_ID);
    await service.publish(MOMENT_TWO, {
      slug: "second-highlight",
      titleEn: "Second highlight",
      isPrimary: true,
    }, null, ADMIN_ID);

    await pool!.query(
      `update tournament_moments
          set detector_version = 'arena-moment-detector-v0',
              scoring_version = 'arena-moment-scoring-v0',
              facts = jsonb_set(
                jsonb_set(facts, '{detectorVersion}', '"arena-moment-detector-v0"'::jsonb),
                '{scoringVersion}', '"arena-moment-scoring-v0"'::jsonb
              )
        where id = $1`,
      [MOMENT_ONE],
    );
    expect(await service.getPublicBySlug("first-highlight")).toMatchObject({
      facts: {
        detectorVersion: "arena-moment-detector-v0",
        scoringVersion: "arena-moment-scoring-v0",
      },
    });

    const afterPrimarySwitch = await service.listAdmin(TOURNAMENT_ID);
    expect(afterPrimarySwitch.find((record) => record.facts.id === MOMENT_ONE)?.publication).toMatchObject({
      isPrimary: false,
      revision: 2,
    });
    expect(afterPrimarySwitch.find((record) => record.facts.id === MOMENT_TWO)?.publication?.isPrimary).toBe(true);
    await expect(service.editPublication(MOMENT_ONE, {
      slug: "renamed-first-highlight",
    }, 2, ADMIN_ID)).rejects.toMatchObject({
      code: "CONFLICT",
      message: "A published moment slug is immutable",
    });
    expect(await service.getPublicBySlug("first-highlight")).toMatchObject({
      slug: "first-highlight",
      publicationRevision: 2,
    });
    expect(await service.getPublicBySlug("renamed-first-highlight")).toBeNull();
    const primaryAudit = await pool!.query<{ metadata: Record<string, unknown> }>(
      `select metadata
         from audit_events
        where action = 'moment_publication.publish' and target_id = $1
        order by created_at desc
        limit 1`,
      [MOMENT_TWO],
    );
    expect(primaryAudit.rows[0]?.metadata).toMatchObject({
      publicationRevision: 1,
      displacedPrimaryMomentIds: [MOMENT_ONE],
    });
    const concurrentEdits = await Promise.allSettled([
      service.editPublication(MOMENT_ONE, { summaryEn: "Edit A" }, 2, ADMIN_ID),
      service.editPublication(MOMENT_ONE, { summaryZh: "编辑 B" }, 2, ADMIN_ID),
    ]);
    expect(concurrentEdits.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(concurrentEdits.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(concurrentEdits.find((result) => result.status === "rejected")).toMatchObject({
      reason: { code: "CONFLICT" },
    });
    await expect(service.publish(MOMENT_THREE, {
      slug: "second-highlight",
      titleEn: "Conflicting URL",
    }, null, ADMIN_ID)).rejects.toMatchObject({ code: "23505", constraint: "moment_publications_slug" });

    const revisedTwo = tournamentMomentFactsSchema.parse({ ...two, score: 67 });
    await repository.upsertDetectedMoments(
      TOURNAMENT_ID,
      [revisedTwo],
      audit("tournament_moments.generate", "tournament", TOURNAMENT_ID),
    );
    const afterRebuild = await service.listAdmin(TOURNAMENT_ID);
    expect(afterRebuild.map((record) => record.facts.id)).toEqual([MOMENT_TWO, MOMENT_ONE]);
    expect(afterRebuild.find((record) => record.facts.id === MOMENT_ONE)?.supersededAt).not.toBeNull();
    expect(afterRebuild.find((record) => record.facts.id === MOMENT_THREE)).toBeUndefined();
    expect(afterRebuild.find((record) => record.facts.id === MOMENT_TWO)).toMatchObject({
      // Once published, automatic facts are immutable even if buggy code
      // reuses a version without bumping its identity material.
      facts: { score: 65 },
      publication: { slug: "second-highlight", isPrimary: true },
      supersededAt: null,
    });
    await expect(repository.upsertPublication({
      momentId: MOMENT_THREE,
      status: "PUBLISHED",
      slug: "superseded-first-publish",
      titleZh: null,
      titleEn: "Superseded first publish",
      summaryZh: null,
      summaryEn: null,
      coverSequence: three.focusSequence,
      playbackStartSequence: three.startSequence,
      playbackEndSequence: three.endSequence,
      spoilerMode: "SUSPENSE",
      isPrimary: false,
      createdByAdminUserId: ADMIN_ID,
    }, null, audit(
      "moment_publication.publish",
      "tournament_moment",
      MOMENT_THREE,
    ))).rejects.toBeInstanceOf(MomentSupersededPublicationError);

    const publicMoments = await service.listPublic(TOURNAMENT_ID);
    expect(publicMoments.map((moment) => moment.slug).sort()).toEqual(["first-highlight", "second-highlight"]);

    await pool!.query(
      "update moment_publications set playback_end_sequence = $2 where moment_id = $1",
      [MOMENT_TWO, revisedTwo.endSequence + 1],
    );
    expect(await service.getPublicBySlug("second-highlight")).toBeNull();
  });

  it("rechecks superseded state after waiting for a concurrent rebuild lock", async () => {
    const repository = new PgMomentRepository(pool!);
    const candidate = facts(MOMENT_FOUR, 4, 63);
    await repository.upsertDetectedMoments(
      TOURNAMENT_ID,
      [candidate],
      audit("tournament_moments.generate", "tournament", TOURNAMENT_ID),
    );

    const blocker = await pool!.connect();
    let blockerCommitted = false;
    try {
      await blocker.query("begin");
      await blocker.query("select id from tournaments where id = $1 for update", [TOURNAMENT_ID]);

      const publication = repository.upsertPublication({
        momentId: MOMENT_FOUR,
        status: "PUBLISHED",
        slug: "blocked-superseded-publish",
        titleZh: null,
        titleEn: "Blocked superseded publish",
        summaryZh: null,
        summaryEn: null,
        coverSequence: candidate.focusSequence,
        playbackStartSequence: candidate.startSequence,
        playbackEndSequence: candidate.endSequence,
        spoilerMode: "SUSPENSE",
        isPrimary: false,
        createdByAdminUserId: ADMIN_ID,
      }, null, audit(
        "moment_publication.publish",
        "tournament_moment",
        MOMENT_FOUR,
      )).then(
        () => ({ error: null as unknown }),
        (error: unknown) => ({ error }),
      );

      await waitForBlockedTournamentLock();
      await blocker.query(
        "update tournament_moments set superseded_at = now() where id = $1",
        [MOMENT_FOUR],
      );
      await blocker.query("commit");
      blockerCommitted = true;

      expect((await publication).error).toBeInstanceOf(MomentSupersededPublicationError);
      const persisted = await pool!.query(
        "select 1 from moment_publications where moment_id = $1",
        [MOMENT_FOUR],
      );
      expect(persisted.rowCount).toBe(0);
    } finally {
      if (!blockerCommitted) await blocker.query("rollback");
      blocker.release();
    }
  });

  it("rolls back a publication when its atomic audit insert fails", async () => {
    const repository = new PgMomentRepository(pool!);
    const candidate = facts(MOMENT_FIVE, 5, 62);
    await repository.upsertDetectedMoments(
      TOURNAMENT_ID,
      [candidate],
      audit("tournament_moments.generate", "tournament", TOURNAMENT_ID),
    );

    await expect(repository.upsertPublication({
      momentId: MOMENT_FIVE,
      status: "PUBLISHED",
      slug: "audit-must-be-atomic",
      titleZh: null,
      titleEn: "Audit must be atomic",
      summaryZh: null,
      summaryEn: null,
      coverSequence: candidate.focusSequence,
      playbackStartSequence: candidate.startSequence,
      playbackEndSequence: candidate.endSequence,
      spoilerMode: "SUSPENSE",
      isPrimary: false,
      createdByAdminUserId: ADMIN_ID,
    }, null, audit(
      "moment_publication.publish",
      "tournament_moment",
      MOMENT_FIVE,
      {},
      UNKNOWN_ADMIN_ID,
    ))).rejects.toMatchObject({ code: "23503" });

    const persisted = await pool!.query(
      "select 1 from moment_publications where moment_id = $1",
      [MOMENT_FIVE],
    );
    expect(persisted.rowCount).toBe(0);
  });

  it("audits the displaced primary when an existing publication becomes primary through editing", async () => {
    const repository = new PgMomentRepository(pool!);
    const service = new MomentService(repository);
    const primary = facts(MOMENT_SIX, 6, 61);
    const challenger = facts(MOMENT_SEVEN, 7, 60);
    await repository.upsertDetectedMoments(
      TOURNAMENT_ID,
      [primary, challenger],
      audit("tournament_moments.generate", "tournament", TOURNAMENT_ID),
    );

    await service.publish(MOMENT_SIX, {
      slug: "edit-primary-first",
      titleEn: "First primary",
      isPrimary: true,
    }, null, ADMIN_ID);
    await service.publish(MOMENT_SEVEN, {
      slug: "edit-primary-second",
      titleEn: "Second publication",
    }, null, ADMIN_ID);

    const switched = await service.editPublication(
      MOMENT_SEVEN,
      { isPrimary: true },
      1,
      ADMIN_ID,
    );
    expect(switched.publication).toMatchObject({ isPrimary: true, revision: 2 });
    expect((await service.getAdmin(MOMENT_SIX))?.publication).toMatchObject({
      isPrimary: false,
      revision: 2,
    });

    const updateAudit = await pool!.query<{
      action: string;
      metadata: Record<string, unknown>;
    }>(
      `select action, metadata
         from audit_events
        where action = 'moment_publication.update' and target_id = $1
        order by created_at desc
        limit 1`,
      [MOMENT_SEVEN],
    );
    expect(updateAudit.rows[0]).toMatchObject({
      action: "moment_publication.update",
      metadata: {
        publicationRevision: 2,
        displacedPrimaryMomentIds: [MOMENT_SIX],
      },
    });
  });
});
