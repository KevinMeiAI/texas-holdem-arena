import type {
  MomentTag,
  PublicMomentDto,
  PublicMomentIndexItem,
} from "../../../packages/contracts/src/moments";

export type {
  PublicMomentIndexItem,
  PublicMomentIndexResponse,
} from "../../../packages/contracts/src/moments";

export const MOMENT_INDEX_TAGS = [
  "ALL_IN",
  "ELIMINATION",
  "LEAD_CHANGE",
  "FINAL_HAND",
  "LARGE_POT",
] as const satisfies readonly MomentTag[];

export type MomentIndexTag = (typeof MOMENT_INDEX_TAGS)[number];

export interface TournamentMomentSourceState {
  momentSource: {
    tournamentId: string;
    handNo: number;
  };
}

export interface MomentBackLink {
  to: string;
  kind: "INDEX" | "TOURNAMENT_HAND";
}

export interface HorizontalScrollPort {
  scrollLeft: number;
  clientWidth: number;
  scrollWidth: number;
}

export interface HorizontalScrollItem {
  offsetLeft: number;
  offsetWidth: number;
}

export function parseMomentIndexTag(value: string | null): MomentIndexTag | null {
  return MOMENT_INDEX_TAGS.find((tag) => tag === value) ?? null;
}

export function momentIndexHref(tag: MomentIndexTag | null): string {
  if (tag === null) return "/moments";
  const search = new URLSearchParams({ tag });
  return `/moments?${search.toString()}`;
}

export function momentIndexApiPath(
  tag: MomentIndexTag | null,
  cursor: string | null = null,
  limit = 12,
): string {
  const search = new URLSearchParams({ limit: String(limit) });
  if (cursor) search.set("cursor", cursor);
  if (tag) search.set("tag", tag);
  return `/api/public/moments?${search.toString()}`;
}

export function mergeMomentIndexItems(
  current: readonly PublicMomentIndexItem[],
  incoming: readonly PublicMomentIndexItem[],
): PublicMomentIndexItem[] {
  const known = new Set(current.map((item) => item.moment.id));
  return [
    ...current,
    ...incoming.filter((item) => {
      if (known.has(item.moment.id)) return false;
      known.add(item.moment.id);
      return true;
    }),
  ];
}

export function nearestMomentFilterScrollLeft(
  port: HorizontalScrollPort,
  item: HorizontalScrollItem,
  edgePadding = 8,
): number {
  const maxScrollLeft = Math.max(0, port.scrollWidth - port.clientWidth);
  const padding = Math.max(0, Math.min(edgePadding, port.clientWidth / 2));
  const itemStart = item.offsetLeft;
  const itemEnd = item.offsetLeft + item.offsetWidth;
  const visibleStart = port.scrollLeft + padding;
  const visibleEnd = port.scrollLeft + port.clientWidth - padding;
  let target = port.scrollLeft;
  if (itemStart < visibleStart) target = itemStart - padding;
  else if (itemEnd > visibleEnd) target = itemEnd - port.clientWidth + padding;
  return Math.min(maxScrollLeft, Math.max(0, target));
}

export function momentFilterScrollBehavior(reducedMotion: boolean): ScrollBehavior {
  return reducedMotion ? "auto" : "smooth";
}

export function tournamentMomentSourceState(
  tournamentId: string,
  handNo: number,
): TournamentMomentSourceState {
  return { momentSource: { tournamentId, handNo } };
}

export function momentBackLink(
  locationState: unknown,
  moment: Pick<PublicMomentDto, "tournamentId" | "handNo">,
): MomentBackLink {
  if (locationState && typeof locationState === "object" && "momentSource" in locationState) {
    const source = (locationState as { momentSource?: unknown }).momentSource;
    if (source && typeof source === "object") {
      const tournamentId = "tournamentId" in source ? source.tournamentId : null;
      const handNo = "handNo" in source ? source.handNo : null;
      if (tournamentId === moment.tournamentId && handNo === moment.handNo) {
        return {
          to: `/tournaments/${encodeURIComponent(moment.tournamentId)}/replay/${moment.handNo}`,
          kind: "TOURNAMENT_HAND",
        };
      }
    }
  }
  return { to: "/moments", kind: "INDEX" };
}
