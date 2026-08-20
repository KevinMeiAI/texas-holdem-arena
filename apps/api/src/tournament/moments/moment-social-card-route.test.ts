import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import {
  MOMENT_SOCIAL_CARD_PROJECTION_VERSION,
  type PublicMomentDto,
  type SocialCardProjection,
} from "../../../../../packages/contracts/src/index.js";
import type { PublicTournamentIdentityContext } from "../arena-service.js";
import { renderMomentSocialCard } from "./moment-social-card-renderer.js";
import { registerMomentSocialCardRoutes } from "./moment-social-card-route.js";
import { renderMomentSocialCardOffThread } from "./moment-social-card-worker-client.js";

function publicMoment(revision = 3): PublicMomentDto {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    tournamentId: "22222222-2222-4222-8222-222222222222",
    slug: "river-turnaround",
    publicationRevision: revision,
    status: "PUBLISHED",
  } as PublicMomentDto;
}

function projection(locale: "zh-CN" | "en"): SocialCardProjection {
  return {
    version: MOMENT_SOCIAL_CARD_PROJECTION_VERSION,
    locale,
    tournamentName: "Model Masters",
    handNo: 12,
    title: "River turnaround",
    summary: "Who takes down this defining pot?",
    tagLabel: "Key hand",
    additionalPlayerCount: 0,
    spoilerMode: "SUSPENSE",
    coverStreetLabel: "Flop",
    coverBoard: ["As", "Kd", "Qc"],
    coverPotChips: 1_000,
    coverPotBigBlinds: 10,
    players: [
      {
        playerId: "p1",
        displayName: "Alpha",
        seat: 0,
        providerBrand: "chatgpt",
        position: "D · SB",
        coverStack: 700,
        coverEquityPercent: 72,
        foldedAtCover: false,
        allInAtCover: false,
      },
      {
        playerId: "p2",
        displayName: "Beta",
        seat: 1,
        providerBrand: "claude",
        position: "BB",
        coverStack: 700,
        coverEquityPercent: 28,
        foldedAtCover: false,
        allInAtCover: false,
      },
    ],
  };
}

const identity = {
  tournament: { id: "22222222-2222-4222-8222-222222222222", name: "Model Masters" },
  players: [],
} satisfies PublicTournamentIdentityContext;

describe("Moment social card route", () => {
  it("serves a real 1200x675 PNG with a strong validator for GET and HEAD", async () => {
    const moment = publicMoment();
    let renderCount = 0;
    const app = Fastify();
    await registerMomentSocialCardRoutes(app, {
      moments: { getPublicBySlug: async (slug) => slug === moment.slug ? moment : null },
      arena: {
        publicIdentityContext: async () => identity,
      },
    }, {
      project: ({ locale }) => projection(locale),
      render: (input) => {
        renderCount += 1;
        return renderMomentSocialCard(input);
      },
    });
    await app.ready();
    try {
      const coldHead = await app.inject({
        method: "HEAD",
        url: "/api/public/moments/river-turnaround/social-card/v1/r3/zh.png",
      });
      expect(coldHead.statusCode).toBe(200);
      expect(coldHead.body).toBe("");
      expect(coldHead.headers.etag).toBeUndefined();
      expect(coldHead.headers["content-length"]).toBeUndefined();
      expect(renderCount).toBe(0);

      const response = await app.inject({
        method: "GET",
        url: "/api/public/moments/river-turnaround/social-card/v1/r3/en.png",
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toBe("image/png");
      expect(response.headers["cache-control"]).toBe("public, max-age=0, must-revalidate");
      expect(response.headers.etag).toMatch(/^"[a-f0-9]{64}"$/);
      expect(response.rawPayload.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
      expect(response.rawPayload.readUInt32BE(16)).toBe(1_200);
      expect(response.rawPayload.readUInt32BE(20)).toBe(675);

      const notModified = await app.inject({
        method: "GET",
        url: "/api/public/moments/river-turnaround/social-card/v1/r3/en.png",
        headers: { "if-none-match": `W/"different", W/${response.headers.etag!}` },
      });
      expect(notModified.statusCode).toBe(304);
      expect(notModified.body).toBe("");

      const head = await app.inject({
        method: "HEAD",
        url: "/api/public/moments/river-turnaround/social-card/v1/r3/en.png",
      });
      expect(head.statusCode).toBe(200);
      expect(head.body).toBe("");
      expect(head.headers.etag).toBe(response.headers.etag);
      expect(head.headers["content-length"]).toBe(response.headers["content-length"]);
      expect(renderCount).toBe(1);
    } finally {
      await app.close();
    }
  });

  it.each([
    "/api/public/moments/river-turnaround/social-card/v2/r3/en.png",
    "/api/public/moments/river-turnaround/social-card/v1/r2/en.png",
    "/api/public/moments/river-turnaround/social-card/v1/r3/fr.png",
    "/api/public/moments/River-Turnaround/social-card/v1/r3/en.png",
  ])("does not serve an invalid or stale identity: %s", async (url) => {
    const app = Fastify();
    await registerMomentSocialCardRoutes(app, {
      moments: { getPublicBySlug: async () => publicMoment() },
      arena: {
        publicIdentityContext: async () => identity,
      },
    }, {
      project: ({ locale }) => projection(locale),
      render: renderMomentSocialCard,
    });
    await app.ready();
    try {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(404);
      expect(response.headers["cache-control"]).toBe("no-store");
    } finally {
      await app.close();
    }
  });

  it("withholds a card if the publication is hidden while rendering", async () => {
    const moment = publicMoment();
    let lookupCount = 0;
    const app = Fastify();
    await registerMomentSocialCardRoutes(app, {
      moments: {
        getPublicBySlug: async () => {
          lookupCount += 1;
          return lookupCount === 1 ? moment : null;
        },
      },
      arena: {
        publicIdentityContext: async () => identity,
      },
    }, {
      project: ({ locale }) => projection(locale),
      render: renderMomentSocialCard,
    });
    await app.ready();
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/public/moments/river-turnaround/social-card/v1/r3/zh.png",
      });
      expect(response.statusCode).toBe(404);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["content-type"]).not.toBe("image/png");
    } finally {
      await app.close();
    }
  });

  it("bounds concurrent cold renders instead of blocking the API thread without limit", async () => {
    let releaseRender!: () => void;
    const renderGate = new Promise<void>((resolve) => { releaseRender = resolve; });
    const app = Fastify({ logger: false });
    await registerMomentSocialCardRoutes(app, {
      moments: {
        getPublicBySlug: async (slug) => ({
          ...publicMoment(),
          id: `moment-${slug}`,
          slug,
        }),
      },
      arena: { publicIdentityContext: async () => identity },
    }, {
      project: ({ locale }) => projection(locale),
      render: async (input) => {
        await renderGate;
        return renderMomentSocialCard(input);
      },
    });
    await app.ready();
    try {
      const requests = Array.from({ length: 10 }, (_, index) => app.inject({
        method: "GET",
        url: `/api/public/moments/moment-${index}/social-card/v1/r3/en.png`,
      }));
      const firstSettled = await Promise.race(requests);
      expect(firstSettled.statusCode).toBe(503);
      expect(firstSettled.headers["retry-after"]).toBe("2");
      releaseRender();
      const responses = await Promise.all(requests);
      expect(responses.filter((response) => response.statusCode === 200)).toHaveLength(9);
      expect(responses.filter((response) => response.statusCode === 503)).toHaveLength(1);
    } finally {
      releaseRender();
      await app.close();
    }
  });

  it("releases the render queue after a timed-out worker", async () => {
    let firstRenderStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { firstRenderStarted = resolve; });
    let renderCount = 0;
    const hangingWorker = new URL("./test-fixtures/hanging-social-card-worker.mjs", import.meta.url);
    const app = Fastify({ logger: false });
    await registerMomentSocialCardRoutes(app, {
      moments: {
        getPublicBySlug: async (slug) => ({
          ...publicMoment(),
          id: `moment-${slug}`,
          slug,
        }),
      },
      arena: { publicIdentityContext: async () => identity },
    }, {
      project: ({ locale }) => projection(locale),
      render: (input) => {
        renderCount += 1;
        if (renderCount === 1) {
          firstRenderStarted();
          return renderMomentSocialCardOffThread(input, 40, hangingWorker);
        }
        return renderMomentSocialCard(input);
      },
    });
    await app.ready();
    try {
      const timedOut = app.inject({
        method: "GET",
        url: "/api/public/moments/moment-timeout/social-card/v1/r3/en.png",
      });
      await firstStarted;
      const recovered = app.inject({
        method: "GET",
        url: "/api/public/moments/moment-recovered/social-card/v1/r3/en.png",
      });
      const [timedOutResponse, recoveredResponse] = await Promise.all([timedOut, recovered]);
      expect(timedOutResponse.statusCode).toBe(500);
      expect(recoveredResponse.statusCode).toBe(200);
      expect(recoveredResponse.rawPayload.subarray(0, 8).toString("hex"))
        .toBe("89504e470d0a1a0a");
      expect(renderCount).toBe(2);
    } finally {
      await app.close();
    }
  });
});
