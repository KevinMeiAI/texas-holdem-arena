export type LeaderboardSortDirection = "asc" | "desc";
export type LeaderboardSortValue = number | string | null;

export function sortLeaderboardEntries<T>(
  entries: readonly T[],
  valueFor: (entry: T) => LeaderboardSortValue,
  direction: LeaderboardSortDirection,
): T[] {
  return entries
    .map((entry, index) => ({ entry, index, value: valueFor(entry) }))
    .sort((left, right) => {
      if (left.value === null && right.value === null) return left.index - right.index;
      if (left.value === null) return 1;
      if (right.value === null) return -1;
      const comparison = typeof left.value === "string" && typeof right.value === "string"
        ? left.value.localeCompare(right.value)
        : Number(left.value) - Number(right.value);
      return (direction === "asc" ? comparison : -comparison) || left.index - right.index;
    })
    .map(({ entry }) => entry);
}
