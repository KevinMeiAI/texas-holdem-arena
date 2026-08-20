import type { FastifyInstance } from "fastify";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  MOMENT_SOCIAL_CARD_URL_VERSION,
  type PublicMomentDto,
} from "../../../../../packages/contracts/src/index.js";

export type MomentPageLocale = "zh" | "en";

interface PublicMomentReader {
  getPublicBySlug(slug: string): Promise<PublicMomentDto | null>;
}

export interface MomentPageRouteContext {
  moments: PublicMomentReader;
  publicOrigin: string;
  webRoot: string;
}

export interface MomentSocialMetadata {
  locale: MomentPageLocale;
  title: string;
  description: string;
  canonicalUrl: string;
  alternateZhUrl: string;
  alternateEnUrl: string;
  imageUrl: string;
  imageAlt: string;
  publishedAt: string;
}

const PUBLIC_MOMENT_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DYNAMIC_SOCIAL_TAGS = /<!-- arena:dynamic-social:start -->[\s\S]*?<!-- arena:dynamic-social:end -->/gi;
const TITLE_TAG = /<title\b[^>]*>[\s\S]*?<\/title>/gi;
const DESCRIPTION_TAG = /<meta\b(?=[^>]*\bname\s*=\s*["']description["'])[^>]*>/gi;

function collapseText(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function truncateGraphemes(value: string, maxLength: number, locale: MomentPageLocale): string {
  const segments = [...new Intl.Segmenter(locale, { granularity: "grapheme" }).segment(value)];
  if (segments.length <= maxLength) return value;
  return `${segments.slice(0, maxLength - 1).map(({ segment }) => segment).join("")}…`;
}

function normalizedCopy(
  value: string | null,
  fallback: string,
  maxLength: number,
  locale: MomentPageLocale,
): string {
  return truncateGraphemes(collapseText(value ?? fallback) || fallback, maxLength, locale);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function localizedMomentUrl(publicOrigin: string, slug: string, locale: MomentPageLocale): string {
  const url = new URL(`/moments/${slug}`, publicOrigin);
  if (locale === "en") url.searchParams.set("lang", "en");
  return url.href;
}

export function momentSocialCardPath(
  moment: Pick<PublicMomentDto, "slug" | "publicationRevision">,
  locale: MomentPageLocale,
): string {
  return `/api/public/moments/${moment.slug}/social-card/${MOMENT_SOCIAL_CARD_URL_VERSION}/r${moment.publicationRevision}/${locale}.png`;
}

export function buildMomentSocialMetadata(
  moment: PublicMomentDto,
  locale: MomentPageLocale,
  publicOrigin: string,
): MomentSocialMetadata {
  const otherTitle = locale === "zh" ? moment.titleEn : moment.titleZh;
  const selectedTitle = locale === "zh" ? moment.titleZh : moment.titleEn;
  const otherSummary = locale === "zh" ? moment.summaryEn : moment.summaryZh;
  const selectedSummary = locale === "zh" ? moment.summaryZh : moment.summaryEn;
  const titleFallback = locale === "zh"
    ? `第 ${moment.handNo} 手精彩时刻`
    : `Hand ${moment.handNo} highlight`;
  const descriptionFallback = locale === "zh"
    ? `观看 AI 模型德州扑克锦标赛第 ${moment.handNo} 手的精彩时刻。`
    : `Watch a defining moment from hand ${moment.handNo} of the AI model poker tournament.`;
  const title = normalizedCopy(selectedTitle ?? otherTitle, titleFallback, 90, locale);
  const description = normalizedCopy(
    selectedSummary ?? otherSummary,
    descriptionFallback,
    220,
    locale,
  );
  const canonicalUrl = localizedMomentUrl(publicOrigin, moment.slug, locale);
  return {
    locale,
    title,
    description,
    canonicalUrl,
    alternateZhUrl: localizedMomentUrl(publicOrigin, moment.slug, "zh"),
    alternateEnUrl: localizedMomentUrl(publicOrigin, moment.slug, "en"),
    imageUrl: new URL(momentSocialCardPath(moment, locale), publicOrigin).href,
    imageAlt: locale === "zh" ? `${title} 分享卡片` : `${title} share card`,
    publishedAt: moment.publishedAt,
  };
}

export function injectMomentSocialMetadata(
  template: string,
  metadata: MomentSocialMetadata,
): string {
  const closingHead = /<\/head\s*>/i;
  if (!closingHead.test(template)) throw new Error("Web shell is missing a closing head tag");
  const escaped = Object.fromEntries(
    Object.entries(metadata).map(([key, value]) => [key, escapeHtml(String(value))]),
  ) as Record<keyof MomentSocialMetadata, string>;
  const tags = `<!-- arena:dynamic-social:start -->
    <title>${escaped.title} · Texas Hold'em Arena</title>
    <meta name="description" content="${escaped.description}" />
    <meta name="robots" content="index,follow,max-image-preview:large" />
    <link rel="canonical" href="${escaped.canonicalUrl}" />
    <link rel="alternate" hreflang="zh-CN" href="${escaped.alternateZhUrl}" />
    <link rel="alternate" hreflang="en" href="${escaped.alternateEnUrl}" />
    <link rel="alternate" hreflang="x-default" href="${escaped.alternateZhUrl}" />
    <meta property="og:type" content="article" />
    <meta property="og:site_name" content="Texas Hold'em Arena" />
    <meta property="og:title" content="${escaped.title}" />
    <meta property="og:description" content="${escaped.description}" />
    <meta property="og:url" content="${escaped.canonicalUrl}" />
    <meta property="og:locale" content="${metadata.locale === "zh" ? "zh_CN" : "en_US"}" />
    <meta property="og:image" content="${escaped.imageUrl}" />
    <meta property="og:image:type" content="image/png" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="675" />
    <meta property="og:image:alt" content="${escaped.imageAlt}" />
    <meta property="article:published_time" content="${escaped.publishedAt}" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${escaped.title}" />
    <meta name="twitter:description" content="${escaped.description}" />
    <meta name="twitter:image" content="${escaped.imageUrl}" />
    <meta name="twitter:image:alt" content="${escaped.imageAlt}" />
    <!-- arena:dynamic-social:end -->`;

  return template
    .replace(DYNAMIC_SOCIAL_TAGS, "")
    .replace(TITLE_TAG, "")
    .replace(DESCRIPTION_TAG, "")
    .replace(/<html\b([^>]*)\blang\s*=\s*["'][^"']*["']([^>]*)>/i,
      `<html$1lang="${metadata.locale === "zh" ? "zh-CN" : "en"}"$2>`)
    // A replacement callback is required here: editorial copy may legally
    // contain `$&`, `$'`, or `$\`` and string replacements interpret those as
    // special match tokens even after correct HTML escaping.
    .replace(closingHead, () => `${tags}\n  </head>`);
}

function notFoundPage(locale: MomentPageLocale): string {
  const message = locale === "zh" ? "这个精彩时刻不存在或尚未公开。" : "This moment is unavailable.";
  return `<!doctype html><html lang="${locale === "zh" ? "zh-CN" : "en"}"><head><meta charset="utf-8"><meta name="robots" content="noindex,nofollow"><title>Moment unavailable</title></head><body>${message}</body></html>`;
}

export async function registerMomentPageRoutes(
  app: FastifyInstance,
  context: MomentPageRouteContext,
): Promise<void> {
  app.get<{ Params: { slug: string }; Querystring: { lang?: string } }>(
    "/moments/:slug",
    async (request, reply) => {
      const locale: MomentPageLocale = request.query.lang === "en" ? "en" : "zh";
      const normalizedSlug = request.params.slug.trim().toLocaleLowerCase("en-US");
      if (!PUBLIC_MOMENT_SLUG.test(normalizedSlug)) {
        return reply
          .code(404)
          .header("Cache-Control", "no-store")
          .header("X-Robots-Tag", "noindex, nofollow")
          .type("text/html; charset=utf-8")
          .send(notFoundPage(locale));
      }
      if (normalizedSlug !== request.params.slug) {
        return reply
          .code(308)
          .header("Cache-Control", "no-store")
          .redirect(localizedMomentUrl(context.publicOrigin, normalizedSlug, locale));
      }
      const initialMoment = await context.moments.getPublicBySlug(normalizedSlug);
      if (!initialMoment) {
        return reply
          .code(404)
          .header("Cache-Control", "no-store")
          .header("X-Robots-Tag", "noindex, nofollow")
          .type("text/html; charset=utf-8")
          .send(notFoundPage(locale));
      }
      const template = await readFile(join(context.webRoot, "index.html"), "utf8");
      // Publication edits and hides can race filesystem I/O. Re-read before
      // constructing metadata so the returned HTML never points at a stale
      // revision URL observed before the shell was loaded.
      const moment = await context.moments.getPublicBySlug(normalizedSlug);
      if (!moment) {
        return reply
          .code(404)
          .header("Cache-Control", "no-store")
          .header("X-Robots-Tag", "noindex, nofollow")
          .type("text/html; charset=utf-8")
          .send(notFoundPage(locale));
      }
      const html = injectMomentSocialMetadata(
        template,
        buildMomentSocialMetadata(moment, locale, context.publicOrigin),
      );
      return reply
        .header("Cache-Control", "no-store")
        .type("text/html; charset=utf-8")
        .send(html);
    },
  );
}
