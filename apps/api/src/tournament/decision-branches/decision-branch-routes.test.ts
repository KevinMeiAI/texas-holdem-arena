import fastifyCookie from "@fastify/cookie";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DECISION_BRANCH_SNAPSHOT_VERSION,
  type DecisionBranchPublication,
  type PublicDecisionBranchDto,
} from "../../../../../packages/contracts/src/index.js";
import type { AuthService } from "../../auth/auth-service.js";
import type { AppConfig } from "../../config.js";
import { DecisionBranchSlugConflictError } from "./decision-branch-repository.js";
import {
  registerDecisionBranchRoutes,
  type DecisionBranchRouteService,
} from "./decision-branch-routes.js";
import { DecisionBranchServiceError } from "./decision-branch-service.js";

const uuid = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const BRANCH_ID = uuid(1);
const HAND_FORK_ID = uuid(2);
const ADMIN_ID = uuid(3);
const CREATED_AT = "2026-08-20T01:00:00.000Z";
const PUBLISHED_AT = "2026-08-20T02:00:00.000Z";

const apps: ReturnType<typeof Fastify>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function frozenSnapshot(): DecisionBranchPublication["snapshot"] {
  // Snapshot schema integrity is covered by the contract/service tests. Route
  // tests keep this fixture deliberately small so they stay focused on HTTP
  // authorization and the admin/public DTO boundary.
  return {
    version: DECISION_BRANCH_SNAPSHOT_VERSION,
    source: {
      tournamentId: uuid(4),
      tournamentName: "Final Table",
      handNo: 12,
      actionSequence: 90,
      street: "FLOP",
      heroPlayerId: "hero",
      heroDisplayName: "Hero",
      heroPosition: "BTN",
      heroHoleCards: ["Ah", "Kd"],
      board: ["Ac", "7d", "2s"],
      blinds: { smallBlind: 50, bigBlind: 100, bigBlindAnte: 100 },
      potBeforeAction: 900,
      potBigBlinds: 9,
      currentBet: 0,
      callAmount: 0,
      legalActions: {
        allowed: ["check", "bet", "all_in"],
        call: null,
        bet: { min_amount_to: 100, max_amount_to: 4_000 },
        raise: null,
        all_in: { resulting_street_commitment: 4_000, classification: "bet" },
      },
      players: [
        {
          playerId: "hero",
          displayName: "Hero",
          seat: 0,
          position: "BTN",
          stack: 4_000,
          stackBigBlinds: 40,
          streetCommitted: 0,
          totalCommitted: 450,
          folded: false,
          allIn: false,
          competitorId: uuid(5),
          providerBrand: "chatgpt",
        },
        {
          playerId: "villain",
          displayName: "Villain",
          seat: 1,
          position: "BB",
          stack: 4_000,
          stackBigBlinds: 40,
          streetCommitted: 0,
          totalCommitted: 450,
          folded: false,
          allIn: false,
          competitorId: uuid(6),
          providerBrand: "claude",
        },
      ],
      actionHistory: [],
      originalDecision: {
        action: "check",
        amountTo: null,
        decisionSummary: "Control the pot.",
        usedFallback: false,
      },
    },
    methodology: {
      scope: "DECISION_ONLY",
      continuationSimulated: false,
      sameVisibleInput: true,
      sampleCountPerModel: 1,
      targetCount: 1,
      createdAt: CREATED_AT,
      completedAt: "2026-08-20T01:01:00.000Z",
    },
    targets: [{
      ordinal: 1,
      competitorId: uuid(7),
      competitorRevisionId: uuid(8),
      displayName: "Rerun Model",
      modelId: "model-v1",
      providerBrand: "deepseek",
      effectiveOutputMode: "json_schema",
      requestedSamples: 1,
      completedTrials: 1,
      modelActionTrials: 1,
      fallbackTrials: 0,
      infrastructureErrorTrials: 0,
      modalAction: "bet",
      modalShare: 1,
      pairwiseAgreement: null,
      firstTurnValidRate: 1,
      historyQueryRate: 0,
      correctionRate: 0,
      averageLatencyMs: 900,
      p95LatencyMs: 900,
      actionDistribution: [{ action: "bet", count: 1, share: 1 }],
      sizing: [{ action: "bet", count: 1, median: 500, min: 500, max: 500 }],
      trials: [{
        sampleIndex: 1,
        outcome: "MODEL_ACTION",
        action: "bet",
        amountTo: 500,
        decisionSummary: "Bet for value.",
        usedFallback: false,
      }],
    }],
  };
}

function adminPublication(
  status: DecisionBranchPublication["status"] = "DRAFT",
): DecisionBranchPublication {
  const published = status !== "DRAFT";
  return {
    id: BRANCH_ID,
    handForkId: HAND_FORK_ID,
    status,
    slug: published ? "stable-branch" : null,
    titleZh: published ? "稳定决策分叉" : null,
    titleEn: published ? "Stable decision branch" : null,
    summaryZh: null,
    summaryEn: null,
    snapshotVersion: DECISION_BRANCH_SNAPSHOT_VERSION,
    snapshotHash: "a".repeat(64),
    snapshot: frozenSnapshot(),
    revision: 1,
    createdByAdminUserId: ADMIN_ID,
    publishedAt: published ? PUBLISHED_AT : null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
}

function publicBranch(): PublicDecisionBranchDto {
  return {
    id: BRANCH_ID,
    status: "PUBLISHED",
    slug: "stable-branch",
    titleZh: "稳定决策分叉",
    titleEn: "Stable decision branch",
    summaryZh: null,
    summaryEn: "Same spot, different models.",
    publicationRevision: 2,
    publishedAt: PUBLISHED_AT,
    snapshot: frozenSnapshot(),
  };
}

interface AppOptions {
  authenticated?: boolean;
  csrfValid?: boolean;
  decisionBranches?: Partial<DecisionBranchRouteService>;
}

async function appWith(options: AppOptions = {}) {
  const app = Fastify({ logger: false });
  apps.push(app);
  await app.register(fastifyCookie);
  const auth = {
    session: vi.fn(async (token?: string) => options.authenticated !== false && token === "session"
      ? { adminUserId: ADMIN_ID, email: "admin@localhost", expiresAt: "2026-08-21T00:00:00.000Z" }
      : null),
    verifyCsrf: vi.fn(async (session?: string, csrf?: string) => (
      options.csrfValid !== false && session === "session" && csrf === "csrf"
    )),
  } as unknown as AuthService;
  const decisionBranches = {
    createDraft: vi.fn(async () => ({ publication: adminPublication(), created: true })),
    listAdmin: vi.fn(async () => [] as DecisionBranchPublication[]),
    getAdmin: vi.fn(async () => adminPublication()),
    edit: vi.fn(async () => adminPublication()),
    publish: vi.fn(async () => adminPublication("PUBLISHED")),
    hide: vi.fn(async () => adminPublication("HIDDEN")),
    getPublicBySlug: vi.fn(async () => null),
    listPublic: vi.fn(async () => [] as PublicDecisionBranchDto[]),
    ...options.decisionBranches,
  } satisfies DecisionBranchRouteService;
  await registerDecisionBranchRoutes(app, {
    auth,
    config: {} as AppConfig,
    decisionBranches,
  });
  return { app, auth, decisionBranches };
}

const sessionCookie = { cookie: "arena_session=session; arena_csrf=csrf" };
const adminHeaders = { ...sessionCookie, "x-arena-csrf": "csrf" };

describe("decision branch routes", () => {
  it("requires an admin session for reads and prevents caching the denial", async () => {
    const { app, decisionBranches } = await appWith({ authenticated: false });
    const response = await app.inject({ method: "GET", url: "/api/admin/decision-branches" });

    expect(response.statusCode).toBe(401);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(decisionBranches.listAdmin).not.toHaveBeenCalled();
  });

  it.each([
    ["createDraft", "POST", "/api/admin/decision-branches", { sourceHandForkId: HAND_FORK_ID }],
    ["edit", "PATCH", `/api/admin/decision-branches/${BRANCH_ID}`, { expectedRevision: 1, titleEn: "Branch" }],
    ["publish", "POST", `/api/admin/decision-branches/${BRANCH_ID}/publish`, { expectedRevision: 1 }],
    ["hide", "POST", `/api/admin/decision-branches/${BRANCH_ID}/hide`, { expectedRevision: 1 }],
  ] as const)("requires CSRF before %s", async (methodName, method, url, payload) => {
    const { app, decisionBranches } = await appWith();
    const response = await app.inject({ method, url, headers: sessionCookie, payload });

    expect(response.statusCode).toBe(403);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(decisionBranches[methodName]).not.toHaveBeenCalled();
  });

  it.each([
    [
      "POST",
      "/api/admin/decision-branches",
      { sourceHandForkId: HAND_FORK_ID, status: "PUBLISHED" },
      "invalid_decision_branch_create_request",
      "createDraft",
    ],
    [
      "PATCH",
      `/api/admin/decision-branches/${BRANCH_ID}`,
      { expectedRevision: 1, titleEn: "Branch", snapshotHash: "private" },
      "invalid_decision_branch_editorial_update",
      "edit",
    ],
    [
      "POST",
      `/api/admin/decision-branches/${BRANCH_ID}/publish`,
      { expectedRevision: 1, createdByAdminUserId: ADMIN_ID },
      "invalid_decision_branch_publication",
      "publish",
    ],
    [
      "POST",
      `/api/admin/decision-branches/${BRANCH_ID}/hide`,
      { expectedRevision: 1, force: true },
      "invalid_decision_branch_hide_request",
      "hide",
    ],
  ] as const)("strictly validates %s %s", async (method, url, payload, errorCode, serviceMethod) => {
    const { app, decisionBranches } = await appWith();
    const response = await app.inject({ method, url, headers: adminHeaders, payload });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: errorCode });
    expect(decisionBranches[serviceMethod]).not.toHaveBeenCalled();
  });

  it.each([
    [true, 201],
    [false, 200],
  ] as const)("returns created=%s as HTTP %s", async (created, statusCode) => {
    const publication = adminPublication();
    const createDraft = vi.fn(async () => ({ publication, created }));
    const { app } = await appWith({ decisionBranches: { createDraft } });
    const response = await app.inject({
      method: "POST",
      url: "/api/admin/decision-branches",
      headers: adminHeaders,
      payload: { sourceHandForkId: HAND_FORK_ID },
    });

    expect(response.statusCode).toBe(statusCode);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({ decisionBranch: publication, created });
    expect(createDraft).toHaveBeenCalledWith(HAND_FORK_ID, ADMIN_ID);
  });

  it("passes only an editorial patch, revision, and authenticated admin to edit", async () => {
    const publication = adminPublication();
    const edit = vi.fn(async () => publication);
    const { app } = await appWith({ decisionBranches: { edit } });
    const response = await app.inject({
      method: "PATCH",
      url: `/api/admin/decision-branches/${BRANCH_ID}`,
      headers: adminHeaders,
      payload: { expectedRevision: 3, titleZh: "新标题", summaryEn: null },
    });

    expect(response.statusCode).toBe(200);
    expect(edit).toHaveBeenCalledWith(
      BRANCH_ID,
      { titleZh: "新标题", summaryEn: null },
      3,
      ADMIN_ID,
    );
  });

  it.each([
    [new DecisionBranchServiceError("NOT_FOUND", "missing"), 404, "decision_branch_not_found"],
    [new DecisionBranchServiceError("CONFLICT", "stale"), 409, "decision_branch_conflict"],
    [new DecisionBranchServiceError("SOURCE_UNAVAILABLE", "not complete"), 409, "decision_branch_source_unavailable"],
    [new DecisionBranchServiceError("IDENTITY_UNAVAILABLE", "no identity"), 409, "decision_branch_identity_unavailable"],
    [new DecisionBranchServiceError("UNSAFE_SOURCE", "unsafe"), 409, "decision_branch_source_unsafe"],
    [new DecisionBranchSlugConflictError(), 409, "decision_branch_slug_conflict"],
  ] as const)("maps a controlled mutation error to %s", async (error, statusCode, errorCode) => {
    const createDraft = vi.fn(async () => { throw error; });
    const { app } = await appWith({ decisionBranches: { createDraft } });
    const response = await app.inject({
      method: "POST",
      url: "/api/admin/decision-branches",
      headers: adminHeaders,
      payload: { sourceHandForkId: HAND_FORK_ID },
    });

    expect(response.statusCode).toBe(statusCode);
    expect(response.json()).toMatchObject({ error: errorCode });
  });

  it("does not expose an unexpected infrastructure error", async () => {
    const createDraft = vi.fn(async () => { throw new Error("private database connection detail"); });
    const { app } = await appWith({ decisionBranches: { createDraft } });
    const response = await app.inject({
      method: "POST",
      url: "/api/admin/decision-branches",
      headers: adminHeaders,
      payload: { sourceHandForkId: HAND_FORK_ID },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: "decision_branch_failed" });
    expect(response.body).not.toContain("private database connection detail");
  });

  it("returns a no-store 404 for malformed or unpublished public slugs", async () => {
    const getPublicBySlug = vi.fn(async () => null);
    const { app } = await appWith({ decisionBranches: { getPublicBySlug } });

    const malformed = await app.inject({
      method: "GET",
      url: "/api/public/decision-branches/not_valid",
    });
    expect(malformed.statusCode).toBe(404);
    expect(malformed.headers["cache-control"]).toBe("no-store");
    expect(getPublicBySlug).not.toHaveBeenCalled();

    const unpublished = await app.inject({
      method: "GET",
      url: "/api/public/decision-branches/hidden-branch",
    });
    expect(unpublished.statusCode).toBe(404);
    expect(unpublished.headers["cache-control"]).toBe("no-store");
    expect(getPublicBySlug).toHaveBeenCalledWith("hidden-branch");
  });

  it("serves only the allowlisted public DTO and never consults the admin reader", async () => {
    const branch = publicBranch();
    const getPublicBySlug = vi.fn(async () => branch);
    const getAdmin = vi.fn(async () => adminPublication("PUBLISHED"));
    const { app } = await appWith({ decisionBranches: { getPublicBySlug, getAdmin } });
    const response = await app.inject({
      method: "GET",
      url: "/api/public/decision-branches/Stable-Branch",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({ decisionBranch: branch });
    expect(getPublicBySlug).toHaveBeenCalledWith("stable-branch");
    expect(getAdmin).not.toHaveBeenCalled();
    expect(response.body).not.toMatch(/handForkId|snapshotHash|createdByAdminUserId|privatePayload/);
  });

  it("bounds the public list and forwards its validated limit", async () => {
    const branch = publicBranch();
    const listPublic = vi.fn(async () => [branch]);
    const { app } = await appWith({ decisionBranches: { listPublic } });

    const response = await app.inject({
      method: "GET",
      url: "/api/public/decision-branches?limit=24",
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({ decisionBranches: [branch] });
    expect(listPublic).toHaveBeenCalledWith(24);

    const invalid = await app.inject({
      method: "GET",
      url: "/api/public/decision-branches?limit=25",
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.headers["cache-control"]).toBe("no-store");
    expect(listPublic).toHaveBeenCalledTimes(1);
  });
});
