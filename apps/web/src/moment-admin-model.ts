import type {
  AdminMomentRecord,
  MomentEditorialPatch,
  MomentSpoilerMode,
} from "../../../packages/contracts/src/moments";

export interface MomentEditorDraft {
  slug: string;
  titleZh: string;
  titleEn: string;
  summaryZh: string;
  summaryEn: string;
  coverSequence: string;
  playbackStartSequence: string;
  playbackEndSequence: string;
  spoilerMode: MomentSpoilerMode;
  isPrimary: boolean;
}

export type MomentMutationIntent = "SAVE" | "PUBLISH";

export type MomentDraftIssue =
  | "SLUG_REQUIRED"
  | "TITLE_REQUIRED"
  | "SEQUENCE_REQUIRED"
  | "SEQUENCE_INVALID"
  | "SEQUENCE_OUTSIDE_WINDOW"
  | "PLAYBACK_ORDER_INVALID";

export interface MomentMutationBody extends MomentEditorialPatch {
  expectedRevision: number | null;
}

export function momentPublicationRevision(record: AdminMomentRecord): number | null {
  return record.publication?.revision ?? null;
}

export function momentEditorDraft(record: AdminMomentRecord): MomentEditorDraft {
  const { facts, publication } = record;
  return {
    slug: publication?.slug ?? `hand-${facts.handNo}-${facts.id.replaceAll("-", "")}`,
    titleZh: publication?.titleZh ?? "",
    titleEn: publication?.titleEn ?? "",
    summaryZh: publication?.summaryZh ?? "",
    summaryEn: publication?.summaryEn ?? "",
    coverSequence: String(publication?.coverSequence ?? facts.focusSequence),
    playbackStartSequence: String(publication?.playbackStartSequence ?? facts.startSequence),
    playbackEndSequence: String(publication?.playbackEndSequence ?? facts.endSequence),
    spoilerMode: publication?.spoilerMode ?? "SUSPENSE",
    isPrimary: publication?.isPrimary ?? false,
  };
}

function nullableText(value: string): string | null {
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function sequenceValue(value: string): number | null {
  const normalized = value.trim();
  if (normalized.length === 0) return null;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function momentMutationBody(
  record: AdminMomentRecord,
  draft: MomentEditorDraft,
  intent: MomentMutationIntent,
): MomentMutationBody {
  return {
    expectedRevision: momentPublicationRevision(record),
    slug: nullableText(draft.slug),
    titleZh: nullableText(draft.titleZh),
    titleEn: nullableText(draft.titleEn),
    summaryZh: nullableText(draft.summaryZh),
    summaryEn: nullableText(draft.summaryEn),
    coverSequence: sequenceValue(draft.coverSequence),
    playbackStartSequence: sequenceValue(draft.playbackStartSequence),
    playbackEndSequence: sequenceValue(draft.playbackEndSequence),
    spoilerMode: draft.spoilerMode,
    ...(intent === "PUBLISH" || record.publication?.status === "PUBLISHED"
      ? { isPrimary: draft.isPrimary }
      : {}),
  };
}

export function validateMomentDraft(
  record: AdminMomentRecord,
  draft: MomentEditorDraft,
  intent: MomentMutationIntent,
): MomentDraftIssue[] {
  const issues = new Set<MomentDraftIssue>();
  const rawSequences = [
    draft.coverSequence,
    draft.playbackStartSequence,
    draft.playbackEndSequence,
  ];
  const sequences = rawSequences.map(sequenceValue);

  if (intent === "PUBLISH") {
    if (!nullableText(draft.slug)) issues.add("SLUG_REQUIRED");
    if (!nullableText(draft.titleZh) && !nullableText(draft.titleEn)) issues.add("TITLE_REQUIRED");
    if (rawSequences.some((value) => value.trim().length === 0)) issues.add("SEQUENCE_REQUIRED");
  }
  if (rawSequences.some((value, index) => value.trim().length > 0 && sequences[index] === null)) {
    issues.add("SEQUENCE_INVALID");
  }
  if (sequences.some((sequence) => sequence !== null
    && (sequence < record.facts.startSequence || sequence > record.facts.endSequence))) {
    issues.add("SEQUENCE_OUTSIDE_WINDOW");
  }
  const start = sequences[1] ?? null;
  const end = sequences[2] ?? null;
  if (start !== null && end !== null && start > end) issues.add("PLAYBACK_ORDER_INVALID");

  return [...issues];
}

export function canPublishMoment(record: AdminMomentRecord): boolean {
  return !(record.supersededAt !== null && record.publication?.publishedAt == null);
}

export function canHideMoment(record: AdminMomentRecord): boolean {
  return record.publication?.status === "PUBLISHED";
}

export function momentRevisionChanged(
  previous: AdminMomentRecord,
  latest: AdminMomentRecord,
): boolean {
  return momentPublicationRevision(previous) !== momentPublicationRevision(latest);
}
