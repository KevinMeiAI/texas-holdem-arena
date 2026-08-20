import Fastify from "fastify";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PublicDecisionBranchDto } from "../../../packages/contracts/src/decision-branches.js";
import type { PublicMomentDto } from "../../../packages/contracts/src/moments.js";
import { registerWebAssets } from "./app.js";
import { registerDecisionBranchPageRoutes } from "./tournament/decision-branches/decision-branch-page-route.js";
import { registerMomentPageRoutes } from "./tournament/moments/moment-page-route.js";

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

  it("gives the crawler-ready Moment route precedence over the SPA wildcard", async () => {
    const webRoot = await mkdtemp(join(tmpdir(), "arena-web-assets-"));
    const app = Fastify();
    try {
      await writeFile(
        join(webRoot, "index.html"),
        '<!doctype html><html lang="zh-CN"><head><title>Arena</title></head><body><script src="/assets/current.js"></script></body></html>',
      );
      const moment = {
        id: "11111111-1111-4111-8111-111111111111",
        slug: "final-hand",
        handNo: 9,
        titleZh: "决胜手",
        titleEn: "Final hand",
        summaryZh: null,
        summaryEn: null,
        publicationRevision: 2,
        publishedAt: "2026-08-20T01:02:03.000Z",
      } as PublicMomentDto;
      await registerMomentPageRoutes(app, {
        moments: { getPublicBySlug: async (slug) => slug === moment.slug ? moment : null },
        publicOrigin: "https://arena.example.com",
        webRoot,
      });
      await registerWebAssets(app, webRoot);
      await app.ready();

      const response = await app.inject({ method: "GET", url: "/moments/final-hand?lang=en" });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('<meta property="og:title" content="Final hand"');
      expect(response.body).toContain("/assets/current.js");
      expect(response.body).not.toContain("<title>Arena</title>");

      const hidden = await app.inject({ method: "GET", url: "/moments/not-published" });
      expect(hidden.statusCode).toBe(404);
      expect(hidden.headers["x-robots-tag"]).toBe("noindex, nofollow");
    } finally {
      await app.close();
      await rm(webRoot, { recursive: true, force: true });
    }
  });

  it("gives the crawler-ready Decision Branch route precedence over the SPA wildcard", async () => {
    const webRoot = await mkdtemp(join(tmpdir(), "arena-web-assets-"));
    const app = Fastify();
    try {
      await writeFile(
        join(webRoot, "index.html"),
        '<!doctype html><html lang="zh-CN"><head><title>Arena</title></head><body><script src="/assets/current.js"></script></body></html>',
      );
      const branch = {
        id: "11111111-1111-4111-8111-111111111111",
        status: "PUBLISHED",
        slug: "river-mix",
        titleZh: "河牌决策分叉",
        titleEn: "River decision branch",
        summaryZh: null,
        summaryEn: "Same spot, different decisions.",
        publicationRevision: 2,
        publishedAt: "2026-08-20T01:02:03.000Z",
        snapshot: { source: { handNo: 9 } },
      } as PublicDecisionBranchDto;
      await registerDecisionBranchPageRoutes(app, {
        decisionBranches: { getPublicBySlug: async (slug) => slug === branch.slug ? branch : null },
        publicOrigin: "https://arena.example.com",
        webRoot,
      });
      await registerWebAssets(app, webRoot);
      await app.ready();

      const response = await app.inject({ method: "GET", url: "/branches/river-mix?lang=en" });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('<meta property="og:title" content="River decision branch"');
      expect(response.body).toContain("/assets/current.js");
      expect(response.body).not.toContain("<title>Arena</title>");

      const hidden = await app.inject({ method: "GET", url: "/branches/not-published" });
      expect(hidden.statusCode).toBe(404);
      expect(hidden.headers["x-robots-tag"]).toBe("noindex, nofollow");
    } finally {
      await app.close();
      await rm(webRoot, { recursive: true, force: true });
    }
  });
});
