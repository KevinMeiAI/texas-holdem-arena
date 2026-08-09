import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { AuthService, type AdminSession } from "./auth-service.js";

const loginSchema = z.object({
  email: z.string().trim().min(3).max(320).refine(
    (value) => z.email().safeParse(value).success || /^[^@\s]+@localhost$/i.test(value),
    "A valid email or local administrator address is required",
  ),
  password: z.string().min(1),
}).strict();

const sessionCookie = "arena_session";
const csrfCookie = "arena_csrf";

export interface AdminAuthContext {
  auth: AuthService;
  config: AppConfig;
}

export async function requireAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
  context: AdminAuthContext,
  requireCsrf = false,
): Promise<AdminSession | null> {
  const sessionToken = request.cookies[sessionCookie];
  const session = await context.auth.session(sessionToken);
  if (!session) {
    await reply.code(401).send({ error: "authentication_required" });
    return null;
  }
  if (requireCsrf) {
    const csrfHeader = request.headers["x-arena-csrf"];
    const csrfToken = typeof csrfHeader === "string" ? csrfHeader : undefined;
    if (csrfToken !== request.cookies[csrfCookie]
      || !(await context.auth.verifyCsrf(sessionToken, csrfToken))) {
      await reply.code(403).send({ error: "invalid_csrf" });
      return null;
    }
  }
  return session;
}

export async function registerAuthRoutes(app: FastifyInstance, context: AdminAuthContext): Promise<void> {
  app.post("/api/auth/login", async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_login_payload" });
    const result = await context.auth.login(parsed.data.email, parsed.data.password);
    if (!result) return reply.code(401).send({ error: "invalid_credentials" });
    const options = {
      path: "/",
      sameSite: "strict" as const,
      secure: context.config.cookieSecure,
      maxAge: 7 * 86_400,
    };
    reply.setCookie(sessionCookie, result.sessionToken, { ...options, httpOnly: true });
    reply.setCookie(csrfCookie, result.csrfToken, { ...options, httpOnly: false });
    return { session: result.session, csrfToken: result.csrfToken };
  });

  app.get("/api/auth/session", async (request, reply) => {
    const session = await context.auth.session(request.cookies[sessionCookie]);
    return {
      session,
      csrfToken: session ? request.cookies[csrfCookie] ?? null : null,
    };
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const session = await requireAdmin(request, reply, context, true);
    if (!session) return;
    await context.auth.logout(request.cookies[sessionCookie]);
    reply.clearCookie(sessionCookie, { path: "/" });
    reply.clearCookie(csrfCookie, { path: "/" });
    return { ok: true };
  });
}
