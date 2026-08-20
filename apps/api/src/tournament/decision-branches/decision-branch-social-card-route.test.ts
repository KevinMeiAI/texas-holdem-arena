import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import {
  DECISION_BRANCH_SOCIAL_CARD_PROJECTION_VERSION,
  type DecisionBranchSocialCardProjection,
  type PublicDecisionBranchDto,
} from "../../../../../packages/contracts/src/index.js";
import { renderDecisionBranchSocialCard } from "./decision-branch-social-card-renderer.js";
import { registerDecisionBranchSocialCardRoutes } from "./decision-branch-social-card-route.js";
import { renderDecisionBranchSocialCardOffThread } from "./decision-branch-social-card-worker-client.js";

function publicBranch(revision = 3): PublicDecisionBranchDto {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    status: "PUBLISHED",
    slug: "river-mix",
    publicationRevision: revision,
  } as PublicDecisionBranchDto;
}

function projection(locale: "zh-CN" | "en"): DecisionBranchSocialCardProjection {
  return {
    version: DECISION_BRANCH_SOCIAL_CARD_PROJECTION_VERSION,
    locale,
    tournamentName: "Model Masters",
    handNo: 12,
    street: "RIVER",
    title: "River decision branch",
    hero: {
      displayName: "Alpha",
      position: "BTN",
      holeCards: ["As", "Kd"],
      stackChips: 4_200,
      stackBigBlinds: 42,
    },
    board: ["Qc", "Jh", "9s", "2d", "3c"],
    potBeforeActionChips: 2_400,
    potBeforeActionBigBlinds: 24,
    callAmountChips: 800,
    callAmountBigBlinds: 8,
    originalDecision: { action: "call", displayAmountTo: null },
    sampleCountPerModel: 10,
    targetCount: 2,
    displayedTargets: [{
      ordinal: 1,
      displayName: "Alpha",
      providerBrand: "chatgpt",
      validActionTrials: 10,
      completedTrials: 10,
      fallbackTrials: 0,
      infrastructureErrorTrials: 0,
      pairwiseAgreement: 0.6444444444444445,
      actionDistribution: [
        { action: "fold", count: 2, share: 0.2 },
        { action: "call", count: 8, share: 0.8 },
      ],
    }, {
      ordinal: 2,
      displayName: "Beta",
      providerBrand: "claude",
      validActionTrials: 8,
      completedTrials: 10,
      fallbackTrials: 1,
      infrastructureErrorTrials: 1,
      pairwiseAgreement: 1,
      actionDistribution: [{ action: "fold", count: 8, share: 1 }],
    }],
    additionalTargetCount: 0,
    completedAt: "2026-08-20T01:02:03.000Z",
  };
}

describe("Decision Branch social card route", () => {
  it("serves a real 1200x675 PNG with a strong validator for GET and HEAD", async () => {
    const branch = publicBranch();
    let renderCount = 0;
    const app = Fastify();
    await registerDecisionBranchSocialCardRoutes(app, {
      decisionBranches: { getPublicBySlug: async (slug) => slug === branch.slug ? branch : null },
    }, {
      project: ({ locale }) => projection(locale),
      render: (input) => {
        renderCount += 1;
        return renderDecisionBranchSocialCard(input);
      },
    });
    await app.ready();
    try {
      const coldHead = await app.inject({
        method: "HEAD",
        url: "/api/public/decision-branches/river-mix/social-card/v1/r3/zh.png",
      });
      expect(coldHead.statusCode).toBe(200);
      expect(coldHead.body).toBe("");
      expect(coldHead.headers.etag).toBeUndefined();
      expect(coldHead.headers["content-length"]).toBeUndefined();
      expect(renderCount).toBe(0);

      const response = await app.inject({
        method: "GET",
        url: "/api/public/decision-branches/river-mix/social-card/v1/r3/en.png",
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
        url: "/api/public/decision-branches/river-mix/social-card/v1/r3/en.png",
        headers: { "if-none-match": `W/"different", W/${response.headers.etag!}` },
      });
      expect(notModified.statusCode).toBe(304);
      expect(notModified.body).toBe("");

      const head = await app.inject({
        method: "HEAD",
        url: "/api/public/decision-branches/river-mix/social-card/v1/r3/en.png",
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
    "/api/public/decision-branches/river-mix/social-card/v2/r3/en.png",
    "/api/public/decision-branches/river-mix/social-card/v1/r2/en.png",
    "/api/public/decision-branches/river-mix/social-card/v1/r3/fr.png",
    "/api/public/decision-branches/River-Mix/social-card/v1/r3/en.png",
  ])("does not serve an invalid or stale identity: %s", async (url) => {
    const app = Fastify();
    await registerDecisionBranchSocialCardRoutes(app, {
      decisionBranches: { getPublicBySlug: async () => publicBranch() },
    }, {
      project: ({ locale }) => projection(locale),
      render: renderDecisionBranchSocialCard,
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
    const branch = publicBranch();
    let lookupCount = 0;
    const app = Fastify();
    await registerDecisionBranchSocialCardRoutes(app, {
      decisionBranches: {
        getPublicBySlug: async () => (++lookupCount === 1 ? branch : null),
      },
    }, {
      project: ({ locale }) => projection(locale),
      render: renderDecisionBranchSocialCard,
    });
    await app.ready();
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/public/decision-branches/river-mix/social-card/v1/r3/en.png",
      });
      expect(response.statusCode).toBe(404);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["content-type"]).not.toBe("image/png");
    } finally {
      await app.close();
    }
  });

  it("bounds concurrent cold renders", async () => {
    let releaseRender!: () => void;
    const renderGate = new Promise<void>((resolve) => { releaseRender = resolve; });
    const app = Fastify({ logger: false });
    await registerDecisionBranchSocialCardRoutes(app, {
      decisionBranches: {
        getPublicBySlug: async (slug) => ({ ...publicBranch(), id: `branch-${slug}`, slug }),
      },
    }, {
      project: ({ locale }) => projection(locale),
      render: async (input) => {
        await renderGate;
        return renderDecisionBranchSocialCard(input);
      },
    });
    await app.ready();
    try {
      const requests = Array.from({ length: 10 }, (_, index) => app.inject({
        method: "GET",
        url: `/api/public/decision-branches/branch-${index}/social-card/v1/r3/en.png`,
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
    const hangingWorker = new URL("../moments/test-fixtures/hanging-social-card-worker.mjs", import.meta.url);
    const app = Fastify({ logger: false });
    await registerDecisionBranchSocialCardRoutes(app, {
      decisionBranches: {
        getPublicBySlug: async (slug) => ({ ...publicBranch(), id: `branch-${slug}`, slug }),
      },
    }, {
      project: ({ locale }) => projection(locale),
      render: (input) => {
        renderCount += 1;
        if (renderCount === 1) {
          firstRenderStarted();
          return renderDecisionBranchSocialCardOffThread(input, 40, hangingWorker);
        }
        return renderDecisionBranchSocialCard(input);
      },
    });
    await app.ready();
    try {
      const timedOut = app.inject({
        method: "GET",
        url: "/api/public/decision-branches/branch-timeout/social-card/v1/r3/en.png",
      });
      await firstStarted;
      const recovered = app.inject({
        method: "GET",
        url: "/api/public/decision-branches/branch-recovered/social-card/v1/r3/en.png",
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
