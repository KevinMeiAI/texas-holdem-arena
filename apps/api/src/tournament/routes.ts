import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { requireAdmin, type AdminAuthContext } from "../auth/routes.js";
import { ArenaService } from "./arena-service.js";

const blindLevelSchema = z.object({
  smallBlind: z.number().int().positive(),
  bigBlind: z.number().int().positive(),
  bigBlindAnte: z.number().int().nonnegative(),
}).strict().refine((level) => level.smallBlind <= level.bigBlind, "smallBlind must not exceed bigBlind");

const createTournamentSchema = z.object({
  name: z.string().trim().min(1).max(120),
  modelConfigIds: z.array(z.string().uuid()).min(2).max(9).refine(
    (ids) => new Set(ids).size === ids.length,
    "Model configurations must be unique",
  ),
  sharedStrategyPrompt: z.string().max(20_000).default(""),
  initialStack: z.number().int().min(100).max(10_000_000).default(20_000),
  handsPerLevel: z.number().int().min(1).max(1_000).default(10),
  blindLevels: z.array(blindLevelSchema).min(1).max(100).default([
    { smallBlind: 100, bigBlind: 200, bigBlindAnte: 0 },
    { smallBlind: 150, bigBlind: 300, bigBlindAnte: 0 },
    { smallBlind: 200, bigBlind: 400, bigBlindAnte: 400 },
    { smallBlind: 300, bigBlind: 600, bigBlindAnte: 600 },
    { smallBlind: 400, bigBlind: 800, bigBlindAnte: 800 },
    { smallBlind: 600, bigBlind: 1200, bigBlindAnte: 1200 },
  ]),
  runItTwiceEnabled: z.boolean().default(true),
}).strict();

async function audit(
  pool: Pool,
  adminUserId: string,
  action: string,
  tournamentId: string,
): Promise<void> {
  await pool.query(
    `insert into audit_events (id, admin_user_id, action, target_type, target_id)
     values ($1, $2, $3, 'tournament', $4)`,
    [randomUUID(), adminUserId, action, tournamentId],
  );
}

export async function registerTournamentRoutes(
  app: FastifyInstance,
  context: AdminAuthContext & { pool: Pool; arena: ArenaService },
): Promise<void> {
  app.post("/api/admin/tournaments", async (request, reply) => {
    const admin = await requireAdmin(request, reply, context, true);
    if (!admin) return;
    const parsed = createTournamentSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_tournament", issues: parsed.error.issues });
    }
    try {
      const runtime = await context.arena.create(parsed.data);
      await audit(context.pool, admin.adminUserId, "tournament.create_and_start", runtime.tournamentId);
      return reply.code(201).send({
        tournamentId: runtime.tournamentId,
        state: await context.arena.publicState(runtime.tournamentId),
      });
    } catch (error) {
      return reply.code(409).send({
        error: "tournament_start_failed",
        message: error instanceof Error ? error.message : "Unable to start tournament",
      });
    }
  });

  for (const action of ["pause", "resume", "cancel"] as const) {
    app.post<{ Params: { id: string } }>(`/api/admin/tournaments/:id/${action}`, async (request, reply) => {
      const admin = await requireAdmin(request, reply, context, true);
      if (!admin) return;
      try {
        await context.arena[action](request.params.id);
        await audit(context.pool, admin.adminUserId, `tournament.${action}`, request.params.id);
        return { accepted: true };
      } catch (error) {
        return reply.code(409).send({
          error: `tournament_${action}_failed`,
          message: error instanceof Error ? error.message : "Tournament command failed",
        });
      }
    });
  }

  app.get("/api/public/live", async () => ({ state: await context.arena.publicState() }));
  app.get("/api/public/tournaments", async () => ({ tournaments: await context.arena.listTournaments() }));
  app.get<{ Params: { id: string } }>("/api/public/tournaments/:id", async (request, reply) => {
    const state = await context.arena.publicState(request.params.id);
    return state ? { state } : reply.code(404).send({ error: "tournament_not_found" });
  });
  app.get<{ Params: { id: string } }>("/api/public/tournaments/:id/hands", async (request) => {
    const events = await context.arena.projectedEvents(request.params.id, "SPECTATOR_REPLAY");
    const hands = new Map<number, { handNo: number; eventCount: number; completed: boolean }>();
    for (const event of events) {
      if (event.handNo === null) continue;
      const hand = hands.get(event.handNo) ?? { handNo: event.handNo, eventCount: 0, completed: false };
      hand.eventCount += 1;
      if (event.type === "HAND_COMPLETED") hand.completed = true;
      hands.set(event.handNo, hand);
    }
    return { hands: [...hands.values()].sort((left, right) => left.handNo - right.handNo) };
  });
  app.get<{ Params: { id: string; handNo: string } }>(
    "/api/public/tournaments/:id/hands/:handNo/replay",
    async (request, reply) => {
      const handNo = Number(request.params.handNo);
      if (!Number.isSafeInteger(handNo) || handNo < 1) {
        return reply.code(400).send({ error: "invalid_hand_no" });
      }
      const events = (await context.arena.projectedEvents(request.params.id, "SPECTATOR_REPLAY"))
        .filter((event) => event.handNo === handNo);
      return events.length > 0 ? { events } : reply.code(404).send({ error: "hand_not_found" });
    },
  );
  app.get("/api/public/leaderboard", async () => ({ leaderboard: await context.arena.leaderboard() }));
  app.get<{ Params: { id: string } }>("/api/public/tournaments/:id/fairness", async (request) => (
    context.arena.fairness(request.params.id)
  ));

  app.get<{ Params: { id: string }; Querystring: { tail?: string } }>("/api/public/tournaments/:id/events", async (request, reply) => {
    if (!(await context.arena.publicState(request.params.id))) {
      return reply.code(404).send({ error: "tournament_not_found" });
    }
    const header = request.headers["last-event-id"];
    const requestedCursor = typeof header === "string" ? Number(header) : 0;
    let cursor = Number.isSafeInteger(requestedCursor) && requestedCursor >= 0 ? requestedCursor : 0;
    if (typeof header !== "string" && request.query.tail !== undefined) {
      const requestedTail = Number(request.query.tail);
      const tail = Number.isSafeInteger(requestedTail) ? Math.min(Math.max(requestedTail, 1), 500) : 120;
      const latest = await context.arena.latestEventSequence(request.params.id);
      if (latest !== null) cursor = Math.max(0, latest - tail);
    }
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    let sending = false;
    let eventTimer: NodeJS.Timeout | undefined;
    let heartbeat: NodeJS.Timeout | undefined;
    const closeStream = () => {
      if (eventTimer) clearInterval(eventTimer);
      if (heartbeat) clearInterval(heartbeat);
      eventTimer = undefined;
      heartbeat = undefined;
    };
    const send = async () => {
      if (sending || reply.raw.destroyed) return;
      sending = true;
      try {
        const events = await context.arena.projectedEvents(request.params.id, "SPECTATOR_LIVE", cursor);
        for (const event of events) {
          cursor = event.sequence;
          reply.raw.write(`id: ${event.sequence}\nevent: arena\ndata: ${JSON.stringify(event)}\n\n`);
        }
      } catch (error) {
        request.log.error({ err: error, tournamentId: request.params.id }, "SSE projection failed");
        closeStream();
        if (!reply.raw.destroyed) {
          reply.raw.write("event: error\ndata: {\"error\":\"stream_unavailable\"}\n\n");
          reply.raw.end();
        }
      } finally {
        sending = false;
      }
    };
    await send();
    if (reply.raw.destroyed || reply.raw.writableEnded) return;
    eventTimer = setInterval(() => void send(), 500);
    heartbeat = setInterval(() => {
      if (!reply.raw.destroyed) reply.raw.write(": heartbeat\n\n");
    }, 15_000);
    request.raw.once("close", closeStream);
  });
}
