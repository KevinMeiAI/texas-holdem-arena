import { describe, expect, it } from "vitest";
import { decodeMasterKey, decryptJson, encryptJson } from "./encryption.js";

describe("private payload encryption", () => {
  const key = Buffer.alloc(32, 7);

  it("round-trips JSON with authenticated context and randomized nonces", () => {
    const value = { holeCards: ["As", "Ah"], nested: { answer: 42 } };
    const first = encryptJson(value, key, "event:t1:1");
    const second = encryptJson(value, key, "event:t1:1");
    expect(first.ciphertext).not.toBe(second.ciphertext);
    expect(decryptJson(first, key, "event:t1:1")).toEqual(value);
    expect(() => decryptJson(first, key, "event:t1:2")).toThrow();
  });

  it("requires an exact base64-encoded 32-byte master key", () => {
    expect(decodeMasterKey(key.toString("base64"))).toEqual(key);
    expect(() => decodeMasterKey(Buffer.alloc(16).toString("base64"))).toThrow(/32-byte/);
    expect(() => decodeMasterKey("not base64!*" )).toThrow(/base64/);
  });
});
