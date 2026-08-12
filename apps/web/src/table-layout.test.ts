import { describe, expect, it } from "vitest";
import { tableSeatLayout, tableSeatPoints } from "./table-layout";

describe("poker table perimeter layout", () => {
  it("defines one stable clockwise placement for every player from two to nine", () => {
    for (let playerCount = 2; playerCount <= 9; playerCount += 1) {
      const points = tableSeatPoints(playerCount);
      const compactPoints = tableSeatPoints(playerCount, "compact");
      expect(points).toHaveLength(playerCount);
      expect(compactPoints).toHaveLength(playerCount);
      expect(new Set(points.map((point) => `${point.x},${point.y}`)).size).toBe(playerCount);
      expect(new Set(compactPoints.map((point) => `${point.x},${point.y}`)).size).toBe(playerCount);
      expect(tableSeatLayout(playerCount, playerCount).wide).toEqual(points[0]);
      expect(tableSeatLayout(playerCount, playerCount).compact).toEqual(compactPoints[0]);
    }
  });

  it("keeps every wide seat card outside the board and pot safety zone", () => {
    // Normalized against the 1.65:1 desktop felt. The widest cards occupy about
    // 21% of the table width and 16% of its height.
    const safeZone = { left: 27, right: 73, top: 31, bottom: 72 };
    const halfSeat = { width: 10.5, height: 8 };
    for (let playerCount = 2; playerCount <= 9; playerCount += 1) {
      for (const point of tableSeatPoints(playerCount)) {
        const overlapsHorizontally = point.x + halfSeat.width > safeZone.left
          && point.x - halfSeat.width < safeZone.right;
        const overlapsVertically = point.y + halfSeat.height > safeZone.top
          && point.y - halfSeat.height < safeZone.bottom;
        expect(overlapsHorizontally && overlapsVertically, `${playerCount} players: ${point.x},${point.y}`).toBe(false);
      }
    }
  });

  it("places each bet between its seat and the center of the felt", () => {
    for (let playerCount = 2; playerCount <= 9; playerCount += 1) {
      for (let index = 0; index < playerCount; index += 1) {
        const placement = tableSeatLayout(playerCount, index);
        const seatDistance = Math.hypot(placement.wide.x - 50, placement.wide.y - 50);
        const shiftedDistance = Math.hypot(
          placement.wide.x + placement.wideBetShift.x - 50,
          placement.wide.y + placement.wideBetShift.y - 50,
        );
        expect(shiftedDistance).toBeLessThan(seatDistance);
      }
    }
  });
});
