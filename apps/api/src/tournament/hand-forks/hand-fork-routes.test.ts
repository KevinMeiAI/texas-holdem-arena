import fastifyCookie from "@fastify/cookie";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AdminHandFork,
  HandForkSourceCandidate,
} from "../../../../../packages/contracts/src/index.js";
import type { AuthService } from "../../auth/auth-service.js";
import type { AppConfig } from "../../config.js";
import { HandForkPersistenceConflictError } from "./hand-fork-repository.js";
import {
  registerHandForkRoutes,
  type HandForkRouteCatalog,
  type HandForkRouteService,
} from "./hand-fork-routes.js";
import { HandForkSourceCatalogError } from "./hand-fork-source-catalog.js";
import { HandForkSourceError } from "./hand-fork-source.js";
import {
  HandForkServiceStoppedError,
  HandForkTargetUnavailableError,
} from "./hand-fork-service.js";

const TOURNAMENT_ID = "11111111-1111-4111-8111-111111111111";
const DECISION_ID = "22222222-2222-4222-8222-222222222222";
const MODEL_ONE = "33333333-3333-4333-8333-333333333333";
const MODEL_TWO = "44444444-4444-4444-8444-444444444444";
const FORK_ID = "55555555-5555-4555-8555-555555555555";
const ADMIN_ID = "66666666-6666-4666-8666-666666666666";
const CLIENT_REQUEST_ID = "77777777-7777-4777-8777-777777777777";

const apps: ReturnType<typeof Fastify>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function handFork(status: AdminHandFork["status"] = "QUEUED"): AdminHandFork {
  return { id: FORK_ID, status } as AdminHandFork;
}

function createBody() {
  return {
    clientRequestId: CLIENT_REQUEST_ID,
    sourceDecisionId: DECISION_ID,
    modelConfigIds: [MODEL_ONE, MODEL_TWO],
    sampleCount: 10,
    timeoutMs: 180_000,
    maxParallelTargets: 2,
  };
}

interface AppOptions {
  authenticated?: boolean;
  csrfValid?: boolean;
  auditQuery?: ReturnType<typeof vi.fn>;
  catalog?: Partial<HandForkRouteCatalog>;
  handForks?: Partial<HandForkRouteService>;
}

async function appWith(options: AppOptions = {}) {
  const app = Fastify();
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
  const query = options.auditQuery
    ?? vi.fn(async (_sql: string, _parameters?: unknown[]) => ({ rowCount: 1, rows: [] }));
  const catalog = {
    list: vi.fn(async () => [] as HandForkSourceCandidate[]),
    ...options.catalog,
  } satisfies HandForkRouteCatalog;
  const handForks = {
    create: vi.fn(async () => handFork()),
    list: vi.fn(async () => [] as AdminHandFork[]),
    get: vi.fn(async () => handFork()),
    cancel: vi.fn(async () => handFork("CANCELLED")),
    ...options.handForks,
  } satisfies HandForkRouteService;
  await registerHandForkRoutes(app, {
    auth,
    config: {} as AppConfig,
    pool: { query } as never,
    catalog,
    handForks,
  });
  return { app, auth, query, catalog, handForks };
}

const sessionCookie = { cookie: "arena_session=session; arena_csrf=csrf" };
const adminHeaders = { ...sessionCookie, "x-arena-csrf": "csrf" };

describe("hand fork admin routes", () => {
  it("requires an admin session for read endpoints and still prevents caching", async () => {
    const { app, handForks } = await appWith({ authenticated: false });
    const response = await app.inject({ method: "GET", url: "/api/admin/hand-forks" });

    expect(response.statusCode).toBe(401);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(handForks.list).not.toHaveBeenCalled();
  });

  it.each([
    ["create", "/api/admin/hand-forks", createBody()],
    ["cancel", `/api/admin/hand-forks/${FORK_ID}/cancel`, {}],
  ])("requires CSRF before %s mutation", async (methodName, url, payload) => {
    const { app, handForks, query } = await appWith();
    const response = await app.inject({ method: "POST", url, headers: sessionCookie, payload });

    expect(response.statusCode).toBe(403);
    expect(handForks[methodName as "create" | "cancel"]).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it("validates source params before consulting the catalog", async () => {
    const { app, catalog } = await appWith();
    const response = await app.inject({
      method: "GET",
      url: "/api/admin/tournaments/not-a-uuid/hands/0/hand-fork-sources",
      headers: sessionCookie,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid_hand_fork_source_query" });
    expect(catalog.list).not.toHaveBeenCalled();
  });

  it.each([
    ["TOURNAMENT_NOT_FOUND", "tournament_not_found"],
    ["HAND_NOT_FOUND", "hand_not_found"],
  ] as const)("maps catalog %s without exposing its message", async (code, publicCode) => {
    const list = vi.fn(async () => {
      throw new HandForkSourceCatalogError(code, "private database detail");
    });
    const { app } = await appWith({ catalog: { list } });
    const response = await app.inject({
      method: "GET",
      url: `/api/admin/tournaments/${TOURNAMENT_ID}/hands/7/hand-fork-sources`,
      headers: sessionCookie,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: publicCode });
    expect(response.body).not.toContain("private database detail");
  });

  it("returns source candidates with no-store after authenticated discovery", async () => {
    const source: HandForkSourceCandidate = {
      availability: "UNAVAILABLE",
      decisionId: DECISION_ID,
      playerId: "seat-1",
      expectedAggregateVersion: 12,
      reasonCode: "DECISION_AUDIT_INCOMPLETE",
    };
    const list = vi.fn(async () => [source]);
    const { app } = await appWith({ catalog: { list } });
    const response = await app.inject({
      method: "GET",
      url: `/api/admin/tournaments/${TOURNAMENT_ID}/hands/7/hand-fork-sources`,
      headers: sessionCookie,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({ sources: [source] });
    expect(list).toHaveBeenCalledWith(TOURNAMENT_ID, 7);
  });

  it("rejects malformed create input before service execution", async () => {
    const { app, handForks, query } = await appWith();
    const response = await app.inject({
      method: "POST",
      url: "/api/admin/hand-forks",
      headers: adminHeaders,
      payload: { ...createBody(), modelConfigIds: [MODEL_ONE, MODEL_ONE] },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid_hand_fork_request" });
    expect(handForks.create).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it("rejects unexpected cancel payload fields", async () => {
    const { app, handForks, query } = await appWith();
    const response = await app.inject({
      method: "POST",
      url: `/api/admin/hand-forks/${FORK_ID}/cancel`,
      headers: adminHeaders,
      payload: { force: true },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid_hand_fork_request" });
    expect(handForks.cancel).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it("creates asynchronously, passes admin identity, and audits only safe metadata", async () => {
    const created = handFork();
    const create = vi.fn(async () => created);
    const { app, query } = await appWith({ handForks: { create } });
    const response = await app.inject({
      method: "POST",
      url: "/api/admin/hand-forks",
      headers: adminHeaders,
      payload: createBody(),
    });

    expect(response.statusCode).toBe(202);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({ handFork: created });
    expect(create).toHaveBeenCalledWith(createBody(), ADMIN_ID);
    expect(query).toHaveBeenCalledTimes(1);
    expect(String(query.mock.calls[0]?.[0])).toContain("'hand_fork'");
    const auditParameters = query.mock.calls[0]?.[1] ?? [];
    expect(auditParameters.slice(1, 4)).toEqual([ADMIN_ID, "hand_fork.create", FORK_ID]);
    const metadata = String(auditParameters[4]);
    expect(metadata).toContain(DECISION_ID);
    expect(metadata).not.toMatch(/hole|prompt|api.?key|response/i);
  });

  it("keeps a successful create response when the post-commit audit write fails", async () => {
    const created = handFork();
    const query = vi.fn(async () => {
      throw new Error("audit database unavailable");
    });
    const { app, handForks } = await appWith({
      auditQuery: query,
      handForks: { create: vi.fn(async () => created) },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/admin/hand-forks",
      headers: adminHeaders,
      payload: createBody(),
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ handFork: created });
    expect(handForks.create).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["SOURCE_NOT_FOUND", 404, { error: "source_decision_not_found" }],
    ["SOURCE_CHAIN_MISMATCH", 409, {
      error: "hand_fork_source_unavailable",
      reasonCode: "SOURCE_CHAIN_MISMATCH",
    }],
  ] as const)("maps source error %s safely", async (code, status, body) => {
    const create = vi.fn(async () => {
      throw new HandForkSourceError(code, "decrypted source detail");
    });
    const { app } = await appWith({ handForks: { create } });
    const response = await app.inject({
      method: "POST",
      url: "/api/admin/hand-forks",
      headers: adminHeaders,
      payload: createBody(),
    });

    expect(response.statusCode).toBe(status);
    expect(response.json()).toEqual(body);
    expect(response.body).not.toContain("decrypted source detail");
  });

  it.each([
    ["target unavailable", () => new HandForkTargetUnavailableError(MODEL_ONE), "hand_fork_target_unavailable"],
    ["service stopped", () => new HandForkServiceStoppedError(), "hand_fork_conflict"],
  ] as const)("maps stable service error %s to 409", async (_label, makeError, publicCode) => {
    const create = vi.fn(async () => {
      throw makeError();
    });
    const { app } = await appWith({ handForks: { create } });
    const response = await app.inject({
      method: "POST",
      url: "/api/admin/hand-forks",
      headers: adminHeaders,
      payload: createBody(),
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: publicCode });
    expect(response.body).not.toContain(MODEL_ONE);
  });

  it("maps persistence fencing to conflict and unexpected errors to a generic 500", async () => {
    const conflictApp = await appWith({
      handForks: {
        create: vi.fn(async () => {
          throw new HandForkPersistenceConflictError("revision hash mismatch");
        }),
      },
    });
    const conflict = await conflictApp.app.inject({
      method: "POST",
      url: "/api/admin/hand-forks",
      headers: adminHeaders,
      payload: createBody(),
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({ error: "hand_fork_conflict" });

    const failedApp = await appWith({
      handForks: { list: vi.fn(async () => { throw new Error("postgres password leaked"); }) },
    });
    const failed = await failedApp.app.inject({
      method: "GET",
      url: "/api/admin/hand-forks",
      headers: sessionCookie,
    });
    expect(failed.statusCode).toBe(500);
    expect(failed.json()).toEqual({ error: "hand_fork_failed" });
    expect(failed.body).not.toContain("password");
  });

  it("validates list limits and returns a no-store summary list", async () => {
    const list = vi.fn(async () => [handFork("COMPLETED")]);
    const { app } = await appWith({ handForks: { list } });
    const invalid = await app.inject({
      method: "GET",
      url: "/api/admin/hand-forks?limit=201",
      headers: sessionCookie,
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toEqual({ error: "invalid_limit" });
    expect(list).not.toHaveBeenCalled();

    const valid = await app.inject({
      method: "GET",
      url: "/api/admin/hand-forks?limit=25",
      headers: sessionCookie,
    });
    expect(valid.statusCode).toBe(200);
    expect(valid.headers["cache-control"]).toBe("no-store");
    expect(valid.json()).toEqual({ handForks: [handFork("COMPLETED")] });
    expect(list).toHaveBeenCalledWith(25);
  });

  it("returns 400 for an invalid id and 404 for a missing detail", async () => {
    const get = vi.fn(async () => null);
    const { app } = await appWith({ handForks: { get } });
    const invalid = await app.inject({
      method: "GET",
      url: "/api/admin/hand-forks/not-a-uuid",
      headers: sessionCookie,
    });
    expect(invalid.statusCode).toBe(400);
    expect(get).not.toHaveBeenCalled();

    const missing = await app.inject({
      method: "GET",
      url: `/api/admin/hand-forks/${FORK_ID}`,
      headers: sessionCookie,
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "hand_fork_not_found" });
  });

  it("cancels idempotently through the service and audits the resulting status", async () => {
    const cancelled = handFork("CANCELLED");
    const cancel = vi.fn(async () => cancelled);
    const { app, query } = await appWith({ handForks: { cancel } });
    const response = await app.inject({
      method: "POST",
      url: `/api/admin/hand-forks/${FORK_ID}/cancel`,
      headers: adminHeaders,
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ handFork: cancelled });
    expect(cancel).toHaveBeenCalledWith(FORK_ID);
    expect(query.mock.calls[0]?.[1]).toEqual(expect.arrayContaining([
      ADMIN_ID,
      "hand_fork.cancel",
      FORK_ID,
      JSON.stringify({ status: "CANCELLED" }),
    ]));
  });
});
