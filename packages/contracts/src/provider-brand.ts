import { z } from "zod";

export const providerBrandSchema = z.enum([
  "chatgpt",
  "claude",
  "deepseek",
  "doubao",
  "gemini",
  "glm",
  "hunyuan",
  "kimi",
  "minimax",
  "qwen",
  "wenxin",
  "xai",
]);

export type ProviderBrand = z.infer<typeof providerBrandSchema>;
