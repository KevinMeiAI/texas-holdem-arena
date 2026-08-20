import type {
  DecisionBranchPublication,
  DecisionBranchPublicationStatus,
} from "../../../packages/contracts/src/decision-branches";

export interface DecisionBranchEditorDraft {
  slug: string;
  titleZh: string;
  titleEn: string;
  summaryZh: string;
  summaryEn: string;
}

export type DecisionBranchMutationIntent = "SAVE" | "PUBLISH";
export type DecisionBranchDraftIssue = "SLUG_REQUIRED" | "SLUG_INVALID" | "TITLE_REQUIRED";

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function decisionBranchEditorDraft(
  publication: DecisionBranchPublication,
): DecisionBranchEditorDraft {
  return {
    slug: publication.slug ?? "",
    titleZh: publication.titleZh ?? "",
    titleEn: publication.titleEn ?? "",
    summaryZh: publication.summaryZh ?? "",
    summaryEn: publication.summaryEn ?? "",
  };
}

function optionalText(value: string): string | null {
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

export function validateDecisionBranchDraft(
  draft: DecisionBranchEditorDraft,
  intent: DecisionBranchMutationIntent,
  status: DecisionBranchPublicationStatus = "DRAFT",
): DecisionBranchDraftIssue[] {
  const issues: DecisionBranchDraftIssue[] = [];
  const slug = draft.slug.trim();
  if (slug.length > 0 && !SLUG_PATTERN.test(slug)) issues.push("SLUG_INVALID");
  if (intent === "PUBLISH") {
    if (slug.length === 0) issues.push("SLUG_REQUIRED");
  }
  if ((intent === "PUBLISH" || status === "PUBLISHED")
    && draft.titleZh.trim().length === 0
    && draft.titleEn.trim().length === 0) {
    issues.push("TITLE_REQUIRED");
  }
  return issues;
}

export function decisionBranchMutationBody(
  publication: DecisionBranchPublication,
  draft: DecisionBranchEditorDraft,
) {
  return {
    expectedRevision: publication.revision,
    slug: optionalText(draft.slug.toLowerCase()),
    titleZh: optionalText(draft.titleZh),
    titleEn: optionalText(draft.titleEn),
    summaryZh: optionalText(draft.summaryZh),
    summaryEn: optionalText(draft.summaryEn),
  };
}

export function decisionBranchRevisionChanged(
  previous: DecisionBranchPublication,
  next: DecisionBranchPublication,
): boolean {
  return previous.id !== next.id || previous.revision !== next.revision;
}
