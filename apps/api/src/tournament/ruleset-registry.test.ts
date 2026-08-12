import { describe, expect, it } from "vitest";
import { CURRENT_RULESET_VERSION, rulesetImplementation } from "./ruleset-registry.js";

describe("ruleset registry", () => {
  it("resolves every persisted ruleset version and rejects unknown versions", () => {
    expect(rulesetImplementation("arena-rules-v1").version).toBe("arena-rules-v1");
    expect(rulesetImplementation("arena-rules-v2").version).toBe("arena-rules-v2");
    expect(CURRENT_RULESET_VERSION).toBe("arena-rules-v2");
    expect(() => rulesetImplementation("arena-rules-missing")).toThrow(/Unsupported Arena ruleset/);
  });
});
