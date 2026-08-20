export type PublicNavigationSection = "WATCH_ROOM" | "EVENTS" | "RANKS" | null;

function pathIsWithin(pathname: string, root: string): boolean {
  return pathname === root || pathname.startsWith(`${root}/`);
}

export function publicNavigationSection(pathname: string): PublicNavigationSection {
  if (pathname === "/") return "WATCH_ROOM";
  if (pathIsWithin(pathname, "/tournaments") || pathIsWithin(pathname, "/moments")) {
    return "EVENTS";
  }
  if (pathIsWithin(pathname, "/leaderboard") || pathIsWithin(pathname, "/players")) {
    return "RANKS";
  }
  return null;
}
