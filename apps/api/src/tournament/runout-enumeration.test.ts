import { describe, expect, it } from "vitest";
import { chooseCount, exactRunouts, sampledRunouts, stringSeed } from "./runout-enumeration.js";

describe("runout enumeration", () => {
  it("counts and visits every exact combination once", () => {
    expect(chooseCount(52, 5)).toBe(2_598_960);
    const visited: string[] = [];
    exactRunouts(["a", "b", "c", "d"], 2, (items) => visited.push(items.join("")));
    expect(visited).toEqual(["ab", "ac", "ad", "bc", "bd", "cd"]);
  });

  it("produces repeatable sampled runouts for a fixed seed", () => {
    const sample = () => {
      const visited: string[] = [];
      sampledRunouts(["a", "b", "c", "d"], 2, 5, stringSeed("fixture"), (items) => visited.push(items.join("")));
      return visited;
    };
    expect(sample()).toEqual(sample());
    expect(sample()).toHaveLength(5);
  });
});
