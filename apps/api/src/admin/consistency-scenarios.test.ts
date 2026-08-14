import { describe, expect, it } from "vitest";
import {
  CONSISTENCY_PRESETS,
  CONSISTENCY_SCENARIOS,
  CONSISTENCY_SCENARIO_REGISTRY_VERSION,
  consistencyScenariosForTier,
} from "./consistency-scenarios.js";

describe("consistency scenario registry", () => {
  it("builds twenty unique, engine-validated decision fixtures", () => {
    expect(CONSISTENCY_SCENARIOS).toHaveLength(20);
    expect(new Set(CONSISTENCY_SCENARIOS.map((scenario) => scenario.id)).size).toBe(20);
    for (const scenario of CONSISTENCY_SCENARIOS) {
      expect(scenario.registryVersion).toBe(CONSISTENCY_SCENARIO_REGISTRY_VERSION);
      expect(scenario.preview.holeCards).toHaveLength(2);
      expect(scenario.preview.legalActions.length).toBeGreaterThanOrEqual(2);
      expect(scenario.preview.actionHistory.length).toBeGreaterThan(0);
      expect(scenario.arenaState.schema_version).toBe("model-context-v4");
      expect(scenario.arenaState.phase).toBe(scenario.tags.street);
    }
  });

  it("exposes nested quick, standard, and full presets", () => {
    expect(CONSISTENCY_PRESETS.quick).toHaveLength(4);
    expect(CONSISTENCY_PRESETS.standard).toHaveLength(12);
    expect(CONSISTENCY_PRESETS.full).toHaveLength(20);
    expect(CONSISTENCY_PRESETS.quick.every((id) => CONSISTENCY_PRESETS.standard.includes(id))).toBe(true);
    expect(CONSISTENCY_PRESETS.standard.every((id) => CONSISTENCY_PRESETS.full.includes(id))).toBe(true);
    expect(consistencyScenariosForTier("full")).toHaveLength(20);
  });

  it("covers table sizes, pot sizes, positions, stack depths, streets, and hand classes", () => {
    const values = <K extends keyof (typeof CONSISTENCY_SCENARIOS)[number]["tags"]>(key: K) => (
      new Set(CONSISTENCY_SCENARIOS.map((scenario) => scenario.tags[key]))
    );
    expect(values("tableSize")).toEqual(new Set([2, 3, 6, 9]));
    expect(values("potType")).toEqual(new Set(["UNOPENED", "OPEN_RAISED", "HEADS_UP", "MULTIWAY", "SIDE_POT"]));
    expect(values("position")).toEqual(new Set(["EARLY", "IN_POSITION", "OUT_OF_POSITION", "SANDWICH"]));
    expect(values("stackDepth")).toEqual(new Set(["SHORT", "MEDIUM", "DEEP"]));
    expect(values("street")).toEqual(new Set(["PREFLOP", "FLOP", "TURN", "RIVER"]));
    expect(values("handClass").size).toBeGreaterThanOrEqual(15);
  });
});
