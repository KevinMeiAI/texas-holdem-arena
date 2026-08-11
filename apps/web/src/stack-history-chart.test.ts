import { describe, expect, it } from "vitest";
import { createStackHistorySeries } from "./stack-history-chart";

describe("stack history chart series", () => {
  it("prepends an equal-stack origin before the first completed hand", () => {
    const points = [
      { handNo: 1, stacks: { alice: 1_200, bob: 800 } },
      { handNo: 2, stacks: { alice: 900, bob: 1_100 } },
    ];

    const series = createStackHistorySeries([{ id: "alice" }, { id: "bob" }], points, 1_000);

    expect(series.map((point) => point.handNo)).toEqual([null, 1, 2]);
    expect(series[0]).toEqual({
      key: "origin",
      handNo: null,
      stacks: { alice: 1_000, bob: 1_000 },
    });
    expect(series[1]?.stacks).toEqual(points[0]?.stacks);
  });

  it("still exposes the origin before any hand has completed", () => {
    expect(createStackHistorySeries([{ id: "alice" }, { id: "bob" }], [], 2_000)).toEqual([
      { key: "origin", handNo: null, stacks: { alice: 2_000, bob: 2_000 } },
    ]);
  });
});
