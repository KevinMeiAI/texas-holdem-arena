import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  momentEditorialPatchSchema,
  type PublicMomentDto,
} from "../../../../../packages/contracts/src/moments.js";
import { requireAdmin, type AdminAuthContext } from "../../auth/routes.js";
import {
  ArenaService,
  TournamentMomentInputError,
  type ArenaBroadcastReplayState,
} from "../arena-service.js";
import type { BroadcastView } from "../broadcast-view.js";
import { MomentService, MomentServiceError } from "./moment-service.js";

const uuidSchema = z.string().uuid();
const slugSchema = z.string().trim().toLowerCase()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .max(120);
const emptyBodySchema = z.object({}).strict();
const expectedRevisionSchema = z.number().int().positive().nullable();

export const momentPublicationRequestSchema = momentEditorialPatchSchema.extend({
  expectedRevision: expectedRevisionSchema,
});

export const momentEditorialUpdateSchema = momentPublicationRequestSchema.refine(
  (patch) => Object.keys(patch).some((key) => key !== "expectedRevision"),
  "At least one editorial field is required",
);

const momentHideRequestSchema = z.object({ expectedRevision: expectedRevisionSchema }).strict();

interface MomentRouteContext extends AdminAuthContext {
  arena: ArenaService;
  moments: MomentService;
}

interface PgErrorLike {
  code?: unknown;
  constraint?: unknown;
}

function isSlugConflict(error: unknown): boolean {
  const candidate = error as PgErrorLike | null;
  return candidate?.code === "23505" && candidate.constraint === "moment_publications_slug";
}

async function sendMomentMutationError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
) {
  if (error instanceof MomentServiceError) {
    return reply.code(error.code === "NOT_FOUND" ? 404 : 409).send({
      error: error.code === "NOT_FOUND" ? "moment_not_found" : "moment_publication_conflict",
      message: error.message,
    });
  }
  if (isSlugConflict(error)) {
    return reply.code(409).send({
      error: "moment_slug_conflict",
      message: "This moment URL is already in use",
    });
  }
  request.log.error({ err: error }, "moment publication mutation failed");
  return reply.code(500).send({ error: "moment_publication_failed" });
}

function nearestFrame(
  replay: ArenaBroadcastReplayState,
  moment: PublicMomentDto,
  sequence: number,
  latestSequence: number,
): BroadcastView | null {
  const frames = replay.timeline.filter((frame) => (
    frame.handNo === moment.handNo && frame.sequence <= latestSequence
  ));
  return frames.filter((frame) => frame.sequence <= sequence).at(-1)
    ?? frames.find((frame) => frame.sequence >= sequence)
    ?? null;
}

export function momentReplayWindow(
  replay: ArenaBroadcastReplayState,
  moment: PublicMomentDto,
) {
  const start = moment.playbackStartSequence;
  const end = moment.playbackEndSequence;
  return {
    state: replay.state,
    timeline: replay.timeline.filter((frame) => frame.sequence >= start && frame.sequence <= end),
    events: replay.events.filter((event) => event.sequence >= start && event.sequence <= end),
    playerBrands: { ...replay.playerBrands },
    initialFrame: nearestFrame(replay, moment, start, end),
    coverFrame: nearestFrame(replay, moment, moment.coverSequence, moment.facts.endSequence),
    initialEliminatedPlayerIds: [...new Set(replay.events.flatMap((event) => (
      event.sequence < start && event.type === "PLAYER_ELIMINATED" && event.actorId
        ? [event.actorId]
        : []
    )))],
  };
}

export async function registerMomentRoutes(
  app: FastifyInstance,
  context: MomentRouteContext,
): Promise<void> {
  app.post<{ Params: { id: string } }>(
    "/api/admin/tournaments/:id/moments/generate",
    async (request, reply) => {
      const admin = await requireAdmin(request, reply, context, true);
      if (!admin) return;
      const tournamentId = uuidSchema.safeParse(request.params.id);
      const body = emptyBodySchema.safeParse(request.body ?? {});
      if (!tournamentId.success || !body.success) {
        return reply.code(400).send({ error: "invalid_moment_generation_request" });
      }
      try {
        const input = await context.arena.momentDetectionInput(tournamentId.data);
        if (!input) return reply.code(404).send({ error: "tournament_not_found" });
        const moments = await context.moments.rebuild(input, admin.adminUserId);
        return { moments, generatedCount: moments.length };
      } catch (error) {
        if (error instanceof TournamentMomentInputError) {
          return reply.code(409).send({
            error: "tournament_not_completed",
            status: error.tournamentStatus,
            message: error.message,
          });
        }
        request.log.error({ err: error, tournamentId: tournamentId.data }, "moment generation failed");
        return reply.code(500).send({ error: "moment_generation_failed" });
      }
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/admin/tournaments/:id/moments",
    async (request, reply) => {
      if (!(await requireAdmin(request, reply, context, false))) return;
      const tournamentId = uuidSchema.safeParse(request.params.id);
      if (!tournamentId.success) return reply.code(400).send({ error: "invalid_tournament_id" });
      if (!(await context.arena.publicState(tournamentId.data))) {
        return reply.code(404).send({ error: "tournament_not_found" });
      }
      return { moments: await context.moments.listAdmin(tournamentId.data) };
    },
  );

  app.patch<{ Params: { id: string } }>("/api/admin/moments/:id", async (request, reply) => {
    const admin = await requireAdmin(request, reply, context, true);
    if (!admin) return;
    const momentId = uuidSchema.safeParse(request.params.id);
    const patch = momentEditorialUpdateSchema.safeParse(request.body ?? {});
    if (!momentId.success || !patch.success) {
      return reply.code(400).send({
        error: "invalid_moment_editorial_update",
        ...(!patch.success ? { issues: patch.error.issues } : {}),
      });
    }
    try {
      const { expectedRevision, ...editorialPatch } = patch.data;
      const moment = await context.moments.editPublication(
        momentId.data,
        editorialPatch,
        expectedRevision,
        admin.adminUserId,
      );
      return { moment };
    } catch (error) {
      return sendMomentMutationError(request, reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/admin/moments/:id/publish", async (request, reply) => {
    const admin = await requireAdmin(request, reply, context, true);
    if (!admin) return;
    const momentId = uuidSchema.safeParse(request.params.id);
    const patch = momentPublicationRequestSchema.safeParse(request.body ?? {});
    if (!momentId.success || !patch.success) {
      return reply.code(400).send({
        error: "invalid_moment_publication",
        ...(!patch.success ? { issues: patch.error.issues } : {}),
      });
    }
    try {
      const { expectedRevision, ...editorialPatch } = patch.data;
      const moment = await context.moments.publish(
        momentId.data,
        editorialPatch,
        expectedRevision,
        admin.adminUserId,
      );
      return { moment };
    } catch (error) {
      return sendMomentMutationError(request, reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/admin/moments/:id/hide", async (request, reply) => {
    const admin = await requireAdmin(request, reply, context, true);
    if (!admin) return;
    const momentId = uuidSchema.safeParse(request.params.id);
    const body = momentHideRequestSchema.safeParse(request.body ?? {});
    if (!momentId.success || !body.success) {
      return reply.code(400).send({ error: "invalid_moment_hide_request" });
    }
    try {
      const moment = await context.moments.hide(
        momentId.data,
        body.data.expectedRevision,
        admin.adminUserId,
      );
      return { moment };
    } catch (error) {
      return sendMomentMutationError(request, reply, error);
    }
  });

  app.get<{ Params: { id: string } }>(
    "/api/public/tournaments/:id/moments",
    async (request, reply) => {
      const tournamentId = uuidSchema.safeParse(request.params.id);
      if (!tournamentId.success) return reply.code(400).send({ error: "invalid_tournament_id" });
      if (!(await context.arena.publicState(tournamentId.data))) {
        return reply.code(404).send({ error: "tournament_not_found" });
      }
      return { moments: await context.moments.listPublic(tournamentId.data) };
    },
  );

  app.get<{ Params: { slug: string } }>("/api/public/moments/:slug", async (request, reply) => {
    const slug = slugSchema.safeParse(request.params.slug);
    if (!slug.success) return reply.code(404).send({ error: "moment_not_found" });
    const moment = await context.moments.getPublicBySlug(slug.data);
    return moment ? { moment } : reply.code(404).send({ error: "moment_not_found" });
  });

  app.get<{ Params: { slug: string } }>("/api/public/moments/:slug/replay", async (request, reply) => {
    const slug = slugSchema.safeParse(request.params.slug);
    if (!slug.success) return reply.code(404).send({ error: "moment_not_found" });
    const moment = await context.moments.getPublicBySlug(slug.data);
    if (!moment) return reply.code(404).send({ error: "moment_not_found" });
    const replay = await context.arena.broadcastReplayState(moment.tournamentId);
    if (!replay) return reply.code(404).send({ error: "tournament_not_found" });
    return { moment, ...momentReplayWindow(replay, moment) };
  });
}
