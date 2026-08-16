import { useState, type CSSProperties } from "react";
import chatgptLogo from "../../../model_provider_logo/chatgpt.png";
import claudeLogo from "../../../model_provider_logo/claude.png";
import deepseekLogo from "../../../model_provider_logo/deepseek.png";
import doubaoLogo from "../../../model_provider_logo/doubao.png";
import geminiLogo from "../../../model_provider_logo/gemini.png";
import glmLogo from "../../../model_provider_logo/glm.png";
import hunyuanLogo from "../../../model_provider_logo/hunyuan.png";
import kimiLogo from "../../../model_provider_logo/kimi.png";
import minimaxLogo from "../../../model_provider_logo/minimax.png";
import qwenLogo from "../../../model_provider_logo/qwen.png";
import wenxinLogo from "../../../model_provider_logo/wenxin.png";
import xaiLogo from "../../../model_provider_logo/xai.png";
import { resolveProviderBrand, type ProviderBrand, type ProviderBrandHints } from "./provider-brand";

const BRAND_ASSETS: Readonly<Record<ProviderBrand, string>> = {
  chatgpt: chatgptLogo,
  claude: claudeLogo,
  deepseek: deepseekLogo,
  doubao: doubaoLogo,
  gemini: geminiLogo,
  glm: glmLogo,
  hunyuan: hunyuanLogo,
  kimi: kimiLogo,
  minimax: minimaxLogo,
  qwen: qwenLogo,
  wenxin: wenxinLogo,
  xai: xaiLogo,
};

const LIGHT_SURFACE_BRANDS = new Set<ProviderBrand>(["chatgpt", "xai"]);
const DARK_SURFACE_BRANDS = new Set<ProviderBrand>(["kimi"]);

interface ProviderLogoProps extends ProviderBrandHints {
  fallback: string;
  fallbackStyle?: CSSProperties;
  className?: string;
}

export function ProviderLogo({ fallback, fallbackStyle, className = "", ...hints }: ProviderLogoProps) {
  const brand = resolveProviderBrand(hints);
  const [failedBrand, setFailedBrand] = useState<ProviderBrand | null>(null);
  const visibleBrand = brand === failedBrand ? null : brand;
  const surface = visibleBrand && LIGHT_SURFACE_BRANDS.has(visibleBrand)
    ? " on-light"
    : visibleBrand && DARK_SURFACE_BRANDS.has(visibleBrand)
      ? " on-dark"
      : "";
  return (
    <span
      className={`provider-logo${visibleBrand ? ` has-image brand-${visibleBrand}${surface}` : " is-fallback"}${className ? ` ${className}` : ""}`}
      style={visibleBrand ? undefined : fallbackStyle}
      aria-hidden="true"
    >
      {visibleBrand
        ? <img src={BRAND_ASSETS[visibleBrand]} alt="" draggable={false} onError={() => setFailedBrand(visibleBrand)} />
        : fallback}
    </span>
  );
}
