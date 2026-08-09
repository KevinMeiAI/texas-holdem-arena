import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { EncryptedPayload } from "../../../../packages/contracts/src/events.js";

export function decodeMasterKey(base64: string): Buffer {
  const key = Buffer.from(base64, "base64");
  if (key.length !== 32 || key.toString("base64").replace(/=+$/, "") !== base64.replace(/=+$/, "")) {
    throw new Error("ARENA_MASTER_KEY must be a valid base64-encoded 32-byte key");
  }
  return key;
}

export function encryptJson(value: unknown, key: Uint8Array, aad: string): EncryptedPayload {
  if (key.byteLength !== 32) throw new Error("AES-256-GCM requires a 32-byte key");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("Encrypted payload must be JSON serializable");
  const ciphertext = Buffer.concat([
    cipher.update(encoded, "utf8"),
    cipher.final(),
  ]);
  return {
    algorithm: "aes-256-gcm",
    nonce: nonce.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
  };
}

export function decryptJson(payload: EncryptedPayload, key: Uint8Array, aad: string): unknown {
  if (key.byteLength !== 32) throw new Error("AES-256-GCM requires a 32-byte key");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(payload.nonce, "base64"));
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(Buffer.from(payload.authTag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, "base64")),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString("utf8")) as unknown;
}
