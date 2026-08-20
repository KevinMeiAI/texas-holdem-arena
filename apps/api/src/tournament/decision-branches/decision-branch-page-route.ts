import type { FastifyInstance } from "fastify";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PublicDecisionBranchDto } from "../../../../../packages/contracts/src/index.js";

export type DecisionBranchPageLocale = "zh" | "en";

interface PublicDecisionBranchReader {
  getPublicBySlug(slug: string): Promise<PublicDecisionBranchDto | null>;
}

export interface DecisionBranchPageRouteContext {
  decisionBranches: PublicDecisionBranchReader;
  publicOrigin: string;
  webRoot: string;
}

export interface DecisionBranchSocialMetadata {
  locale: DecisionBranchPageLocale;
  title: string;
  description: string;
  canonicalUrl: string;
  alternateZhUrl: string;
  alternateEnUrl: string;
  publishedAt: string;
}

const PUBLIC_DECISION_BRANCH_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DYNAMIC_SOCIAL_TAGS = /<!-- arena:dynamic-social:start -->[\s\S]*?<!-- arena:dynamic-social:end -->/gi;
const TITLE_TAG = /<title\b[^>]*>[\s\S]*?<\/title>/gi;
const DESCRIPTION_TAG = /<meta\b(?=[^>]*\bname\s*=\s*["']description["'])[^>]*>/gi;

function collapseText(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function truncateGraphemes(
  value: string,
  maxLength: number,
  locale: DecisionBranchPageLocale,
): string {
  const segments = [...new Intl.Segmenter(locale, { granularity: "grapheme" }).segment(value)];
  if (segments.length <= maxLength) return value;
  return `${segments.slice(0, maxLength - 1).map(({ segment }) => segment).join("")}…`;
}

function normalizedCopy(
  value: string | null,
  fallback: string,
  maxLength: number,
  locale: DecisionBranchPageLocale,
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

function localizedDecisionBranchUrl(
  publicOrigin: string,
  slug: string,
  locale: DecisionBranchPageLocale,
): string {
  const url = new URL(`/branches/${slug}`, publicOrigin);
  if (locale === "en") url.searchParams.set("lang", "en");
  return url.href;
}

export function buildDecisionBranchSocialMetadata(
  branch: PublicDecisionBranchDto,
  locale: DecisionBranchPageLocale,
  publicOrigin: string,
): DecisionBranchSocialMetadata {
  const otherTitle = locale === "zh" ? branch.titleEn : branch.titleZh;
  const selectedTitle = locale === "zh" ? branch.titleZh : branch.titleEn;
  const otherSummary = locale === "zh" ? branch.summaryEn : branch.summaryZh;
  const selectedSummary = locale === "zh" ? branch.summaryZh : branch.summaryEn;
  const handNo = branch.snapshot.source.handNo;
  const titleFallback = locale === "zh"
    ? `第 ${handNo} 手 · 决策分叉`
    : `Hand ${handNo} · Decision branch`;
  const descriptionFallback = locale === "zh"
    ? `查看第 ${handNo} 手同一德扑决策点的模型复测结果。`
    : `Compare repeated model decisions at the same poker spot from hand ${handNo}.`;
  const title = normalizedCopy(selectedTitle ?? otherTitle, titleFallback, 90, locale);
  const description = normalizedCopy(
    selectedSummary ?? otherSummary,
    descriptionFallback,
    220,
    locale,
  );
  const canonicalUrl = localizedDecisionBranchUrl(publicOrigin, branch.slug, locale);
  return {
    locale,
    title,
    description,
    canonicalUrl,
    alternateZhUrl: localizedDecisionBranchUrl(publicOrigin, branch.slug, "zh"),
    alternateEnUrl: localizedDecisionBranchUrl(publicOrigin, branch.slug, "en"),
    publishedAt: branch.publishedAt,
  };
}

export function injectDecisionBranchSocialMetadata(
  template: string,
  metadata: DecisionBranchSocialMetadata,
): string {
  const closingHead = /<\/head\s*>/i;
  if (!closingHead.test(template)) throw new Error("Web shell is missing a closing head tag");
  const escaped = Object.fromEntries(
    Object.entries(metadata).map(([key, value]) => [key, escapeHtml(String(value))]),
  ) as Record<keyof DecisionBranchSocialMetadata, string>;
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
    <meta property="article:published_time" content="${escaped.publishedAt}" />
    <meta name="twitter:card" content="summary" />
    <meta name="twitter:title" content="${escaped.title}" />
    <meta name="twitter:description" content="${escaped.description}" />
    <!-- arena:dynamic-social:end -->`;

  return template
    .replace(DYNAMIC_SOCIAL_TAGS, "")
    .replace(TITLE_TAG, "")
    .replace(DESCRIPTION_TAG, "")
    .replace(/<html\b([^>]*)\blang\s*=\s*["'][^"']*["']([^>]*)>/i,
      `<html$1lang="${metadata.locale === "zh" ? "zh-CN" : "en"}"$2>`)
    // A replacement callback is required because escaped editorial copy may
    // still contain replacement tokens such as `$&`, `$'`, or `$\``.
    .replace(closingHead, () => `${tags}\n  </head>`);
}

function notFoundPage(locale: DecisionBranchPageLocale): string {
  const message = locale === "zh" ? "这个决策分叉不存在或尚未公开。" : "This decision branch is unavailable.";
  return `<!doctype html><html lang="${locale === "zh" ? "zh-CN" : "en"}"><head><meta charset="utf-8"><meta name="robots" content="noindex,nofollow"><title>Decision branch unavailable</title></head><body>${message}</body></html>`;
}

export async function registerDecisionBranchPageRoutes(
  app: FastifyInstance,
  context: DecisionBranchPageRouteContext,
): Promise<void> {
  app.get<{ Params: { slug: string }; Querystring: { lang?: string } }>(
    "/branches/:slug",
    async (request, reply) => {
      const locale: DecisionBranchPageLocale = request.query.lang === "en" ? "en" : "zh";
      const normalizedSlug = request.params.slug.trim().toLocaleLowerCase("en-US");
      if (!PUBLIC_DECISION_BRANCH_SLUG.test(normalizedSlug)) {
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
          .redirect(localizedDecisionBranchUrl(context.publicOrigin, normalizedSlug, locale));
      }
      const initialBranch = await context.decisionBranches.getPublicBySlug(normalizedSlug);
      if (!initialBranch) {
        return reply
          .code(404)
          .header("Cache-Control", "no-store")
          .header("X-Robots-Tag", "noindex, nofollow")
          .type("text/html; charset=utf-8")
          .send(notFoundPage(locale));
      }
      const template = await readFile(join(context.webRoot, "index.html"), "utf8");
      // Publication edits and hides can race filesystem I/O. Re-read before
      // constructing metadata so a response never exposes stale publication
      // copy after the shell has loaded.
      const branch = await context.decisionBranches.getPublicBySlug(normalizedSlug);
      if (!branch) {
        return reply
          .code(404)
          .header("Cache-Control", "no-store")
          .header("X-Robots-Tag", "noindex, nofollow")
          .type("text/html; charset=utf-8")
          .send(notFoundPage(locale));
      }
      const html = injectDecisionBranchSocialMetadata(
        template,
        buildDecisionBranchSocialMetadata(branch, locale, context.publicOrigin),
      );
      return reply
        .header("Cache-Control", "no-store")
        .type("text/html; charset=utf-8")
        .send(html);
    },
  );
}
