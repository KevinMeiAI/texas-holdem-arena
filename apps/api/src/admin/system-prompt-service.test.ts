import { describe, expect, it } from "vitest";
import { buildEffectiveSystemPrompt } from "../../../../packages/contracts/src/index.js";
import { systemPromptVersionIdentity } from "./system-prompt-service.js";

describe("system prompt version identities", () => {
  it("derives stable UUIDs from the immutable prompt content hash", () => {
    const prompt = buildEffectiveSystemPrompt("arena-system-v11");
    const identity = systemPromptVersionIdentity(prompt.text, "arena-native-v11");
    expect(identity.sha256).toBe(prompt.sha256);
    expect(identity.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(identity).toEqual(systemPromptVersionIdentity(prompt.text, "arena-native-v11"));
    expect(identity.id).not.toBe(systemPromptVersionIdentity(prompt.text, "arena-native-v10").id);
  });
});
