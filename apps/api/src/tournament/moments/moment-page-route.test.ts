import Fastify from "fastify";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PublicMomentDto } from "../../../../../packages/contracts/src/moments.js";
import {
  buildMomentSocialMetadata,
  injectMomentSocialMetadata,
  registerMomentPageRoutes,
} from "./moment-page-route.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

function publicMoment(overrides: Partial<PublicMomentDto> = {}): PublicMomentDto {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    tournamentId: "22222222-2222-4222-8222-222222222222",
    handNo: 12,
    status: "PUBLISHED",
    slug: "river-turnaround",
    titleZh: "河牌逆转",
    titleEn: "River turnaround",
    summaryZh: "一手值得重看的关键底池。",
    summaryEn: "A defining pot worth replaying.",
    coverSequence: 10,
    playbackStartSequence: 8,
    playbackEndSequence: 18,
    spoilerMode: "SUSPENSE",
    isPrimary: true,
    publicationRevision: 3,
    publishedAt: "2026-08-20T01:02:03.000Z",
    primaryTag: "EQUITY_REVERSAL",
    tags: ["EQUITY_REVERSAL"],
    score: 88,
    facts: {
      id: "11111111-1111-4111-8111-111111111111",
      tournamentId: "22222222-2222-4222-8222-222222222222",
      handNo: 12,
      startSequence: 8,
      focusSequence: 10,
      endSequence: 18,
      factsVersion: "arena-moment-facts-v1",
      detectorVersion: "arena-moment-detector-v2",
      scoringVersion: "arena-moment-scoring-v1",
      broadcastViewVersion: "broadcast-v1",
      equityVersion: "equity-v1",
      source: {
        eventHash: "a".repeat(64),
        eventCount: 11,
        startEventHash: "b".repeat(64),
        endEventHash: "c".repeat(64),
      },
      score: 88,
      scoreBreakdown: { potImpact: 20, tournamentImpact: 25, actionDrama: 15, equityDrama: 20, rarity: 8 },
      recommendationRank: 1,
      primaryTag: "EQUITY_REVERSAL",
      tags: ["EQUITY_REVERSAL"],
      participantPlayerIds: ["p1", "p2"],
      featuredPlayerIds: ["p1", "p2"],
      winnerPlayerIds: ["p2"],
      eliminatedPlayerIds: [],
      showdownPlayerIds: ["p1", "p2"],
      board: ["As", "Kd", "Qc", "Jh", "Ts"],
      bigBlind: 100,
      potChips: 2_400,
      potBigBlinds: 24,
      totalChipShare: 0.3,
      startingStacks: { p1: 1_200, p2: 1_200 },
      endingStacks: { p1: 0, p2: 2_400 },
      netChanges: { p1: -1_200, p2: 1_200 },
      actionCount: 2,
      preflopRaiseCount: 1,
      overbetSequences: [],
      sidePotCount: 0,
      splitPot: false,
      leadChange: true,
      maxDecisionLatencyMs: 1_200,
      winningHandCategories: [],
      actions: [],
      allInLock: null,
      equityTransitions: [],
    },
    ...overrides,
  };
}

describe("Moment social metadata", () => {
  it("uses only the trusted origin and versioned image identity", () => {
    const metadata = buildMomentSocialMetadata(publicMoment(), "en", "https://arena.example.com");
    expect(metadata.canonicalUrl).toBe("https://arena.example.com/moments/river-turnaround?lang=en");
    expect(metadata.imageUrl).toBe(
      "https://arena.example.com/api/public/moments/river-turnaround/social-card/v1/r3/en.png",
    );
  });

  it("escapes editorial text before inserting it into the document head", () => {
    const moment = publicMoment({
      titleZh: "$& $' $` </title><script>alert(\"x\")</script> & 好牌",
      summaryZh: '换行\n\n 与 <b>markup</b> "quotes"',
    });
    const html = injectMomentSocialMetadata(
      '<!doctype html><html lang="zh-CN"><head><meta name="description" content="old"><title>Old</title></head><body><script src="/assets/app.js"></script></body></html>',
      buildMomentSocialMetadata(moment, "zh", "https://arena.example.com"),
    );
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("$&amp; $&#39; $`");
    expect(html).toContain("&lt;/title&gt;&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; 好牌");
    expect(html).toContain('换行 与 &lt;b&gt;markup&lt;/b&gt; &quot;quotes&quot;');
    expect(html.match(/<title\b/g)).toHaveLength(1);
    expect(html.match(/name="description"/g)).toHaveLength(1);
    expect(html).toContain('<script src="/assets/app.js"></script>');
  });
});

describe("Moment page route", () => {
  it("serves crawler-ready GET and HEAD responses without trusting request host headers", async () => {
    const webRoot = await mkdtemp(join(tmpdir(), "arena-moment-page-"));
    temporaryDirectories.push(webRoot);
    await writeFile(
      join(webRoot, "index.html"),
      '<!doctype html><html lang="zh-CN"><head><meta name="description" content="generic"><title>Arena</title></head><body><div id="root"></div><script src="/assets/current.js"></script></body></html>',
    );
    const moment = publicMoment();
    const app = Fastify();
    await registerMomentPageRoutes(app, {
      moments: { getPublicBySlug: async (slug) => slug === moment.slug ? moment : null },
      publicOrigin: "https://arena.example.com",
      webRoot,
    });
    await app.ready();
    try {
      const response = await app.inject({
        method: "GET",
        url: "/moments/river-turnaround?lang=en",
        headers: { host: "attacker.example", "x-forwarded-host": "attacker.example" },
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.body).toContain('<meta property="og:title" content="River turnaround"');
      expect(response.body).toContain('href="https://arena.example.com/moments/river-turnaround?lang=en"');
      expect(response.body).not.toContain("attacker.example");
      expect(response.body).toContain('/assets/current.js');

      const head = await app.inject({ method: "HEAD", url: "/moments/river-turnaround" });
      expect(head.statusCode).toBe(200);
      expect(head.body).toBe("");
      expect(Number(head.headers["content-length"])).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });

  it("returns noindex 404 for unpublished content and reads a rebuilt shell on each request", async () => {
    const webRoot = await mkdtemp(join(tmpdir(), "arena-moment-page-"));
    temporaryDirectories.push(webRoot);
    const shell = (asset: string) => `<!doctype html><html lang="zh-CN"><head><title>Arena</title></head><body><script src="${asset}"></script></body></html>`;
    await writeFile(join(webRoot, "index.html"), shell("/assets/first.js"));
    const moment = publicMoment();
    let published = true;
    const app = Fastify();
    await registerMomentPageRoutes(app, {
      moments: { getPublicBySlug: async () => published ? moment : null },
      publicOrigin: "https://arena.example.com",
      webRoot,
    });
    await app.ready();
    try {
      expect((await app.inject({ method: "GET", url: "/moments/river-turnaround" })).body)
        .toContain("/assets/first.js");
      await writeFile(join(webRoot, "index.html"), shell("/assets/rebuilt.js"));
      expect((await app.inject({ method: "GET", url: "/moments/river-turnaround" })).body)
        .toContain("/assets/rebuilt.js");

      published = false;
      const hidden = await app.inject({ method: "GET", url: "/moments/river-turnaround" });
      expect(hidden.statusCode).toBe(404);
      expect(hidden.headers["cache-control"]).toBe("no-store");
      expect(hidden.headers["x-robots-tag"]).toBe("noindex, nofollow");
      expect(hidden.body).not.toContain("final-hand");
    } finally {
      await app.close();
    }
  });

  it("uses the latest publication revision when an edit races shell loading", async () => {
    const webRoot = await mkdtemp(join(tmpdir(), "arena-moment-page-"));
    temporaryDirectories.push(webRoot);
    await writeFile(
      join(webRoot, "index.html"),
      '<!doctype html><html lang="zh-CN"><head><title>Arena</title></head><body></body></html>',
    );
    const before = publicMoment({ publicationRevision: 3, titleEn: "Before edit" });
    const after = publicMoment({ publicationRevision: 4, titleEn: "After edit" });
    let lookups = 0;
    const app = Fastify();
    await registerMomentPageRoutes(app, {
      moments: { getPublicBySlug: async () => (++lookups === 1 ? before : after) },
      publicOrigin: "https://arena.example.com",
      webRoot,
    });
    await app.ready();
    try {
      const response = await app.inject({ method: "GET", url: "/moments/river-turnaround?lang=en" });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('content="After edit"');
      expect(response.body).toContain("/social-card/v1/r4/en.png");
      expect(response.body).not.toContain("/social-card/v1/r3/en.png");
    } finally {
      await app.close();
    }
  });
});
