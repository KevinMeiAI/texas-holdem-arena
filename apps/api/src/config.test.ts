import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

describe("loadConfig", () => {
  it("uses safe local defaults", () => {
    expect(loadConfig({})).toEqual({
      host: "127.0.0.1",
      port: 4100,
      databaseUrl: undefined,
      nodeEnv: "development",
      masterKeyBase64: undefined,
      adminEmail: "admin@localhost",
      adminPassword: undefined,
      cookieSecure: false,
      publicOrigin: "http://127.0.0.1:4100",
    });
  });

  it("accepts explicit runtime settings", () => {
    expect(
      loadConfig({
        HOST: "0.0.0.0",
        PORT: "5100",
        DATABASE_URL: "postgres://arena:test@db/arena",
        NODE_ENV: "test",
        ARENA_MASTER_KEY: "test-master-key",
        ARENA_ADMIN_EMAIL: "owner@example.com",
        ARENA_ADMIN_PASSWORD: "secret",
        ARENA_COOKIE_SECURE: "true",
        ARENA_PUBLIC_ORIGIN: "https://arena.example.com",
      }),
    ).toEqual({
      host: "0.0.0.0",
      port: 5100,
      databaseUrl: "postgres://arena:test@db/arena",
      nodeEnv: "test",
      masterKeyBase64: "test-master-key",
      adminEmail: "owner@example.com",
      adminPassword: "secret",
      cookieSecure: true,
      publicOrigin: "https://arena.example.com",
    });
  });

  it("normalizes a trusted public origin and follows the configured local port by default", () => {
    expect(loadConfig({ PORT: "4200" }).publicOrigin).toBe("http://127.0.0.1:4200");
    expect(loadConfig({ ARENA_PUBLIC_ORIGIN: "https://arena.example.com:8443/" }).publicOrigin)
      .toBe("https://arena.example.com:8443");
  });

  it.each([
    "file:///tmp/arena",
    "https://user:secret@arena.example.com",
    "https://arena.example.com/path",
    "https://arena.example.com/?preview=1",
    "not a url",
  ])("rejects an unsafe public origin: %s", (publicOrigin) => {
    expect(() => loadConfig({ ARENA_PUBLIC_ORIGIN: publicOrigin })).toThrow(/ARENA_PUBLIC_ORIGIN/);
  });
});
