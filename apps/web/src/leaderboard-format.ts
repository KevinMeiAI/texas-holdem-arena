import type { UiLocale } from "./ui-preferences";
import type { StyleProfileEntry } from "./types";

const STYLE_PROFILE_LABELS: Record<StyleProfileEntry["profile"], Record<UiLocale, string>> = {
  "紧凶": { "zh-CN": "紧凶", en: "TAG" },
  "紧稳": { "zh-CN": "紧稳", en: "Tight-passive" },
  "均衡": { "zh-CN": "均衡", en: "Balanced" },
  "松凶": { "zh-CN": "松凶", en: "LAG" },
  "松稳": { "zh-CN": "松稳", en: "Loose-passive" },
};

export function styleProfileLabel(profile: StyleProfileEntry["profile"], locale: UiLocale): string {
  return STYLE_PROFILE_LABELS[profile][locale];
}
