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
    });
  });
});
