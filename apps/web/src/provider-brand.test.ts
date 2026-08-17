import { describe, expect, it } from "vitest";
import { resolveProviderBrand } from "./provider-brand";

describe("provider brand resolution", () => {
  it("lets an explicit compatibility profile take priority", () => {
    expect(resolveProviderBrand({ providerProfile: "deepseek", label: "Kimi proxy" })).toBe("deepseek");
    expect(resolveProviderBrand({ providerProfile: "anthropic", providerType: "openai-compatible" })).toBe("claude");
    expect(resolveProviderBrand({ providerProfile: "qwen", label: "Private gateway" })).toBe("qwen");
    expect(resolveProviderBrand({ providerProfile: "doubao", label: "Private gateway" })).toBe("doubao");
    expect(resolveProviderBrand({ providerProfile: "wenxin", label: "Private gateway" })).toBe("wenxin");
    expect(resolveProviderBrand({ providerProfile: "hunyuan", label: "Private gateway" })).toBe("hunyuan");
    expect(resolveProviderBrand({ providerProfile: "minimax", label: "Private gateway" })).toBe("minimax");
  });

  it("recognizes native provider protocols", () => {
    expect(resolveProviderBrand({ providerProfile: "auto", providerType: "openai-responses" })).toBe("chatgpt");
    expect(resolveProviderBrand({ providerProfile: "auto", providerType: "google-gemini" })).toBe("gemini");
  });

  it.each([
    ["https://api.deepseek.com", "deepseek"],
    ["https://api.moonshot.cn/v1", "kimi"],
    ["https://open.bigmodel.cn/api/paas/v4", "glm"],
    ["https://api.x.ai/v1", "xai"],
    ["https://ark.cn-beijing.volces.com/api/v3", "doubao"],
    ["https://dashscope.aliyuncs.com/compatible-mode/v1", "qwen"],
    ["https://qianfan.baidubce.com/v2", "wenxin"],
  ] as const)("recognizes %s", (baseUrl, brand) => {
    expect(resolveProviderBrand({ providerProfile: "auto", providerType: "openai-compatible", baseUrl })).toBe(brand);
  });

  it("recognizes localized labels and model fingerprints", () => {
    expect(resolveProviderBrand({ label: "腾讯混元" })).toBe("hunyuan");
    expect(resolveProviderBrand({ label: "MiniMax 开放平台" })).toBe("minimax");
    expect(resolveProviderBrand({ modelId: "gpt-5.6-pro" })).toBe("chatgpt");
  });

  it("keeps unknown custom providers on the letter fallback", () => {
    expect(resolveProviderBrand({ providerProfile: "generic", label: "Private gateway" })).toBeNull();
  });
});
