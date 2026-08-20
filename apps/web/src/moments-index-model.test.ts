import { describe, expect, it } from "vitest";
import type { PublicMomentDto } from "../../../packages/contracts/src/moments";
import {
  mergeMomentIndexItems,
  momentBackLink,
  momentFilterScrollBehavior,
  momentIndexApiPath,
  momentIndexHref,
  nearestMomentFilterScrollLeft,
  parseMomentIndexTag,
  tournamentMomentSourceState,
  type PublicMomentIndexItem,
} from "./moments-index-model";

const TOURNAMENT_ID = "22222222-2222-4222-8222-222222222222";

function item(id: string): PublicMomentIndexItem {
  return {
    moment: { id } as PublicMomentDto,
    tournament: { id: TOURNAMENT_ID, name: "Arena Final" },
    players: [],
  };
}

describe("moments index model", () => {
  it("accepts only the public filter registry", () => {
    expect(parseMomentIndexTag("ALL_IN")).toBe("ALL_IN");
    expect(parseMomentIndexTag("MULTIWAY_ALL_IN")).toBeNull();
    expect(parseMomentIndexTag("all_in")).toBeNull();
    expect(parseMomentIndexTag(null)).toBeNull();
  });

  it("builds stable browser and API URLs while encoding opaque cursors", () => {
    expect(momentIndexHref(null)).toBe("/moments");
    expect(momentIndexHref("LEAD_CHANGE")).toBe("/moments?tag=LEAD_CHANGE");
    expect(momentIndexApiPath(null)).toBe("/api/public/moments?limit=12");
    expect(momentIndexApiPath("LARGE_POT", "page/2 + next", 6))
      .toBe("/api/public/moments?limit=6&cursor=page%2F2+%2B+next&tag=LARGE_POT");
  });

  it("appends pages without mutating inputs or repeating boundary records", () => {
    const current = [item("a"), item("b")];
    const incoming = [item("b"), item("c"), item("c"), item("d")];
    const merged = mergeMomentIndexItems(current, incoming);
    expect(merged.map((entry) => entry.moment.id)).toEqual(["a", "b", "c", "d"]);
    expect(current.map((entry) => entry.moment.id)).toEqual(["a", "b"]);
    expect(incoming.map((entry) => entry.moment.id)).toEqual(["b", "c", "c", "d"]);
  });

  it("scrolls the active filter by the nearest edge and clamps the result", () => {
    const port = { scrollLeft: 100, clientWidth: 320, scrollWidth: 760 };
    expect(nearestMomentFilterScrollLeft(port, { offsetLeft: 150, offsetWidth: 90 }))
      .toBe(100);
    expect(nearestMomentFilterScrollLeft(port, { offsetLeft: 56, offsetWidth: 72 }))
      .toBe(48);
    expect(nearestMomentFilterScrollLeft(port, { offsetLeft: 470, offsetWidth: 96 }))
      .toBe(254);
    expect(nearestMomentFilterScrollLeft(port, { offsetLeft: 730, offsetWidth: 90 }))
      .toBe(440);
  });

  it("removes smooth filter motion when the user requests reduced motion", () => {
    expect(momentFilterScrollBehavior(false)).toBe("smooth");
    expect(momentFilterScrollBehavior(true)).toBe("auto");
  });

  it("returns to a hand only for a matching trusted navigation state", () => {
    const moment = { tournamentId: TOURNAMENT_ID, handNo: 17 };
    expect(momentBackLink(tournamentMomentSourceState(TOURNAMENT_ID, 17), moment)).toEqual({
      to: `/tournaments/${TOURNAMENT_ID}/replay/17`,
      kind: "TOURNAMENT_HAND",
    });
    expect(momentBackLink(tournamentMomentSourceState(TOURNAMENT_ID, 18), moment))
      .toEqual({ to: "/moments", kind: "INDEX" });
    expect(momentBackLink({ momentSource: { tournamentId: "other", handNo: 17 } }, moment))
      .toEqual({ to: "/moments", kind: "INDEX" });
    expect(momentBackLink(null, moment)).toEqual({ to: "/moments", kind: "INDEX" });
  });
});
