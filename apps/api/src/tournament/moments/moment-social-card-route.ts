import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  MOMENT_SOCIAL_CARD_RENDERER_VERSION,
  MOMENT_SOCIAL_CARD_URL_VERSION,
  type PublicMomentDto,
  type SocialCardProjection,
} from "../../../../../packages/contracts/src/index.js";
import type {
  ArenaService,
  PublicTournamentIdentityContext,
} from "../arena-service.js";
import type { MomentService } from "./moment-service.js";
import {
  buildSocialCardProjection,
  type SocialCardLocale,
} from "./moment-social-card-projection.js";
import type { RenderedMomentSocialCard } from "./moment-social-card-renderer.js";
import { renderMomentSocialCardOffThread } from "./moment-social-card-worker-client.js";

interface PublicMomentReader {
  getPublicBySlug(slug: string): Promise<PublicMomentDto | null>;
}

interface SocialCardArenaReader {
  publicIdentityContext(tournamentId: string): Promise<PublicTournamentIdentityContext | null>;
}

export interface MomentSocialCardRouteContext {
  moments: Pick<MomentService, "getPublicBySlug"> | PublicMomentReader;
  arena: Pick<ArenaService, "publicIdentityContext"> | SocialCardArenaReader;
}

export interface MomentSocialCardRouteDependencies {
  project?: typeof buildSocialCardProjection;
  render?: (projection: SocialCardProjection) => RenderedMomentSocialCard | Promise<RenderedMomentSocialCard>;
}

interface CachedSocialCard {
  png: Buffer;
  etag: string;
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const REVISION = /^r([1-9]\d*)$/;
const MAX_CACHE_ENTRIES = 24;
const MAX_RENDER_QUEUE = 8;

class SocialCardRenderBusyError extends Error {}

class SocialCardRenderQueue {
  #active = 0;
  readonly #waiting: Array<() => void> = [];

  async run<Result>(task: () => Promise<Result>): Promise<Result> {
    if (this.#active >= 1) {
      if (this.#waiting.length >= MAX_RENDER_QUEUE) throw new SocialCardRenderBusyError("Social card renderer is busy");
      await new Promise<void>((resolve) => this.#waiting.push(resolve));
    }
    this.#active += 1;
    try {
      return await task();
    } finally {
      this.#active -= 1;
      this.#waiting.shift()?.();
    }
  }
}

function cacheKey(moment: PublicMomentDto, locale: SocialCardLocale): string {
  return [
    moment.id,
    `r${moment.publicationRevision}`,
    MOMENT_SOCIAL_CARD_RENDERER_VERSION,
    locale,
  ].join(":");
}

function remember(
  cache: Map<string, CachedSocialCard>,
  key: string,
  artifact: CachedSocialCard,
): CachedSocialCard {
  cache.delete(key);
  cache.set(key, artifact);
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return artifact;
}

function cachedArtifact(rendered: RenderedMomentSocialCard): CachedSocialCard {
  // Use the actual bytes as the authority. This remains correct for an
  // injected/test renderer and protects against a stale renderer digest.
  const digest = createHash("sha256").update(rendered.png).digest("hex");
  return { png: rendered.png, etag: `"${digest}"` };
}

function currentRevision(moment: PublicMomentDto, requestedRevision: string): boolean {
  const match = REVISION.exec(requestedRevision);
  if (!match) return false;
  const revision = Number(match[1]);
  return Number.isSafeInteger(revision) && revision === moment.publicationRevision;
}

function localeFromPath(value: string): SocialCardLocale | null {
  if (value === "zh") return "zh-CN";
  if (value === "en") return "en";
  return null;
}

function etagMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  return header.split(",").some((candidate) => {
    const normalized = candidate.trim();
    return normalized === "*" || normalized === etag || normalized.replace(/^W\//, "") === etag;
  });
}

function samePublishedRevision(before: PublicMomentDto, after: PublicMomentDto | null): boolean {
  return after !== null
    && after.id === before.id
    && after.slug === before.slug
    && after.publicationRevision === before.publicationRevision;
}

export async function registerMomentSocialCardRoutes(
  app: FastifyInstance,
  context: MomentSocialCardRouteContext,
  dependencies: MomentSocialCardRouteDependencies = {},
): Promise<void> {
  const project = dependencies.project ?? buildSocialCardProjection;
  const render = dependencies.render ?? renderMomentSocialCardOffThread;
  const renderQueue = new SocialCardRenderQueue();
  const cache = new Map<string, CachedSocialCard>();
  const inFlight = new Map<string, Promise<CachedSocialCard>>();

  app.get<{
    Params: { slug: string; version: string; revision: string; locale: string };
  }>(
    "/api/public/moments/:slug/social-card/:version/:revision/:locale.png",
    async (request, reply) => {
      const { slug, version, revision } = request.params;
      const locale = localeFromPath(request.params.locale);
      if (!SLUG.test(slug) || version !== MOMENT_SOCIAL_CARD_URL_VERSION || !REVISION.test(revision) || !locale) {
        return reply.code(404).header("Cache-Control", "no-store").send({ error: "moment_social_card_not_found" });
      }
      const moment = await context.moments.getPublicBySlug(slug);
      if (!moment || !currentRevision(moment, revision)) {
        return reply.code(404).header("Cache-Control", "no-store").send({ error: "moment_social_card_not_found" });
      }
      const key = cacheKey(moment, locale);
      let artifact = cache.get(key);
      if (artifact) artifact = remember(cache, key, artifact);
      if (!artifact && request.method === "HEAD") {
        const current = await context.moments.getPublicBySlug(slug);
        if (!samePublishedRevision(moment, current)) {
          return reply.code(404).header("Cache-Control", "no-store").send({ error: "moment_social_card_not_found" });
        }
        // The bytes do not exist yet, so their eventual Content-Length is
        // unknown. Fastify's empty send would incorrectly emit length 0;
        // write a valid header-only response and omit the field instead.
        reply.hijack();
        reply.raw.statusCode = 200;
        reply.raw.setHeader("Cache-Control", "public, max-age=0, must-revalidate");
        reply.raw.setHeader("X-Content-Type-Options", "nosniff");
        reply.raw.setHeader("Content-Type", "image/png");
        reply.raw.removeHeader("Content-Length");
        reply.raw.end();
        return reply;
      }
      if (!artifact) {
        let task = inFlight.get(key);
        if (!task) {
          task = (async () => {
            const identity = await context.arena.publicIdentityContext(moment.tournamentId);
            if (!identity) throw new Error("Moment social card source is unavailable");
            const projection: SocialCardProjection = project({ moment, identity, locale });
            const rendered = await renderQueue.run(async () => render(projection));
            return cachedArtifact(rendered);
          })().finally(() => {
            inFlight.delete(key);
          });
          inFlight.set(key, task);
        }
        try {
          artifact = remember(cache, key, await task);
        } catch (error) {
          request.log.error({ err: error, slug, revision, locale }, "moment social card render failed");
          if (error instanceof SocialCardRenderBusyError) {
            return reply
              .code(503)
              .header("Cache-Control", "no-store")
              .header("Retry-After", "2")
              .send({ error: "moment_social_card_busy" });
          }
          return reply.code(500).header("Cache-Control", "no-store").send({ error: "moment_social_card_failed" });
        }
      }

      // Re-read publication state after a potentially expensive render. A
      // hide/edit racing the request must never expose bytes under the old URL.
      const current = await context.moments.getPublicBySlug(slug);
      if (!samePublishedRevision(moment, current)) {
        cache.delete(key);
        return reply.code(404).header("Cache-Control", "no-store").send({ error: "moment_social_card_not_found" });
      }
      reply
        .header("Cache-Control", "public, max-age=0, must-revalidate")
        .header("ETag", artifact.etag)
        .header("X-Content-Type-Options", "nosniff")
        .type("image/png");
      if (etagMatches(request.headers["if-none-match"], artifact.etag)) return reply.code(304).send();
      return reply.send(artifact.png);
    },
  );
}
