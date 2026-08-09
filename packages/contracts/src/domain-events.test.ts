import { describe, expect, it } from "vitest";
import { parseCard } from "../../domain/src/cards.js";
import { handEventToArenaEvent } from "./domain-events.js";
import { newArenaEventSchema } from "./events.js";

describe("domain event persistence mapping", () => {
  it("keeps hole cards out of the public payload", () => {
    const mapped = handEventToArenaEvent(7, {
      type: "HOLE_CARDS_DEALT",
      playerId: "p2",
      cards: [parseCard("As"), parseCard("Ah")],
    });
    expect(newArenaEventSchema.parse(mapped)).toEqual(mapped);
    expect(JSON.stringify(mapped.publicPayload)).not.toContain("As");
    expect(mapped).toMatchObject({
      handNo: 7,
      privateVisibility: "PLAYER_HOLE_CARDS",
      privateOwnerId: "p2",
    });
    expect(JSON.stringify(mapped.privatePayload)).toContain('"rank":14');
  });

  it("keeps burn cards private while publishing community cards", () => {
    const mapped = handEventToArenaEvent(3, {
      type: "STREET_DEALT",
      boardIndex: 0,
      street: "FLOP",
      burn: parseCard("2c"),
      cards: [parseCard("As"), parseCard("Kh"), parseCard("Qd")],
    });
    expect(newArenaEventSchema.parse(mapped)).toEqual(mapped);
    expect(mapped.publicPayload).toEqual({
      boardIndex: 0,
      street: "FLOP",
      cards: [parseCard("As"), parseCard("Kh"), parseCard("Qd")],
    });
    expect(mapped.privatePayload).toEqual({ burn: parseCard("2c") });
    expect(mapped.privateVisibility).toBe("ADMIN_AUDIT");
  });
});
