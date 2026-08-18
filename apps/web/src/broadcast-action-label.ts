import type { ArenaBroadcastLastAction } from "./types";

export function compactBroadcastActionLabel(action: ArenaBroadcastLastAction, locale: "zh-CN" | "en"): string {
  const format = (value: number) => new Intl.NumberFormat("en-US", {
    notation: value >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(value);
  const amount = action.classification === "call" ? action.paid : action.amountTo;
  const labels: Record<string, [string, string]> = {
    fold: ["弃牌", "Fold"],
    check: ["过牌", "Check"],
    call: ["跟注", "Call"],
    bet: ["下注至", "Bet to"],
    raise: ["加注至", "Raise to"],
    short_raise: ["加注至", "Raise to"],
  };
  const actionLabel = action.action === "all_in"
    ? locale === "en" ? "All-in" : "全下"
    : labels[action.classification]?.[locale === "en" ? 1 : 0] ?? action.action.toUpperCase();
  const primaryLabel = action.term?.trim() || actionLabel;
  return `${primaryLabel}${amount > 0 ? ` ${format(amount)}` : ""}`;
}
