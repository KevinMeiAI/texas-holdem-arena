import { createHash } from "node:crypto";
import { Resvg } from "@resvg/resvg-js";
import {
  MOMENT_SOCIAL_CARD_RENDERER_VERSION,
  MOMENT_SOCIAL_CARD_SIZE,
  parseSocialCardProjection,
  type ResultSocialCardPlayer,
  type SocialCardProjection,
  type SuspenseSocialCardPlayer,
} from "../../../../../packages/contracts/src/moment-social-card.js";
import { canonicalJson } from "../../../../../packages/fairness/src/canonical-json.js";

export interface RenderedMomentSocialCard {
  rendererVersion: typeof MOMENT_SOCIAL_CARD_RENDERER_VERSION;
  mimeType: "image/png";
  width: typeof MOMENT_SOCIAL_CARD_SIZE.width;
  height: typeof MOMENT_SOCIAL_CARD_SIZE.height;
  projectionHash: string;
  pngSha256: string;
  png: Buffer;
  /** True when unsupported glyphs required deterministic ASCII replacement. */
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
  rule: "#7c6c4c",
  cardInk: "#13231c",
  cardRed: "#a83d3c",
});

// A small vector font keeps the server renderer deterministic even when the
// container has no fonts installed. It is intentionally limited to the ASCII
// characters needed by the fixed card grammar; arbitrary copy is normalized
// and visibly falls back instead of silently consulting host fonts.
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
    : options.align === "end"
      ? options.x - width
      : options.x;
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
    ) {
      fittingLength += 1;
    }
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
  for (let end = digits.length; end > 0; end -= 3) groups.unshift(digits.slice(Math.max(0, end - 3), end));
  return sign + groups.join(",");
}

function formatBigBlinds(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
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
    return `<path d="M${centerX} ${centerY + 11 * scale}C${centerX - 17 * scale} ${centerY - 1 * scale} ${centerX - 9 * scale} ${centerY - 14 * scale} ${centerX} ${centerY - 6 * scale}C${centerX + 9 * scale} ${centerY - 14 * scale} ${centerX + 17 * scale} ${centerY - 1 * scale} ${centerX} ${centerY + 11 * scale}Z" fill="${fill}"/>`;
  }
  if (suit === "c") {
    return `<g fill="${fill}"><circle cx="${centerX}" cy="${centerY - 7 * scale}" r="${7 * scale}"/><circle cx="${centerX - 7 * scale}" cy="${centerY + 1 * scale}" r="${7 * scale}"/><circle cx="${centerX + 7 * scale}" cy="${centerY + 1 * scale}" r="${7 * scale}"/><path d="M${centerX - 3 * scale} ${centerY + 4 * scale}h${6 * scale}v${12 * scale}h${5 * scale}v${3 * scale}h-${16 * scale}v-${3 * scale}h${5 * scale}Z"/></g>`;
  }
  return `<path d="M${centerX} ${centerY - 13 * scale}C${centerX - 2 * scale} ${centerY - 7 * scale} ${centerX - 15 * scale} ${centerY - 2 * scale} ${centerX - 11 * scale} ${centerY + 7 * scale}C${centerX - 8 * scale} ${centerY + 13 * scale} ${centerX - 2 * scale} ${centerY + 8 * scale} ${centerX} ${centerY + 4 * scale}C${centerX + 2 * scale} ${centerY + 8 * scale} ${centerX + 8 * scale} ${centerY + 13 * scale} ${centerX + 11 * scale} ${centerY + 7 * scale}C${centerX + 15 * scale} ${centerY - 2 * scale} ${centerX + 2 * scale} ${centerY - 7 * scale} ${centerX} ${centerY - 13 * scale}Z M${centerX - 3 * scale} ${centerY + 5 * scale}h${6 * scale}v${11 * scale}h${5 * scale}v${3 * scale}h-${16 * scale}v-${3 * scale}h${5 * scale}Z" fill="${fill}"/>`;
}

function playingCard(card: string | null, x: number, y: number, width: number, height: number): string {
  const radius = Math.max(4, Math.round(width * 0.09));
  if (!card) {
    return `<g data-card-face="back"><rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${radius}" fill="${COLORS.feltDeep}" stroke="${COLORS.rule}" stroke-width="2"/><rect x="${x + 6}" y="${y + 6}" width="${width - 12}" height="${height - 12}" rx="${Math.max(2, radius - 2)}" fill="${COLORS.felt}" stroke="${COLORS.goldSoft}"/><path d="M${x + 8} ${y + height - 12}L${x + width - 8} ${y + 12}M${x + 8} ${y + height - 27}L${x + width - 20} ${y + 12}M${x + 20} ${y + height - 12}L${x + width - 8} ${y + 27}" stroke="${COLORS.goldSoft}" stroke-width="3" opacity=".8"/></g>`;
  }
  const parts = cardParts(card);
  const ink = parts.red ? COLORS.cardRed : COLORS.cardInk;
  const rankCell = Math.max(2, Math.round(width / 17));
  return `<g data-card-face="front"><rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${radius}" fill="${COLORS.paper}" stroke="#d7cfbd" stroke-width="2"/>${vectorText(parts.rank, { x: x + 7, y: y + 7, cell: rankCell, fill: ink })}${suitShape(parts.suit, x + width / 2, y + height * 0.62, width / 42, ink)}</g>`;
}

function initialFor(player: { displayName: string; seat: number }): SafeText {
  const normalized = safeText(player.displayName, `P${player.seat + 1}`, 24);
  const initial = normalized.value.replace(/[^A-Z0-9]/g, "")[0] ?? "P";
  return { value: initial, degraded: normalized.degraded };
}

function commonPlayerPanel(
  player: SuspenseSocialCardPlayer | ResultSocialCardPlayer,
  x: number,
  y: number,
  width: number,
): { prefix: string; degraded: boolean } {
  const compact = width < 180;
  const nameCell = compact ? 1.4 : 1.6;
  const nameX = compact ? x + 43 : x + 56;
  const nameMaximum = Math.max(4, Math.floor((width - (nameX - x) - 10 + nameCell) / glyphAdvance(nameCell)));
  const name = safeText(
    player.displayName,
    `PLAYER ${String(player.seat + 1).padStart(2, "0")}`,
    nameMaximum,
  );
  const initial = initialFor(player);
  const position = player.position ? safeText(player.position, "", 8) : { value: "", degraded: false };
  const seat = `SEAT ${String(player.seat + 1).padStart(2, "0")}${position.value ? ` - ${position.value}` : ""}`;
  const avatarX = compact ? x + 22 : x + 30;
  const avatarY = y + 30;
  const avatarRadius = compact ? 14 : 18;
  return {
    degraded: name.degraded || initial.degraded || position.degraded,
    prefix: `<g><rect x="${x}" y="${y}" width="${width}" height="154" rx="10" fill="${COLORS.panel}" stroke="${COLORS.rule}" stroke-opacity=".55"/><circle cx="${avatarX}" cy="${avatarY}" r="${avatarRadius}" fill="${COLORS.feltLight}" stroke="${COLORS.rule}"/>${vectorText(initial.value, { x: avatarX, y: compact ? y + 25 : y + 23, cell: compact ? 1.4 : 2, fill: COLORS.paper, align: "middle" })}${vectorText(name.value, { x: nameX, y: compact ? y + 20 : y + 18, cell: nameCell, fill: COLORS.paper })}${vectorText(seat, { x: nameX, y: y + 40, cell: compact ? .8 : 1.2, fill: COLORS.muted })}`,
  };
}

function suspensePlayerPanel(player: SuspenseSocialCardPlayer, x: number, y: number, width: number) {
  const common = commonPlayerPanel(player, x, y, width);
  const compact = width < 180;
  // The SUSPENSE contract carries no hole-card values at all. It stays neutral
  // until the viewer plays the moment to its reveal boundary.
  const first = null;
  const second = null;
  const state = player.allInAtCover
    ? "ALL-IN"
    : player.foldedAtCover
      ? "FOLDED"
      : player.coverStack === null
        ? "IN HAND"
        : "STACK";
  const stack = player.coverStack === null ? "-" : formatNumber(player.coverStack);
  const equity = player.coverEquityPercent === null ? "-" : `${Math.round(player.coverEquityPercent)}%`;
  const cardWidth = compact ? 30 : 42;
  const cardHeight = compact ? 44 : 58;
  const firstCardX = x + (compact ? 12 : 18);
  const secondCardX = x + (compact ? 47 : 66);
  return {
    degraded: common.degraded,
    svg: `${common.prefix}${playingCard(first, firstCardX, y + 67, cardWidth, cardHeight)}${playingCard(second, secondCardX, y + 67, cardWidth, cardHeight)}${vectorText("EQUITY", { x: x + width - (compact ? 10 : 18), y: y + 76, cell: compact ? .85 : 1.2, fill: COLORS.muted, align: "end" })}${vectorText(equity, { x: x + width - (compact ? 10 : 18), y: y + 97, cell: compact ? 1.7 : 2.6, fill: COLORS.gold, align: "end" })}${vectorText(state, { x: x + (compact ? 10 : 18), y: y + 137, cell: compact ? .75 : 1.1, fill: COLORS.muted })}${vectorText(stack, { x: x + width - (compact ? 10 : 18), y: y + 135, cell: compact ? 1 : 1.4, fill: COLORS.paper, align: "end" })}</g>`,
  };
}

function resultPlayerPanel(player: ResultSocialCardPlayer, x: number, y: number, width: number) {
  const common = commonPlayerPanel(player, x, y, width);
  const compact = width < 180;
  const first = player.revealedHoleCards[0] ?? null;
  const second = player.revealedHoleCards[1] ?? null;
  const stack = player.endingStack === null ? "-" : formatNumber(player.endingStack);
  const cardWidth = compact ? 30 : 42;
  const cardHeight = compact ? 44 : 58;
  const firstCardX = x + (compact ? 12 : 18);
  const secondCardX = x + (compact ? 47 : 66);
  return {
    degraded: common.degraded,
    svg: `${common.prefix}${playingCard(first, firstCardX, y + 67, cardWidth, cardHeight)}${playingCard(second, secondCardX, y + 67, cardWidth, cardHeight)}${vectorText("FINAL STACK", { x: x + width - (compact ? 10 : 18), y: y + 77, cell: compact ? .75 : 1.15, fill: COLORS.muted, align: "end" })}${vectorText(stack, { x: x + width - (compact ? 10 : 18), y: y + 101, cell: compact ? 1.25 : 2.1, fill: COLORS.gold, align: "end" })}</g>`,
  };
}

function renderSvg(projection: SocialCardProjection): { svg: string; degraded: boolean } {
  const tournament = safeText(projection.tournamentName, "HOLD'EM ARENA", 34);
  const title = safeText(projection.title, `HAND H${String(projection.handNo).padStart(3, "0")}`, 64);
  const summary = projection.summary
    ? safeText(projection.summary, "TOURNAMENT MOMENT", 120)
    : { value: "", degraded: false };
  const tag = safeText(projection.tagLabel, "KEY HAND", 18);
  const street = projection.spoilerMode === "SUSPENSE"
    ? safeText(projection.coverStreetLabel ?? "UNRESOLVED", "UNRESOLVED", 18)
    : safeText(projection.finalStreetLabel, "RESULT", 18);
  const potChips = projection.spoilerMode === "SUSPENSE"
    ? projection.coverPotChips
    : projection.finalPotChips;
  const potBigBlinds = projection.spoilerMode === "SUSPENSE"
    ? projection.coverPotBigBlinds
    : projection.finalPotBigBlinds;
  const board = projection.spoilerMode === "SUSPENSE" ? projection.coverBoard : projection.finalBoard;
  const titleLines = wrapVectorText(title.value, 430, 6, 2);
  const summaryLines = summary.value ? wrapVectorText(summary.value, 430, 2.1, 2) : [];
  let degraded = tournament.degraded || title.degraded || summary.degraded || tag.degraded || street.degraded;

  const playerWidth = projection.players.length === 3 ? 142 : 206;
  const playerGap = projection.players.length === 3 ? 10 : 12;
  const totalPlayersWidth = projection.players.length * playerWidth + (projection.players.length - 1) * playerGap;
  const playerStartX = 684 + (450 - totalPlayersWidth) / 2;
  const players = (projection.spoilerMode === "SUSPENSE"
    ? projection.players.map((player, index) => (
        suspensePlayerPanel(player, playerStartX + index * (playerWidth + playerGap), 384, playerWidth)
      ))
    : projection.players.map((player, index) => (
        resultPlayerPanel(player, playerStartX + index * (playerWidth + playerGap), 384, playerWidth)
      )))
    .map((panel) => {
      degraded ||= panel.degraded;
      return panel.svg;
    })
    .join("");

  const boardCards = Array.from({ length: 5 }, (_, index) => (
    playingCard(board[index] ?? null, 738 + index * 75, 226, 64, 92)
  )).join("");

  const titleSvg = titleLines.map((line, index) => vectorText(line, {
    x: 70,
    y: 206 + index * 56,
    cell: 6,
    fill: COLORS.paper,
  })).join("");
  const summarySvg = summaryLines.map((line, index) => vectorText(line, {
    x: 70,
    y: 340 + index * 24,
    cell: 2.1,
    fill: COLORS.muted,
  })).join("");
  const footer = projection.spoilerMode === "SUSPENSE"
    ? `<g data-social-card-action="play-to-reveal">${vectorText("RESULT HIDDEN", { x: 70, y: 621, cell: 1.6, fill: COLORS.gold })}${vectorText("PLAY TO REVEAL", { x: 1_130, y: 611, cell: 3.1, fill: COLORS.paper, align: "end" })}</g>`
    : (() => {
        const winnerCopy = safeText(
          projection.winners.map((winner) => `${winner.displayName} ${winner.netChange >= 0 ? "+" : ""}${formatNumber(winner.netChange)}`).join(" / "),
          "WINNER",
          56,
        );
        degraded ||= winnerCopy.degraded;
        return `${vectorText(projection.winners.length === 1 ? "WINNER" : "WINNERS", { x: 70, y: 621, cell: 1.6, fill: COLORS.gold })}${vectorText(winnerCopy.value, { x: 1_130, y: 611, cell: 2.4, fill: COLORS.paper, align: "end" })}`;
      })();

  const momentLabel = projection.spoilerMode === "SUSPENSE"
    ? `${tag.value} - UNRESOLVED`
    : `${tag.value} - TOURNAMENT RECORD`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="675" viewBox="0 0 1200 675"><defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${COLORS.feltDeep}"/><stop offset=".58" stop-color="${COLORS.felt}"/><stop offset="1" stop-color="#0c281d"/></linearGradient><radialGradient id="table" cx="50%" cy="45%" r="65%"><stop offset="0" stop-color="${COLORS.feltLight}"/><stop offset="1" stop-color="${COLORS.felt}"/></radialGradient><pattern id="grain" width="22" height="22" patternUnits="userSpaceOnUse"><circle cx="3" cy="3" r="1" fill="${COLORS.gold}" opacity=".08"/></pattern></defs><rect width="1200" height="675" fill="url(#bg)"/><rect width="1200" height="675" fill="url(#grain)"/><path d="M600 0V675" stroke="${COLORS.gold}" stroke-opacity=".05"/><g><rect x="70" y="54" width="48" height="48" rx="8" fill="none" stroke="${COLORS.rule}"/>${vectorText("A", { x: 83, y: 66, cell: 3.2, fill: COLORS.gold })}${suitShape("s", 104, 88, .55, COLORS.gold)}${vectorText("HOLD'EM ARENA", { x: 136, y: 58, cell: 2.2, fill: COLORS.paper })}${vectorText("MODEL POKER - TOURNAMENT MOMENT", { x: 136, y: 86, cell: 1.15, fill: COLORS.muted })}</g>${vectorText(tournament.value, { x: 1_130, y: 58, cell: 1.5, fill: COLORS.muted, align: "end" })}${vectorText(`H${String(projection.handNo).padStart(3, "0")}`, { x: 1_130, y: 82, cell: 2, fill: COLORS.gold, align: "end" })}${vectorText(momentLabel, { x: 70, y: 164, cell: 1.45, fill: COLORS.gold })}${titleSvg}${summarySvg}<path d="M70 482H520" stroke="${COLORS.rule}" stroke-opacity=".7"/>${vectorText("STREET", { x: 70, y: 506, cell: 1.2, fill: COLORS.muted })}${vectorText(street.value, { x: 70, y: 531, cell: 2, fill: COLORS.paper })}${vectorText("POT", { x: 252, y: 506, cell: 1.2, fill: COLORS.muted })}${vectorText(potChips === null ? "-" : formatNumber(potChips), { x: 252, y: 531, cell: 2, fill: COLORS.paper })}${vectorText("BB", { x: 420, y: 506, cell: 1.2, fill: COLORS.muted })}${vectorText(potBigBlinds === null ? "-" : formatBigBlinds(potBigBlinds), { x: 420, y: 531, cell: 2, fill: COLORS.paper })}<g><rect x="650" y="142" width="500" height="424" rx="96" fill="url(#table)" stroke="${COLORS.rule}" stroke-width="2"/><rect x="660" y="152" width="480" height="404" rx="86" fill="none" stroke="${COLORS.feltDeep}" stroke-width="10" opacity=".65"/>${vectorText("BOARD", { x: 900, y: 189, cell: 1.25, fill: COLORS.muted, align: "middle" })}${boardCards}${players}${projection.additionalPlayerCount > 0 ? vectorText(`+${projection.additionalPlayerCount}`, { x: 1_103, y: 176, cell: 1.6, fill: COLORS.gold, align: "end" }) : ""}</g><rect x="0" y="589" width="1200" height="86" fill="#07150f" fill-opacity=".82"/><path d="M0 589H1200" stroke="${COLORS.rule}"/>${footer}</svg>`;
  return { svg, degraded };
}

export function renderMomentSocialCardSvg(input: unknown): string {
  return renderSvg(parseSocialCardProjection(input)).svg;
}

export function renderMomentSocialCard(input: unknown): RenderedMomentSocialCard {
  const projection = parseSocialCardProjection(input);
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
  if (image.width !== MOMENT_SOCIAL_CARD_SIZE.width || image.height !== MOMENT_SOCIAL_CARD_SIZE.height) {
    throw new Error(`Unexpected social card size: ${image.width}x${image.height}`);
  }
  const png = image.asPng();
  if (png.length === 0 || png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
    throw new Error("Moment social card renderer returned an invalid PNG");
  }
  return {
    rendererVersion: MOMENT_SOCIAL_CARD_RENDERER_VERSION,
    mimeType: "image/png",
    width: MOMENT_SOCIAL_CARD_SIZE.width,
    height: MOMENT_SOCIAL_CARD_SIZE.height,
    projectionHash,
    pngSha256: createHash("sha256").update(png).digest("hex"),
    png,
    textFallbackApplied: rendered.degraded,
  };
}
