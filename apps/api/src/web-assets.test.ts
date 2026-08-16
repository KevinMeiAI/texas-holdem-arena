import Fastify from "fastify";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { registerWebAssets } from "./app.js";

describe("web asset serving", () => {
  it("serves frontend bundles created after the server starts", async () => {
    const webRoot = await mkdtemp(join(tmpdir(), "arena-web-assets-"));
    const app = Fastify();
    try {
      await mkdir(join(webRoot, "assets"));
      await writeFile(join(webRoot, "index.html"), "<!doctype html><main>Arena shell</main>");
      await registerWebAssets(app, webRoot);
      await app.ready();

      await writeFile(join(webRoot, "assets", "index-new.js"), "export const ready = true;");
      const asset = await app.inject({ method: "GET", url: "/assets/index-new.js" });
      expect(asset.statusCode).toBe(200);
      expect(asset.headers["content-type"]).toContain("application/javascript");
      expect(asset.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
      expect(asset.body).toContain("ready = true");

      const route = await app.inject({ method: "GET", url: "/leaderboard" });
      expect(route.statusCode).toBe(200);
      expect(route.headers["cache-control"]).toBe("no-store");
      expect(route.body).toContain("Arena shell");

      const missingAsset = await app.inject({ method: "GET", url: "/assets/missing.js" });
      expect(missingAsset.statusCode).toBe(404);
      expect(missingAsset.json()).toEqual({ error: "not_found" });
    } finally {
      await app.close();
      await rm(webRoot, { recursive: true, force: true });
    }
  });
});
