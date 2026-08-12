import { describe, expect, it } from "vitest";
import {
  CURRENT_DECISION_PROTOCOL_BUNDLE_ID,
  decisionProtocolBundle,
  legacyDecisionProtocolBundle,
} from "./decision-protocol.js";

describe("decision protocol bundle registry", () => {
  it("resolves the frozen v10 compatibility bundle explicitly", () => {
    expect(decisionProtocolBundle()).toEqual({
      id: "arena-native-v10",
      systemPromptVersion: "arena-system-v10",
      contextVersion: "model-context-v3",
      outputSchemaVersion: "arena-output-v2",
      parserPolicyVersion: "arena-parser-legacy-v1",
      correctionProtocolVersion: "arena-correction-legacy-v1",
      historyProtocolVersion: "arena-history-legacy-v1",
      adapterProtocolVersion: "arena-adapters-v1",
    });
    expect(CURRENT_DECISION_PROTOCOL_BUNDLE_ID).toBe("arena-native-v10");
  });

  it("never silently falls back for an unknown registered bundle", () => {
    expect(() => decisionProtocolBundle("missing")).toThrow(/Unsupported decision protocol bundle/);
  });

  it("maps older snapshot versions to a clearly labelled legacy bundle", () => {
    expect(legacyDecisionProtocolBundle("arena-system-v1")).toMatchObject({
      id: "legacy/arena-system-v1/arena-output-v2",
      contextVersion: "model-context-v1",
    });
  });
});
