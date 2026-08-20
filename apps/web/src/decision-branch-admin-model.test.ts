import { describe, expect, it } from "vitest";
import type { DecisionBranchPublication } from "../../../packages/contracts/src/decision-branches";
import {
  decisionBranchEditorDraft,
  decisionBranchMutationBody,
  decisionBranchRevisionChanged,
  validateDecisionBranchDraft,
} from "./decision-branch-admin-model";

function publication(overrides: Partial<DecisionBranchPublication> = {}): DecisionBranchPublication {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    handForkId: "00000000-0000-4000-8000-000000000002",
    status: "DRAFT",
    slug: null,
    titleZh: null,
    titleEn: null,
    summaryZh: null,
    summaryEn: null,
    snapshotVersion: "arena-decision-branch-public-v1",
    snapshotHash: "a".repeat(64),
    snapshot: {} as DecisionBranchPublication["snapshot"],
    revision: 1,
    createdByAdminUserId: "00000000-0000-4000-8000-000000000003",
    publishedAt: null,
    createdAt: "2026-08-20T01:00:00.000Z",
    updatedAt: "2026-08-20T01:00:00.000Z",
    ...overrides,
  };
}

describe("decision branch admin model", () => {
  it("creates an editable draft without leaking nullable form values", () => {
    expect(decisionBranchEditorDraft(publication({ titleZh: "价值下注" }))).toEqual({
      slug: "",
      titleZh: "价值下注",
      titleEn: "",
      summaryZh: "",
      summaryEn: "",
    });
  });

  it("allows an empty draft save but enforces complete publication metadata", () => {
    const empty = decisionBranchEditorDraft(publication());
    expect(validateDecisionBranchDraft(empty, "SAVE")).toEqual([]);
    expect(validateDecisionBranchDraft(empty, "PUBLISH")).toEqual([
      "SLUG_REQUIRED",
      "TITLE_REQUIRED",
    ]);
  });

  it("keeps a published record valid when editorial changes are saved", () => {
    const empty = decisionBranchEditorDraft(publication());
    expect(validateDecisionBranchDraft(empty, "SAVE", "PUBLISHED")).toEqual(["TITLE_REQUIRED"]);
    expect(validateDecisionBranchDraft({ ...empty, titleEn: "River decision" }, "SAVE", "PUBLISHED")).toEqual([]);
    expect(validateDecisionBranchDraft(empty, "SAVE", "HIDDEN")).toEqual([]);
  });

  it("rejects malformed non-empty slugs for both save and publish", () => {
    const draft = { ...decisionBranchEditorDraft(publication()), slug: "Bad_slug", titleEn: "Title" };
    expect(validateDecisionBranchDraft(draft, "SAVE")).toEqual(["SLUG_INVALID"]);
    expect(validateDecisionBranchDraft(draft, "PUBLISH")).toEqual(["SLUG_INVALID"]);
  });

  it("normalizes form whitespace and empty values for the strict API", () => {
    const branch = publication({ revision: 4 });
    expect(decisionBranchMutationBody(branch, {
      slug: "  river-choice  ",
      titleZh: "  河牌抉择 ",
      titleEn: " ",
      summaryZh: "价值下注还是控池？",
      summaryEn: "",
    })).toEqual({
      expectedRevision: 4,
      slug: "river-choice",
      titleZh: "河牌抉择",
      titleEn: null,
      summaryZh: "价值下注还是控池？",
      summaryEn: null,
    });
  });

  it("detects only identity or publication revision changes", () => {
    const current = publication({ revision: 2 });
    expect(decisionBranchRevisionChanged(current, { ...current, updatedAt: "2026-08-20T02:00:00.000Z" })).toBe(false);
    expect(decisionBranchRevisionChanged(current, { ...current, revision: 3 })).toBe(true);
    expect(decisionBranchRevisionChanged(current, { ...current, id: "00000000-0000-4000-8000-000000000009" })).toBe(true);
  });
});
