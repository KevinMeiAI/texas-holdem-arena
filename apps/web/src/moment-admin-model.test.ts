import { describe, expect, it } from "vitest";
import {
  MOMENT_DETECTOR_VERSION,
  MOMENT_FACTS_VERSION,
  MOMENT_SCORING_VERSION,
  type AdminMomentRecord,
  type MomentPublication,
} from "../../../packages/contracts/src/moments";
import {
  canHideMoment,
  canPublishMoment,
  momentEditorDraft,
  momentMutationBody,
  momentRevisionChanged,
  validateMomentDraft,
} from "./moment-admin-model";

const MOMENT_ID = "00000000-0000-4000-8000-000000000021";
const TOURNAMENT_ID = "00000000-0000-4000-8000-000000000022";

function publication(overrides: Partial<MomentPublication> = {}): MomentPublication {
  return {
    momentId: MOMENT_ID,
    status: "DRAFT",
    slug: "saved-hand",
    titleZh: "一手好牌",
    titleEn: "A fine hand",
    summaryZh: null,
    summaryEn: null,
    coverSequence: 14,
    playbackStartSequence: 11,
    playbackEndSequence: 20,
    spoilerMode: "SUSPENSE",
    isPrimary: false,
    revision: 1,
    createdByAdminUserId: null,
    publishedAt: null,
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
    ...overrides,
  };
}

function record(options: {
  publication?: MomentPublication | null;
  supersededAt?: string | null;
} = {}): AdminMomentRecord {
  return {
    facts: {
      id: MOMENT_ID,
      tournamentId: TOURNAMENT_ID,
      handNo: 7,
      startSequence: 10,
      focusSequence: 14,
      endSequence: 20,
      factsVersion: MOMENT_FACTS_VERSION,
      detectorVersion: MOMENT_DETECTOR_VERSION,
      scoringVersion: MOMENT_SCORING_VERSION,
      broadcastViewVersion: "broadcast-test-v1",
      equityVersion: "equity-test-v1",
      source: {
        eventHash: "1".repeat(64),
        eventCount: 11,
        startEventHash: "2".repeat(64),
        endEventHash: "3".repeat(64),
      },
      score: 81,
      scoreBreakdown: {
        potImpact: 18,
        tournamentImpact: 25,
        actionDrama: 15,
        equityDrama: 16,
        rarity: 7,
      },
      recommendationRank: 1,
      primaryTag: "ALL_IN",
      tags: ["ALL_IN", "LARGE_POT"],
      participantPlayerIds: ["alpha", "beta"],
      featuredPlayerIds: ["alpha"],
      winnerPlayerIds: ["alpha"],
      eliminatedPlayerIds: ["beta"],
      showdownPlayerIds: ["alpha", "beta"],
      board: ["As", "Kh", "2d", "7c", "9s"],
      bigBlind: 100,
      potChips: 4_000,
      potBigBlinds: 40,
      totalChipShare: 0.4,
      startingStacks: { alpha: 2_000, beta: 2_000 },
      endingStacks: { alpha: 4_000, beta: 0 },
      netChanges: { alpha: 2_000, beta: -2_000 },
      actionCount: 3,
      preflopRaiseCount: 2,
      overbetSequences: [],
      sidePotCount: 0,
      splitPot: false,
      leadChange: true,
      maxDecisionLatencyMs: 1_200,
      winningHandCategories: [],
      actions: [],
      allInLock: null,
      equityTransitions: [],
    },
    publication: options.publication === undefined ? null : options.publication,
    supersededAt: options.supersededAt ?? null,
  };
}

describe("moment admin editor model", () => {
  it("starts a new candidate from its authoritative event window", () => {
    const draft = momentEditorDraft(record());

    expect(draft.slug).toBe("hand-7-00000000000040008000000000000021");
    expect(draft.coverSequence).toBe("14");
    expect(draft.playbackStartSequence).toBe("10");
    expect(draft.playbackEndSequence).toBe("20");
    expect(draft.spoilerMode).toBe("SUSPENSE");
  });

  it("sends null revision on the first save and preserves clear-vs-omitted semantics", () => {
    const candidate = record();
    const draft = {
      ...momentEditorDraft(candidate),
      titleZh: "  新标题  ",
      titleEn: "   ",
      summaryZh: "",
      isPrimary: true,
    };

    const body = momentMutationBody(candidate, draft, "SAVE");

    expect(body).toMatchObject({
      expectedRevision: null,
      titleZh: "新标题",
      titleEn: null,
      summaryZh: null,
      coverSequence: 14,
    });
    expect(body).not.toHaveProperty("isPrimary");
  });

  it("uses the current revision and includes primary selection for published edits", () => {
    const published = record({
      publication: publication({ status: "PUBLISHED", revision: 4, publishedAt: "2026-08-20T01:00:00.000Z" }),
    });
    const draft = { ...momentEditorDraft(published), isPrimary: true };

    expect(momentMutationBody(published, draft, "SAVE")).toMatchObject({
      expectedRevision: 4,
      isPrimary: true,
    });
  });

  it("requires publish metadata and validates the authoritative sequence window", () => {
    const candidate = record();
    const draft = {
      ...momentEditorDraft(candidate),
      slug: "",
      titleZh: "",
      titleEn: "",
      coverSequence: "21",
      playbackStartSequence: "18",
      playbackEndSequence: "12",
    };

    expect(validateMomentDraft(candidate, draft, "PUBLISH")).toEqual(expect.arrayContaining([
      "SLUG_REQUIRED",
      "TITLE_REQUIRED",
      "SEQUENCE_OUTSIDE_WINDOW",
      "PLAYBACK_ORDER_INVALID",
    ]));
  });

  it("keeps partial sequence fields legal in a draft but rejects malformed values", () => {
    const candidate = record();
    const cleared = { ...momentEditorDraft(candidate), coverSequence: "" };
    const malformed = { ...cleared, playbackStartSequence: "1.5" };

    expect(validateMomentDraft(candidate, cleared, "SAVE")).toEqual([]);
    expect(validateMomentDraft(candidate, malformed, "SAVE")).toContain("SEQUENCE_INVALID");
    expect(momentMutationBody(candidate, cleared, "SAVE").coverSequence).toBeNull();
  });

  it("allows a superseded historical publication to return but blocks first publication", () => {
    const supersededCandidate = record({ supersededAt: "2026-08-20T02:00:00.000Z" });
    const supersededHidden = record({
      supersededAt: "2026-08-20T02:00:00.000Z",
      publication: publication({ status: "HIDDEN", publishedAt: "2026-08-20T01:00:00.000Z" }),
    });

    expect(canPublishMoment(supersededCandidate)).toBe(false);
    expect(canPublishMoment(supersededHidden)).toBe(true);
    expect(canHideMoment(supersededHidden)).toBe(false);
    expect(canHideMoment(record({ publication: publication({ status: "PUBLISHED" }) }))).toBe(true);
  });

  it("detects a changed publication revision before any retry", () => {
    const previous = record({ publication: publication({ revision: 2 }) });
    const same = record({ publication: publication({ revision: 2, titleEn: "Server edit" }) });
    const latest = record({ publication: publication({ revision: 3 }) });

    expect(momentRevisionChanged(previous, same)).toBe(false);
    expect(momentRevisionChanged(previous, latest)).toBe(true);
  });
});
