import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  publicCompetitorProfileSchema,
  type PublicCompetitorProfile,
} from "../../../../packages/contracts/src/competitors.js";

const competitorIdSchema = z.string().uuid();

export interface CompetitorProfileRouteService {
  getProfile(competitorId: string): Promise<PublicCompetitorProfile | null>;
}

export async function registerCompetitorRoutes(
  app: FastifyInstance,
  context: { competitorProfiles: CompetitorProfileRouteService },
): Promise<void> {
  app.get<{ Params: { competitorId: string } }>(
    "/api/public/competitors/:competitorId",
    async (request, reply) => {
      const competitorId = competitorIdSchema.safeParse(request.params.competitorId);
      if (!competitorId.success) {
        return reply.code(404).send({ error: "competitor_not_found" });
      }

      let profile: PublicCompetitorProfile | null;
      try {
        profile = await context.competitorProfiles.getProfile(competitorId.data);
      } catch (error) {
        request.log.error(
          { err: error, competitorId: competitorId.data },
          "competitor profile query failed",
        );
        return reply.code(500).send({ error: "competitor_profile_unavailable" });
      }
      if (!profile) return reply.code(404).send({ error: "competitor_not_found" });

      const validated = publicCompetitorProfileSchema.safeParse(profile);
      if (!validated.success) {
        request.log.error(
          { competitorId: competitorId.data, issues: validated.error.issues },
          "competitor profile service returned an invalid public DTO",
        );
        return reply.code(500).send({ error: "competitor_profile_invalid" });
      }
      return { profile: validated.data };
    },
  );
}
