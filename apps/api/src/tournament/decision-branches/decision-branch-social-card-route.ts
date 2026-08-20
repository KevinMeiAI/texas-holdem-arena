import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  DECISION_BRANCH_SOCIAL_CARD_RENDERER_VERSION,
  DECISION_BRANCH_SOCIAL_CARD_URL_VERSION,
  type DecisionBranchSocialCardProjection,
  type PublicDecisionBranchDto,
} from "../../../../../packages/contracts/src/index.js";
import {
  buildDecisionBranchSocialCardProjection,
  type DecisionBranchSocialCardLocale,
} from "./decision-branch-social-card-projection.js";
import type { RenderedDecisionBranchSocialCard } from "./decision-branch-social-card-renderer.js";
import { renderDecisionBranchSocialCardOffThread } from "./decision-branch-social-card-worker-client.js";

interface PublicDecisionBranchReader {
  getPublicBySlug(slug: string): Promise<PublicDecisionBranchDto | null>;
}

export interface DecisionBranchSocialCardRouteContext {
  decisionBranches: PublicDecisionBranchReader;
}

export interface DecisionBranchSocialCardRouteDependencies {
  project?: typeof buildDecisionBranchSocialCardProjection;
  render?: (
    projection: DecisionBranchSocialCardProjection,
  ) => RenderedDecisionBranchSocialCard | Promise<RenderedDecisionBranchSocialCard>;
}

interface CachedSocialCard {
  png: Buffer;
  etag: string;
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const REVISION = /^r([1-9]\d*)$/;
const MAX_CACHE_ENTRIES = 24;
const MAX_RENDER_QUEUE = 8;

class DecisionBranchSocialCardBusyError extends Error {}

class DecisionBranchSocialCardRenderQueue {
  #active = 0;
  readonly #waiting: Array<() => void> = [];

  async run<Result>(task: () => Promise<Result>): Promise<Result> {
    if (this.#active >= 1) {
      if (this.#waiting.length >= MAX_RENDER_QUEUE) {
        throw new DecisionBranchSocialCardBusyError("Decision Branch social card renderer is busy");
      }
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

function cacheKey(
  branch: PublicDecisionBranchDto,
  locale: DecisionBranchSocialCardLocale,
): string {
  return [
    branch.id,
    `r${branch.publicationRevision}`,
    DECISION_BRANCH_SOCIAL_CARD_RENDERER_VERSION,
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

function cachedArtifact(rendered: RenderedDecisionBranchSocialCard): CachedSocialCard {
  const digest = createHash("sha256").update(rendered.png).digest("hex");
  return { png: rendered.png, etag: `"${digest}"` };
}

function currentRevision(branch: PublicDecisionBranchDto, requestedRevision: string): boolean {
  const match = REVISION.exec(requestedRevision);
  if (!match) return false;
  const revision = Number(match[1]);
  return Number.isSafeInteger(revision) && revision === branch.publicationRevision;
}

function localeFromPath(value: string): DecisionBranchSocialCardLocale | null {
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

function samePublishedRevision(
  before: PublicDecisionBranchDto,
  after: PublicDecisionBranchDto | null,
): boolean {
  return after !== null
    && after.id === before.id
    && after.slug === before.slug
    && after.publicationRevision === before.publicationRevision;
}

export async function registerDecisionBranchSocialCardRoutes(
  app: FastifyInstance,
  context: DecisionBranchSocialCardRouteContext,
  dependencies: DecisionBranchSocialCardRouteDependencies = {},
): Promise<void> {
  const project = dependencies.project ?? buildDecisionBranchSocialCardProjection;
  const render = dependencies.render ?? renderDecisionBranchSocialCardOffThread;
  const renderQueue = new DecisionBranchSocialCardRenderQueue();
  const cache = new Map<string, CachedSocialCard>();
  const inFlight = new Map<string, Promise<CachedSocialCard>>();

  app.get<{
    Params: { slug: string; version: string; revision: string; locale: string };
  }>(
    "/api/public/decision-branches/:slug/social-card/:version/:revision/:locale.png",
    async (request, reply) => {
      const { slug, version, revision } = request.params;
      const locale = localeFromPath(request.params.locale);
      if (!SLUG.test(slug)
        || version !== DECISION_BRANCH_SOCIAL_CARD_URL_VERSION
        || !REVISION.test(revision)
        || !locale) {
        return reply
          .code(404)
          .header("Cache-Control", "no-store")
          .send({ error: "decision_branch_social_card_not_found" });
      }
      const branch = await context.decisionBranches.getPublicBySlug(slug);
      if (!branch || !currentRevision(branch, revision)) {
        return reply
          .code(404)
          .header("Cache-Control", "no-store")
          .send({ error: "decision_branch_social_card_not_found" });
      }
      const key = cacheKey(branch, locale);
      let artifact = cache.get(key);
      if (artifact) artifact = remember(cache, key, artifact);
      if (!artifact && request.method === "HEAD") {
        const current = await context.decisionBranches.getPublicBySlug(slug);
        if (!samePublishedRevision(branch, current)) {
          return reply
            .code(404)
            .header("Cache-Control", "no-store")
            .send({ error: "decision_branch_social_card_not_found" });
        }
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
            const projection = project({ branch, locale });
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
          request.log.error({ err: error, slug, revision, locale }, "decision branch social card render failed");
          if (error instanceof DecisionBranchSocialCardBusyError) {
            return reply
              .code(503)
              .header("Cache-Control", "no-store")
              .header("Retry-After", "2")
              .send({ error: "decision_branch_social_card_busy" });
          }
          return reply
            .code(500)
            .header("Cache-Control", "no-store")
            .send({ error: "decision_branch_social_card_failed" });
        }
      }

      const current = await context.decisionBranches.getPublicBySlug(slug);
      if (!samePublishedRevision(branch, current)) {
        cache.delete(key);
        return reply
          .code(404)
          .header("Cache-Control", "no-store")
          .send({ error: "decision_branch_social_card_not_found" });
      }
      reply
        .header("Cache-Control", "public, max-age=0, must-revalidate")
        .header("ETag", artifact.etag)
        .header("X-Content-Type-Options", "nosniff")
        .type("image/png");
      if (etagMatches(request.headers["if-none-match"], artifact.etag)) {
        return reply.code(304).send();
      }
      return reply.send(artifact.png);
    },
  );
}
