import Fastify from "fastify";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PublicDecisionBranchDto } from "../../../../../packages/contracts/src/index.js";
import {
  buildDecisionBranchSocialMetadata,
  injectDecisionBranchSocialMetadata,
  registerDecisionBranchPageRoutes,
} from "./decision-branch-page-route.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

function publicBranch(overrides: Partial<PublicDecisionBranchDto> = {}): PublicDecisionBranchDto {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    status: "PUBLISHED",
    slug: "river-mix",
    titleZh: "河牌决策分叉",
    titleEn: "River decision branch",
    summaryZh: "同一决策点，不同模型会怎么选？",
    summaryEn: "How do different models approach the same decision?",
    publicationRevision: 3,
    publishedAt: "2026-08-20T01:02:03.000Z",
    snapshot: {
      source: {
        handNo: 12,
      },
    },
    ...overrides,
  } as PublicDecisionBranchDto;
}

function shell(asset = "/assets/current.js"): string {
  return `<!doctype html><html lang="zh-CN"><head><!-- arena:dynamic-social:start --><meta property="og:title" content="stale"><!-- arena:dynamic-social:end --><meta name="description" content="generic"><title>Arena</title></head><body><div id="root"></div><script src="${asset}"></script></body></html>`;
}

async function webRootWithShell(asset?: string): Promise<string> {
  const webRoot = await mkdtemp(join(tmpdir(), "arena-decision-branch-page-"));
  temporaryDirectories.push(webRoot);
  await writeFile(join(webRoot, "index.html"), shell(asset));
  return webRoot;
}

describe("Decision Branch social metadata", () => {
  it("uses localized editorial copy, factual fallbacks, and only the trusted origin", () => {
    const metadata = buildDecisionBranchSocialMetadata(
      publicBranch(),
      "en",
      "https://arena.example.com:8443",
    );
    expect(metadata).toMatchObject({
      title: "River decision branch",
      description: "How do different models approach the same decision?",
      canonicalUrl: "https://arena.example.com:8443/branches/river-mix?lang=en",
      alternateZhUrl: "https://arena.example.com:8443/branches/river-mix",
      alternateEnUrl: "https://arena.example.com:8443/branches/river-mix?lang=en",
      imageUrl: "https://arena.example.com:8443/api/public/decision-branches/river-mix/social-card/v1/r3/en.png",
      imageAlt: "River decision branch share card",
    });

    const fallback = buildDecisionBranchSocialMetadata(publicBranch({
      titleZh: null,
      titleEn: null,
      summaryZh: null,
      summaryEn: null,
    }), "zh", "https://arena.example.com");
    expect(fallback.title).toBe("第 012 手 · 决策分叉");
    expect(fallback.description).toBe("查看第 12 手同一德扑决策点的模型复测结果。");

    const noCrossLanguageFallback = buildDecisionBranchSocialMetadata(publicBranch({
      titleZh: "只有中文标题",
      titleEn: null,
      summaryZh: "只有中文摘要",
      summaryEn: null,
    }), "en", "https://arena.example.com");
    expect(noCrossLanguageFallback.title).toBe("Hand 012 · Decision branch");
    expect(noCrossLanguageFallback.description)
      .toBe("Compare repeated model decisions at the same poker spot from hand 12.");
  });

  it("escapes editorial text and treats replacement tokens as plain copy", () => {
    const branch = publicBranch({
      titleZh: "$& $' $` </title><script>alert(\"x\")</script> & 决策",
      summaryZh: '换行\n\n 与 <b>markup</b> "quotes"',
    });
    const html = injectDecisionBranchSocialMetadata(
      shell(),
      buildDecisionBranchSocialMetadata(branch, "zh", "https://arena.example.com"),
    );
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("$&amp; $&#39; $`");
    expect(html).toContain("&lt;/title&gt;&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; 决策");
    expect(html).toContain("换行 与 &lt;b&gt;markup&lt;/b&gt; &quot;quotes&quot;");
    expect(html.match(/<title\b/g)).toHaveLength(1);
    expect(html.match(/name="description"/g)).toHaveLength(1);
    expect(html.match(/arena:dynamic-social:start/g)).toHaveLength(1);
    expect(html).toContain('<script src="/assets/current.js"></script>');
  });
});

describe("Decision Branch page route", () => {
  it("serves crawler-ready GET and HEAD without trusting request host headers", async () => {
    const webRoot = await webRootWithShell();
    const branch = publicBranch();
    const app = Fastify();
    await registerDecisionBranchPageRoutes(app, {
      decisionBranches: { getPublicBySlug: async (slug) => slug === branch.slug ? branch : null },
      publicOrigin: "https://arena.example.com",
      webRoot,
    });
    await app.ready();
    try {
      const response = await app.inject({
        method: "GET",
        url: "/branches/river-mix?lang=en",
        headers: { host: "attacker.example", "x-forwarded-host": "attacker.example" },
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.body).toContain('<html lang="en">');
      expect(response.body).toContain('<meta property="og:title" content="River decision branch"');
      expect(response.body).toContain('href="https://arena.example.com/branches/river-mix?lang=en"');
      expect(response.body).toContain('<meta name="twitter:card" content="summary_large_image"');
      expect(response.body).toContain('<meta property="og:image" content="https://arena.example.com/api/public/decision-branches/river-mix/social-card/v1/r3/en.png"');
      expect(response.body).not.toContain("attacker.example");
      expect(response.body).toContain("/assets/current.js");

      const head = await app.inject({ method: "HEAD", url: "/branches/river-mix" });
      expect(head.statusCode).toBe(200);
      expect(head.body).toBe("");
      expect(Number(head.headers["content-length"])).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });

  it("redirects a non-canonical slug to a trusted localized URL", async () => {
    const webRoot = await webRootWithShell();
    const getPublicBySlug = vi.fn(async () => publicBranch());
    const app = Fastify();
    await registerDecisionBranchPageRoutes(app, {
      decisionBranches: { getPublicBySlug },
      publicOrigin: "https://arena.example.com",
      webRoot,
    });
    await app.ready();
    try {
      const response = await app.inject({
        method: "GET",
        url: "/branches/River-Mix?lang=en",
        headers: { host: "attacker.example" },
      });
      expect(response.statusCode).toBe(308);
      expect(response.headers.location).toBe("https://arena.example.com/branches/river-mix?lang=en");
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(getPublicBySlug).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("returns a noindex 404 for invalid, missing, or hidden publications", async () => {
    const webRoot = await webRootWithShell();
    const getPublicBySlug = vi.fn(async () => null);
    const app = Fastify();
    await registerDecisionBranchPageRoutes(app, {
      decisionBranches: { getPublicBySlug },
      publicOrigin: "https://arena.example.com",
      webRoot,
    });
    await app.ready();
    try {
      const invalid = await app.inject({ method: "GET", url: "/branches/not_valid" });
      expect(invalid.statusCode).toBe(404);
      expect(invalid.headers["cache-control"]).toBe("no-store");
      expect(invalid.headers["x-robots-tag"]).toBe("noindex, nofollow");
      expect(invalid.body).toContain('name="robots" content="noindex,nofollow"');
      expect(getPublicBySlug).not.toHaveBeenCalled();

      const hidden = await app.inject({ method: "GET", url: "/branches/hidden-branch?lang=en" });
      expect(hidden.statusCode).toBe(404);
      expect(hidden.headers["cache-control"]).toBe("no-store");
      expect(hidden.headers["x-robots-tag"]).toBe("noindex, nofollow");
      expect(hidden.body).toContain("This decision branch is unavailable.");
    } finally {
      await app.close();
    }
  });

  it("reads the current shell and latest publication after filesystem I/O", async () => {
    const webRoot = await webRootWithShell("/assets/first.js");
    const before = publicBranch({ publicationRevision: 3, titleEn: "Before edit" });
    const after = publicBranch({ publicationRevision: 4, titleEn: "After edit" });
    let lookups = 0;
    const app = Fastify();
    await registerDecisionBranchPageRoutes(app, {
      decisionBranches: { getPublicBySlug: async () => (++lookups % 2 === 1 ? before : after) },
      publicOrigin: "https://arena.example.com",
      webRoot,
    });
    await app.ready();
    try {
      const first = await app.inject({ method: "GET", url: "/branches/river-mix?lang=en" });
      expect(first.statusCode).toBe(200);
      expect(first.body).toContain('content="After edit"');
      expect(first.body).not.toContain('content="Before edit"');
      expect(first.body).toContain("/assets/first.js");

      await writeFile(join(webRoot, "index.html"), shell("/assets/rebuilt.js"));
      const rebuilt = await app.inject({ method: "GET", url: "/branches/river-mix?lang=en" });
      expect(rebuilt.statusCode).toBe(200);
      expect(rebuilt.body).toContain("/assets/rebuilt.js");
    } finally {
      await app.close();
    }
  });

  it("withholds the shell if a publication is hidden while it is being read", async () => {
    const webRoot = await webRootWithShell();
    let lookups = 0;
    const app = Fastify();
    await registerDecisionBranchPageRoutes(app, {
      decisionBranches: { getPublicBySlug: async () => ++lookups === 1 ? publicBranch() : null },
      publicOrigin: "https://arena.example.com",
      webRoot,
    });
    await app.ready();
    try {
      const response = await app.inject({ method: "GET", url: "/branches/river-mix" });
      expect(response.statusCode).toBe(404);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["x-robots-tag"]).toBe("noindex, nofollow");
      expect(response.body).not.toContain("/assets/current.js");
      expect(response.body).not.toContain("River decision branch");
    } finally {
      await app.close();
    }
  });
});
