export interface TableSeatPoint {
  x: number;
  y: number;
}

export interface TableSeatPlacement {
  compact: TableSeatPoint;
  wide: TableSeatPoint;
  compactBetShift: TableSeatPoint;
  wideBetShift: TableSeatPoint;
}

const wideLayouts: Record<number, TableSeatPoint[]> = {
  2: [
    { x: 50, y: 2 }, { x: 50, y: 98 },
  ],
  3: [
    { x: 50, y: 2 }, { x: 78, y: 90 }, { x: 22, y: 90 },
  ],
  4: [
    { x: 50, y: 2 }, { x: 94, y: 50 }, { x: 50, y: 98 }, { x: 6, y: 50 },
  ],
  5: [
    { x: 50, y: 2 }, { x: 92, y: 34 }, { x: 78, y: 90 }, { x: 22, y: 90 }, { x: 8, y: 34 },
  ],
  6: [
    { x: 50, y: 2 }, { x: 91, y: 29 }, { x: 91, y: 71 }, { x: 50, y: 98 }, { x: 9, y: 71 }, { x: 9, y: 29 },
  ],
  7: [
    { x: 50, y: 2 }, { x: 90, y: 28 }, { x: 92, y: 70 }, { x: 70, y: 92 }, { x: 30, y: 92 }, { x: 8, y: 70 }, { x: 10, y: 28 },
  ],
  8: [
    { x: 25, y: 9 }, { x: 75, y: 9 }, { x: 94, y: 35 }, { x: 94, y: 67 }, { x: 75, y: 91 }, { x: 25, y: 91 }, { x: 6, y: 67 }, { x: 6, y: 35 },
  ],
  9: [
    { x: 50, y: 1 }, { x: 76, y: 10 }, { x: 94, y: 35 }, { x: 94, y: 67 }, { x: 75, y: 91 }, { x: 50, y: 99 }, { x: 25, y: 91 }, { x: 6, y: 67 }, { x: 6, y: 35 },
  ],
};

const compactLayouts: Record<number, TableSeatPoint[]> = {
  2: [
    { x: 50, y: 4 }, { x: 50, y: 96 },
  ],
  3: [
    { x: 50, y: 4 }, { x: 76, y: 91 }, { x: 24, y: 91 },
  ],
  4: [
    { x: 50, y: 4 }, { x: 90, y: 50 }, { x: 50, y: 96 }, { x: 10, y: 50 },
  ],
  5: [
    { x: 50, y: 4 }, { x: 90, y: 34 }, { x: 72, y: 93 }, { x: 28, y: 93 }, { x: 10, y: 34 },
  ],
  6: [
    { x: 50, y: 4 }, { x: 98, y: 24 }, { x: 96, y: 72 }, { x: 50, y: 96 }, { x: 4, y: 72 }, { x: 2, y: 24 },
  ],
  7: [
    { x: 50, y: 3 }, { x: 92, y: 24 }, { x: 92, y: 70 }, { x: 70, y: 93 }, { x: 30, y: 93 }, { x: 8, y: 70 }, { x: 8, y: 24 },
  ],
  8: [
    { x: 30, y: 8 }, { x: 70, y: 8 }, { x: 92, y: 33 }, { x: 92, y: 67 }, { x: 70, y: 92 }, { x: 30, y: 92 }, { x: 8, y: 67 }, { x: 8, y: 33 },
  ],
  9: [
    { x: 50, y: 2 }, { x: 92, y: 16 }, { x: 98, y: 46 }, { x: 99, y: 74 }, { x: 66, y: 99 }, { x: 34, y: 99 }, { x: 1, y: 74 }, { x: 2, y: 46 }, { x: 8, y: 16 },
  ],
};

function betShift(point: TableSeatPoint, horizontalDistance: number, verticalDistance: number): TableSeatPoint {
  const deltaX = 50 - point.x;
  const deltaY = 50 - point.y;
  const length = Math.hypot(deltaX, deltaY) || 1;
  return {
    x: deltaX / length * horizontalDistance,
    y: deltaY / length * verticalDistance,
  };
}

export function tableSeatLayout(playerCount: number, index: number): TableSeatPlacement {
  const normalizedCount = Math.min(9, Math.max(2, Math.round(playerCount)));
  const compactPoints = compactLayouts[normalizedCount] ?? compactLayouts[2]!;
  const widePoints = wideLayouts[normalizedCount] ?? wideLayouts[2]!;
  const compact = compactPoints[index % compactPoints.length]!;
  const wide = widePoints[index % widePoints.length]!;
  return {
    compact,
    wide,
    compactBetShift: betShift(compact, 6.1, 4.7),
    wideBetShift: betShift(wide, 8.1, 5),
  };
}

export function tableSeatPoints(playerCount: number, mode: "compact" | "wide" = "wide"): TableSeatPoint[] {
  const normalizedCount = Math.min(9, Math.max(2, Math.round(playerCount)));
  const source = mode === "compact" ? compactLayouts : wideLayouts;
  return source[normalizedCount]!.map((point) => ({ ...point }));
}
