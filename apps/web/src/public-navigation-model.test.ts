import { describe, expect, it } from "vitest";
import { publicNavigationSection } from "./public-navigation-model";

describe("public navigation model", () => {
  it("keeps event reports and details inside the Events navigation section", () => {
    expect(publicNavigationSection("/moments")).toBe("EVENTS");
    expect(publicNavigationSection("/moments/final-hand-h087")).toBe("EVENTS");
    expect(publicNavigationSection("/branches/river-hero-call-h087")).toBe("EVENTS");
    expect(publicNavigationSection("/tournaments/event-id/replay/87")).toBe("EVENTS");
  });

  it("matches only complete path segments", () => {
    expect(publicNavigationSection("/moments-old")).toBeNull();
    expect(publicNavigationSection("/branches-old")).toBeNull();
    expect(publicNavigationSection("/tournaments-legacy")).toBeNull();
  });

  it("retains the existing watch-room and ranking domains", () => {
    expect(publicNavigationSection("/")).toBe("WATCH_ROOM");
    expect(publicNavigationSection("/leaderboard")).toBe("RANKS");
    expect(publicNavigationSection("/players/competitor-id")).toBe("RANKS");
  });
});
