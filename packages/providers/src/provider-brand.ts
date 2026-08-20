import type { ProviderBrand } from "../../contracts/src/competitors.js";

export type { ProviderBrand } from "../../contracts/src/competitors.js";

export interface ProviderBrandHints {
  providerProfile?: string | null;
  providerType?: string | null;
  label?: string | null;
  baseUrl?: string | null;
  modelId?: string | null;
}

const PROFILE_BRANDS: Readonly<Record<string, ProviderBrand>> = {
  openai: "chatgpt",
  anthropic: "claude",
  gemini: "gemini",
  deepseek: "deepseek",
  kimi: "kimi",
  zhipu: "glm",
  qwen: "qwen",
  doubao: "doubao",
  wenxin: "wenxin",
  hunyuan: "hunyuan",
  minimax: "minimax",
  xai: "xai",
};

const NATIVE_PROVIDER_BRANDS: Readonly<Record<string, ProviderBrand>> = {
  "openai-responses": "chatgpt",
  "anthropic-messages": "claude",
  "google-gemini": "gemini",
};

const BRAND_FINGERPRINTS: ReadonlyArray<readonly [ProviderBrand, RegExp]> = [
  ["deepseek", /deepseek|深度求索/],
  ["kimi", /moonshot|kimi|月之暗面/],
  ["glm", /bigmodel|zhipu|(?:^|[\s/_-])glm(?:[\s/_.-]|$)|智谱/],
  ["xai", /api\.x\.ai|(?:^|[^a-z0-9])xai(?:[^a-z0-9]|$)|grok/],
  ["claude", /anthropic|claude/],
  ["gemini", /gemini|generativelanguage\.googleapis\.com|google ai/],
  ["doubao", /doubao|volcengine|volces|火山方舟|豆包/],
  ["qwen", /qwen|dashscope|bailian|aliyun|alibaba cloud|通义|千问|百炼/],
  ["hunyuan", /hunyuan|tencentcloud|腾讯混元|混元/],
  ["wenxin", /wenxin|ernie|qianfan|baidu|文心|千帆/],
  ["minimax", /minimax|海螺/],
  ["chatgpt", /openai|chatgpt|(?:^|[\s/_-])gpt(?:[\s/_.-]|$)/],
];

function normalized(value: string | null | undefined): string {
  return (value ?? "").normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

export function resolveProviderBrand(hints: ProviderBrandHints): ProviderBrand | null {
  const profile = normalized(hints.providerProfile);
  if (PROFILE_BRANDS[profile]) return PROFILE_BRANDS[profile];

  const providerType = normalized(hints.providerType);
  if (NATIVE_PROVIDER_BRANDS[providerType]) return NATIVE_PROVIDER_BRANDS[providerType];

  const fingerprint = [hints.label, hints.baseUrl, hints.modelId]
    .map(normalized)
    .filter(Boolean)
    .join(" ");
  return BRAND_FINGERPRINTS.find(([, pattern]) => pattern.test(fingerprint))?.[0] ?? null;
}
