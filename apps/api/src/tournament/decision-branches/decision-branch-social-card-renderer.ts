import { Resvg } from "@resvg/resvg-js";
import { createHash } from "node:crypto";
import {
  DECISION_BRANCH_SOCIAL_CARD_ACTION_ORDER,
  DECISION_BRANCH_SOCIAL_CARD_RENDERER_VERSION,
  DECISION_BRANCH_SOCIAL_CARD_SIZE,
  parseDecisionBranchSocialCardProjection,
  type DecisionBranchSocialCardProjection,
  type DecisionBranchSocialCardTarget,
} from "../../../../../packages/contracts/src/decision-branch-social-card.js";
import { canonicalJson } from "../../../../../packages/fairness/src/canonical-json.js";

export interface RenderedDecisionBranchSocialCard {
  rendererVersion: typeof DECISION_BRANCH_SOCIAL_CARD_RENDERER_VERSION;
  mimeType: "image/png";
  width: typeof DECISION_BRANCH_SOCIAL_CARD_SIZE.width;
  height: typeof DECISION_BRANCH_SOCIAL_CARD_SIZE.height;
  projectionHash: string;
  pngSha256: string;
  png: Buffer;
  /** True when unsupported or oversized copy required deterministic fallback. */
  textFallbackApplied: boolean;
}

interface SafeText {
  value: string;
  degraded: boolean;
}

interface VectorTextOptions {
  x: number;
  y: number;
  cell: number;
  fill: string;
  align?: "start" | "middle" | "end";
  tracking?: number;
}

const COLORS = Object.freeze({
  paper: "#f3efe4",
  muted: "#a9aaa4",
  gold: "#d3ad63",
  goldSoft: "#655333",
  felt: "#143d2d",
  feltLight: "#1e5940",
  feltDeep: "#091b14",
  panel: "#10271f",
  panelDeep: "#0b2018",
  rule: "#7c6c4c",
  cardInk: "#13231c",
  cardRed: "#a83d3c",
  error: "#c76b61",
});

// A compact vector font makes output byte-stable across hosts and containers.
// No SVG <text>, system font, image, or network resource is ever consulted.
const GLYPHS: Readonly<Record<string, readonly string[]>> = {
  "?": ["01110", "10001", "00001", "00010", "00100", "00000", "00100"],
  "!": ["00100", "00100", "00100", "00100", "00100", "00000", "00100"],
  "#": ["01010", "11111", "01010", "01010", "11111", "01010", "01010"],
  "%": ["11001", "11010", "00100", "01000", "10110", "00110", "00000"],
  "&": ["01100", "10010", "10100", "01000", "10101", "10010", "01101"],
  "'": ["00100", "00100", "00010", "00000", "00000", "00000", "00000"],
  "(": ["00010", "00100", "01000", "01000", "01000", "00100", "00010"],
  ")": ["01000", "00100", "00010", "00010", "00010", "00100", "01000"],
  "+": ["00000", "00100", "00100", "11111", "00100", "00100", "00000"],
  ",": ["00000", "00000", "00000", "00000", "00000", "00100", "01000"],
  "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
  ".": ["00000", "00000", "00000", "00000", "00000", "00110", "00110"],
  "/": ["00001", "00010", "00100", "01000", "10000", "00000", "00000"],
  ":": ["00000", "00110", "00110", "00000", "00110", "00110", "00000"],
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "10000", "11110", "00001", "00001", "11110"],
  "6": ["01110", "10000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00001", "01110"],
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  C: ["01111", "10000", "10000", "10000", "10000", "10000", "01111"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  G: ["01111", "10000", "10000", "10111", "10001", "10001", "01111"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  I: ["01110", "00100", "00100", "00100", "00100", "00100", "01110"],
  J: ["00111", "00010", "00010", "00010", "00010", "10010", "01100"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  Q: ["01110", "10001", "10001", "10001", "10101", "10010", "01101"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  W: ["10001", "10001", "10001", "10101", "10101", "10101", "01010"],
  X: ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
  Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
  Z: ["11111", "00001", "00010", "00100", "01000", "10000", "11111"],
};

const ASCII_REPLACEMENTS: Readonly<Record<string, string>> = {
  "’": "'",
  "‘": "'",
  "“": "'",
  "”": "'",
  "–": "-",
  "—": "-",
  "·": "-",
  "×": "X",
};

function safeText(value: string, fallback: string, maximum: number): SafeText {
  const normalized = value.normalize("NFKD").toUpperCase();
  let output = "";
  let degraded = false;
  let replacing = false;
  for (const source of normalized) {
    const replaced = ASCII_REPLACEMENTS[source] ?? source;
    if (replaced === " " || GLYPHS[replaced]) {
      output += replaced;
      replacing = false;
    } else if (!replacing) {
      output += "?";
      replacing = true;
      degraded = true;
    } else {
      degraded = true;
    }
  }
  output = output.replace(/\s+/g, " ").trim();
  if (!output || output.replace(/[? ]/g, "").length === 0) {
    output = fallback;
    degraded = true;
  }
  if (output.length > maximum) {
    const suffix = maximum >= 4 ? "..." : ".";
    output = output.slice(0, Math.max(1, maximum - suffix.length)).trimEnd() + suffix;
    degraded = true;
  }
  return { value: output, degraded };
}

function glyphAdvance(cell: number, tracking = cell): number {
  return 5 * cell + tracking;
}

function vectorTextWidth(value: string, cell: number, tracking = cell): number {
  if (!value) return 0;
  return value.length * glyphAdvance(cell, tracking) - tracking;
}

function vectorText(value: string, options: VectorTextOptions): string {
  const tracking = options.tracking ?? options.cell;
  const width = vectorTextWidth(value, options.cell, tracking);
  const startX = options.align === "middle"
    ? options.x - width / 2
    : options.align === "end" ? options.x - width : options.x;
  const commands: string[] = [];
  let cursor = startX;
  for (const character of value) {
    const glyph = GLYPHS[character];
    if (glyph) {
      for (let row = 0; row < glyph.length; row += 1) {
        for (let column = 0; column < 5; column += 1) {
          if (glyph[row]?.[column] !== "1") continue;
          const x = cursor + column * options.cell;
          const y = options.y + row * options.cell;
          commands.push(`M${x} ${y}h${options.cell}v${options.cell}h-${options.cell}z`);
        }
      }
    }
    cursor += glyphAdvance(options.cell, tracking);
  }
  return commands.length > 0 ? `<path d="${commands.join("")}" fill="${options.fill}"/>` : "";
}

function wrapVectorText(value: string, maximumWidth: number, cell: number, maximumLines: number): string[] {
  const lines: string[] = [];
  let remaining = value.trim();
  while (remaining && lines.length < maximumLines) {
    if (vectorTextWidth(remaining, cell) <= maximumWidth) {
      lines.push(remaining);
      remaining = "";
      break;
    }
    let fittingLength = 1;
    while (
      fittingLength < remaining.length
      && vectorTextWidth(remaining.slice(0, fittingLength + 1), cell) <= maximumWidth
    ) fittingLength += 1;
    const fitting = remaining.slice(0, fittingLength);
    const lastSpace = fitting.lastIndexOf(" ");
    const cutAt = lastSpace > 0 ? lastSpace : fittingLength;
    lines.push(remaining.slice(0, cutAt).trimEnd());
    remaining = remaining.slice(cutAt).trimStart();
  }
  if (remaining && lines.length > 0) {
    const lastIndex = lines.length - 1;
    let last = lines[lastIndex] ?? "";
    while (last.length > 1 && vectorTextWidth(`${last}...`, cell) > maximumWidth) last = last.slice(0, -1);
    lines[lastIndex] = `${last.replace(/[. ]+$/g, "")}...`;
  }
  return lines;
}

function formatNumber(value: number): string {
  const sign = value < 0 ? "-" : "";
  const digits = String(Math.abs(Math.trunc(value)));
  const groups: string[] = [];
  for (let end = digits.length; end > 0; end -= 3) {
    groups.unshift(digits.slice(Math.max(0, end - 3), end));
  }
  return sign + groups.join(",");
}

function formatBigBlinds(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function cardParts(card: string): { rank: string; suit: string; red: boolean } {
  const suit = card[1] ?? "s";
  return { rank: card[0] ?? "?", suit, red: suit === "d" || suit === "h" };
}

function suitShape(suit: string, centerX: number, centerY: number, scale: number, fill: string): string {
  if (suit === "d") {
    return `<path d="M${centerX} ${centerY - 12 * scale}L${centerX + 9 * scale} ${centerY}L${centerX} ${centerY + 12 * scale}L${centerX - 9 * scale} ${centerY}Z" fill="${fill}"/>`;
  }
  if (suit === "h") {
    return `<path d="M${centerX} ${centerY + 11 * scale}C${centerX - 17 * scale} ${centerY - scale} ${centerX - 9 * scale} ${centerY - 14 * scale} ${centerX} ${centerY - 6 * scale}C${centerX + 9 * scale} ${centerY - 14 * scale} ${centerX + 17 * scale} ${centerY - scale} ${centerX} ${centerY + 11 * scale}Z" fill="${fill}"/>`;
  }
  if (suit === "c") {
    return `<g fill="${fill}"><circle cx="${centerX}" cy="${centerY - 7 * scale}" r="${7 * scale}"/><circle cx="${centerX - 7 * scale}" cy="${centerY + scale}" r="${7 * scale}"/><circle cx="${centerX + 7 * scale}" cy="${centerY + scale}" r="${7 * scale}"/><path d="M${centerX - 3 * scale} ${centerY + 4 * scale}h${6 * scale}v${12 * scale}h${5 * scale}v${3 * scale}h-${16 * scale}v-${3 * scale}h${5 * scale}Z"/></g>`;
  }
  return `<path d="M${centerX} ${centerY - 13 * scale}C${centerX - 2 * scale} ${centerY - 7 * scale} ${centerX - 15 * scale} ${centerY - 2 * scale} ${centerX - 11 * scale} ${centerY + 7 * scale}C${centerX - 8 * scale} ${centerY + 13 * scale} ${centerX - 2 * scale} ${centerY + 8 * scale} ${centerX} ${centerY + 4 * scale}C${centerX + 2 * scale} ${centerY + 8 * scale} ${centerX + 8 * scale} ${centerY + 13 * scale} ${centerX + 11 * scale} ${centerY + 7 * scale}C${centerX + 15 * scale} ${centerY - 2 * scale} ${centerX + 2 * scale} ${centerY - 7 * scale} ${centerX} ${centerY - 13 * scale}Z M${centerX - 3 * scale} ${centerY + 5 * scale}h${6 * scale}v${11 * scale}h${5 * scale}v${3 * scale}h-${16 * scale}v-${3 * scale}h${5 * scale}Z" fill="${fill}"/>`;
}

function playingCard(card: string | null, x: number, y: number, width: number, height: number): string {
  const radius = Math.max(4, Math.round(width * 0.09));
  if (!card) {
    return `<g data-card-face="empty"><rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${radius}" fill="${COLORS.panelDeep}" stroke="${COLORS.rule}" stroke-opacity=".45" stroke-width="1.5"/></g>`;
  }
  const parts = cardParts(card);
  const ink = parts.red ? COLORS.cardRed : COLORS.cardInk;
  const rankCell = Math.max(1.6, Math.round(width / 17));
  return `<g data-card-face="front"><rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${radius}" fill="${COLORS.paper}" stroke="#d7cfbd" stroke-width="2"/>${vectorText(parts.rank, { x: x + 6, y: y + 6, cell: rankCell, fill: ink })}${suitShape(parts.suit, x + width / 2, y + height * .64, width / 42, ink)}</g>`;
}

function actionLabel(action: DecisionBranchSocialCardTarget["actionDistribution"][number]["action"]): string {
  const labels = {
    fold: "FOLD",
    check: "CHECK",
    call: "CALL",
    bet: "BET",
    raise: "RAISE",
    all_in: "ALL-IN",
  } as const;
  return labels[action];
}

function originalDecisionLabel(projection: DecisionBranchSocialCardProjection): string {
  const { action, displayAmountTo } = projection.originalDecision;
  const label = actionLabel(action);
  if (displayAmountTo === null) return label;
  return action === "bet" || action === "raise"
    ? `${label} TO ${formatNumber(displayAmountTo)}`
    : `${label} ${formatNumber(displayAmountTo)}`;
}

function targetPanel(
  target: DecisionBranchSocialCardTarget,
  x: number,
  y: number,
  width: number,
): { svg: string; degraded: boolean } {
  const maximum = target.actionDistribution.reduce((highest, entry) => Math.max(highest, entry.count), 0);
  const counts = new Map(target.actionDistribution.map((entry) => [entry.action, entry]));
  const modalActions = target.actionDistribution
    .filter((entry) => maximum > 0 && entry.count === maximum)
    .map((entry) => entry.action)
    .join(",");
  const actionStartX = x + 190;
  const actionWidth = (width - 204) / DECISION_BRANCH_SOCIAL_CARD_ACTION_ORDER.length;
  const nameCell = 1.25;
  const nameX = x + 51;
  const nameMaximum = Math.max(4, Math.floor(
    (actionStartX - nameX - 10 + nameCell) / glyphAdvance(nameCell),
  ));
  const name = safeText(target.displayName, `MODEL ${target.ordinal}`, nameMaximum);
  const actionCells = target.validActionTrials === 0
    ? `<g data-action-grid="empty">${vectorText("NO VALID ACTION", { x: (actionStartX + x + width) / 2, y: y + 30, cell: 1.1, fill: COLORS.error, align: "middle" })}</g>`
    : `<g data-action-grid="distribution">${DECISION_BRANCH_SOCIAL_CARD_ACTION_ORDER.map((action, index) => {
        const entry = counts.get(action);
        const modal = Boolean(entry && entry.count === maximum && maximum > 0);
        const cellX = actionStartX + index * actionWidth;
        const label = actionLabel(action);
        const value = entry ? formatPercent(entry.share) : "-";
        const fill = modal ? COLORS.gold : entry ? COLORS.paper : COLORS.muted;
        return `<g data-action="${action}" data-count="${entry?.count ?? 0}" data-share="${entry?.share ?? 0}" data-modal-action="${modal}">${modal ? `<rect x="${cellX + 2}" y="${y + 9}" width="${actionWidth - 4}" height="54" rx="5" fill="${COLORS.goldSoft}" fill-opacity=".56"/>` : ""}${vectorText(label, { x: cellX + actionWidth / 2, y: y + 17, cell: .72, fill, align: "middle" })}${vectorText(value, { x: cellX + actionWidth / 2, y: y + 39, cell: 1.25, fill, align: "middle" })}</g>`;
      }).join("")}</g>`;
  const agreement = target.pairwiseAgreement === null ? "AGREE -" : `AGREE ${formatPercent(target.pairwiseAgreement)}`;
  return {
    degraded: name.degraded,
    svg: `<g data-target-ordinal="${target.ordinal}" data-model-label-length="${name.value.length}" data-model-label-budget="${nameMaximum}" data-valid-action-trials="${target.validActionTrials}" data-zero-valid-actions="${target.validActionTrials === 0}" data-modal-actions="${modalActions}" data-fallback-trials="${target.fallbackTrials}" data-infrastructure-error-trials="${target.infrastructureErrorTrials}"><rect x="${x}" y="${y}" width="${width}" height="76" rx="8" fill="${COLORS.panel}" stroke="${COLORS.rule}" stroke-opacity=".45"/>${vectorText(`#${String(target.ordinal).padStart(2, "0")}`, { x: x + 14, y: y + 15, cell: .9, fill: COLORS.gold })}${vectorText(name.value, { x: nameX, y: y + 13, cell: nameCell, fill: COLORS.paper })}${vectorText(`VALID ${target.validActionTrials}/${target.completedTrials}`, { x: x + 14, y: y + 40, cell: .72, fill: COLORS.muted })}${vectorText(`FALLBACK ${target.fallbackTrials}`, { x: x + 14, y: y + 57, cell: .64, fill: target.fallbackTrials > 0 ? COLORS.gold : COLORS.muted })}${vectorText(`API ERR ${target.infrastructureErrorTrials}`, { x: x + 102, y: y + 57, cell: .64, fill: target.infrastructureErrorTrials > 0 ? COLORS.error : COLORS.muted })}${actionCells}${vectorText(agreement, { x: x + width - 10, y: y + 64, cell: .62, fill: COLORS.muted, align: "end" })}</g>`,
  };
}

function renderSvg(projection: DecisionBranchSocialCardProjection): { svg: string; degraded: boolean } {
  const tournament = safeText(projection.tournamentName, "MODEL POKER TOURNAMENT", 34);
  const title = safeText(projection.title, `HAND ${projection.handNo} DECISION BRANCH`, 72);
  const hero = safeText(projection.hero.displayName, "SOURCE MODEL", 30);
  const position = safeText(projection.hero.position, "POSITION", 12);
  const street = safeText(projection.street === "PREFLOP" ? "PRE-FLOP" : projection.street, "STREET", 10);
  const original = safeText(originalDecisionLabel(projection), "ORIGINAL ACTION", 28);
  const titleLines = wrapVectorText(title.value, 405, 4.1, 2);
  let degraded = tournament.degraded || title.degraded || hero.degraded
    || position.degraded || street.degraded || original.degraded;

  const titleSvg = titleLines.map((line, index) => vectorText(line, {
    x: 70,
    y: 142 + index * 38,
    cell: 4.1,
    fill: COLORS.paper,
  })).join("");
  const holeCards = projection.hero.holeCards.map((card, index) => (
    playingCard(card, 70 + index * 64, 282, 54, 78)
  )).join("");
  const board = Array.from({ length: 5 }, (_, index) => (
    playingCard(projection.board[index] ?? null, 70 + index * 62, 445, 52, 72)
  )).join("");

  const panelX = 498;
  const panelWidth = 650;
  const targetPanels = projection.displayedTargets.map((target, index) => {
    const panel = targetPanel(target, panelX + 12, 196 + index * 84, panelWidth - 24);
    degraded ||= panel.degraded;
    return panel.svg;
  }).join("");

  const additional = projection.additionalTargetCount > 0
    ? vectorText(`+${projection.additionalTargetCount} MORE`, { x: panelX + panelWidth - 12, y: 554, cell: .82, fill: COLORS.gold, align: "end" })
    : "";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="675" viewBox="0 0 1200 675" data-additional-target-count="${projection.additionalTargetCount}"><defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${COLORS.feltDeep}"/><stop offset=".58" stop-color="${COLORS.felt}"/><stop offset="1" stop-color="#0c281d"/></linearGradient><pattern id="grain" width="22" height="22" patternUnits="userSpaceOnUse"><circle cx="3" cy="3" r="1" fill="${COLORS.gold}" opacity=".08"/></pattern></defs><rect width="1200" height="675" fill="url(#bg)"/><rect width="1200" height="675" fill="url(#grain)"/><path d="M470 118V565" stroke="${COLORS.gold}" stroke-opacity=".18"/><g><rect x="70" y="50" width="48" height="48" rx="8" fill="none" stroke="${COLORS.rule}"/>${vectorText("A", { x: 83, y: 62, cell: 3.2, fill: COLORS.gold })}${suitShape("s", 104, 84, .55, COLORS.gold)}${vectorText("HOLD'EM ARENA", { x: 136, y: 54, cell: 2.2, fill: COLORS.paper })}${vectorText("MODEL POKER - DECISION BRANCH", { x: 136, y: 82, cell: 1.05, fill: COLORS.muted })}</g>${vectorText(tournament.value, { x: 1_130, y: 54, cell: 1.45, fill: COLORS.muted, align: "end" })}${vectorText(`H${String(projection.handNo).padStart(3, "0")} - ${street.value}`, { x: 1_130, y: 80, cell: 1.55, fill: COLORS.gold, align: "end" })}${titleSvg}<path d="M70 235H440" stroke="${COLORS.rule}" stroke-opacity=".7"/>${vectorText("POKER SPOT", { x: 70, y: 254, cell: .9, fill: COLORS.gold })}${vectorText(hero.value, { x: 70, y: 370, cell: 1.7, fill: COLORS.paper })}${vectorText(position.value, { x: 70, y: 397, cell: 1, fill: COLORS.gold })}${holeCards}${vectorText("ORIGINAL", { x: 205, y: 287, cell: .85, fill: COLORS.muted })}${vectorText(original.value, { x: 205, y: 310, cell: 1.45, fill: COLORS.gold })}${vectorText("STACK", { x: 205, y: 346, cell: .75, fill: COLORS.muted })}${vectorText(`${formatNumber(projection.hero.stackChips)} - ${formatBigBlinds(projection.hero.stackBigBlinds)} BB`, { x: 205, y: 365, cell: 1, fill: COLORS.paper })}${vectorText("POT", { x: 205, y: 396, cell: .75, fill: COLORS.muted })}${vectorText(`${formatNumber(projection.potBeforeActionChips)} - ${formatBigBlinds(projection.potBeforeActionBigBlinds)} BB`, { x: 205, y: 415, cell: 1, fill: COLORS.paper })}${vectorText("TO CALL", { x: 360, y: 396, cell: .75, fill: COLORS.muted })}${vectorText(`${formatNumber(projection.callAmountChips)}`, { x: 360, y: 415, cell: 1, fill: COLORS.paper })}${vectorText("BOARD", { x: 70, y: 426, cell: .85, fill: COLORS.muted })}${board}<g><rect x="${panelX}" y="134" width="${panelWidth}" height="431" rx="14" fill="${COLORS.panelDeep}" stroke="${COLORS.rule}" stroke-opacity=".72"/>${vectorText("MODEL ACTION DISTRIBUTIONS", { x: panelX + 18, y: 153, cell: 1.15, fill: COLORS.paper })}${vectorText(`${projection.sampleCountPerModel} RUNS EACH`, { x: panelX + panelWidth - 18, y: 154, cell: .9, fill: COLORS.gold, align: "end" })}${vectorText("MODEL", { x: panelX + 18, y: 178, cell: .7, fill: COLORS.muted })}${DECISION_BRANCH_SOCIAL_CARD_ACTION_ORDER.map((action, index) => vectorText(actionLabel(action), { x: panelX + 202 + index * ((panelWidth - 228) / 6) + ((panelWidth - 228) / 12), y: 178, cell: .62, fill: COLORS.muted, align: "middle" })).join("")}${targetPanels}${additional}</g><rect x="0" y="589" width="1200" height="86" fill="#07150f" fill-opacity=".82"/><path d="M0 589H1200" stroke="${COLORS.rule}"/><g data-methodology="decision-only" data-continuation-simulated="false">${vectorText("DECISION ONLY - SAME VISIBLE INPUT", { x: 70, y: 607, cell: 1.05, fill: COLORS.gold })}${vectorText("NO LATER ACTIONS, BOARD OR OUTCOME SIMULATED", { x: 70, y: 630, cell: .76, fill: COLORS.muted })}</g>${vectorText(`${projection.targetCount} MODELS - ${projection.sampleCountPerModel} RUNS EACH`, { x: 1_130, y: 610, cell: 2, fill: COLORS.paper, align: "end" })}</svg>`;
  return { svg, degraded };
}

export function renderDecisionBranchSocialCardSvg(input: unknown): string {
  return renderSvg(parseDecisionBranchSocialCardProjection(input)).svg;
}

export function renderDecisionBranchSocialCard(input: unknown): RenderedDecisionBranchSocialCard {
  const projection = parseDecisionBranchSocialCardProjection(input);
  const projectionHash = createHash("sha256").update(canonicalJson(projection)).digest("hex");
  const rendered = renderSvg(projection);
  const image = new Resvg(rendered.svg, {
    background: COLORS.feltDeep,
    fitTo: { mode: "original" },
    font: { loadSystemFonts: false },
    shapeRendering: 2,
    imageRendering: 0,
    logLevel: "off",
  }).render();
  if (image.width !== DECISION_BRANCH_SOCIAL_CARD_SIZE.width
    || image.height !== DECISION_BRANCH_SOCIAL_CARD_SIZE.height) {
    throw new Error(`Unexpected Decision Branch social card size: ${image.width}x${image.height}`);
  }
  const png = image.asPng();
  if (png.length === 0 || png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
    throw new Error("Decision Branch social card renderer returned an invalid PNG");
  }
  return {
    rendererVersion: DECISION_BRANCH_SOCIAL_CARD_RENDERER_VERSION,
    mimeType: "image/png",
    width: DECISION_BRANCH_SOCIAL_CARD_SIZE.width,
    height: DECISION_BRANCH_SOCIAL_CARD_SIZE.height,
    projectionHash,
    pngSha256: createHash("sha256").update(png).digest("hex"),
    png,
    textFallbackApplied: rendered.degraded,
  };
}
