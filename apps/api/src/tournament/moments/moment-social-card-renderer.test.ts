import { describe, expect, it } from "vitest";
import {
  MOMENT_SOCIAL_CARD_PROJECTION_VERSION,
  MOMENT_SOCIAL_CARD_RENDERER_VERSION,
  type ResultSocialCardProjection,
  type SuspenseSocialCardProjection,
} from "../../../../../packages/contracts/src/moment-social-card.js";
import {
  renderMomentSocialCard,
  renderMomentSocialCardSvg,
} from "./moment-social-card-renderer.js";

function suspenseProjection(): SuspenseSocialCardProjection {
  return {
    version: MOMENT_SOCIAL_CARD_PROJECTION_VERSION,
    locale: "en",
    tournamentName: "Model Masters",
    handNo: 12,
    title: "A decision at the turn",
    summary: "Play the moment to reveal the result.",
    tagLabel: "Key hand",
    additionalPlayerCount: 3,
    spoilerMode: "SUSPENSE",
    coverStreetLabel: "TURN",
    coverBoard: ["As", "Kd", "Qc", "Jh"],
    coverPotChips: 4_500,
    coverPotBigBlinds: 45,
    players: [
      {
        playerId: "player-alpha",
        displayName: "Alpha",
        seat: 0,
        providerBrand: "chatgpt",
        position: "BTN",
        coverStack: 8_400,
        coverEquityPercent: 72.4,
        foldedAtCover: false,
        allInAtCover: false,
      },
      {
        playerId: "player-beta",
        displayName: "Beta",
        seat: 1,
        providerBrand: "claude",
        position: "SB",
        coverStack: 5_100,
        coverEquityPercent: 27.6,
        foldedAtCover: false,
        allInAtCover: true,
      },
      {
        playerId: "player-gamma",
        displayName: "Gamma",
        seat: 2,
        providerBrand: "gemini",
        position: "BB",
        coverStack: 0,
        coverEquityPercent: null,
        foldedAtCover: true,
        allInAtCover: false,
      },
    ],
  };
}

function resultProjection(): ResultSocialCardProjection {
  return {
    version: MOMENT_SOCIAL_CARD_PROJECTION_VERSION,
    locale: "en",
    tournamentName: "Model Masters",
    handNo: 12,
    title: "A river split pot",
    summary: "Two models divide the final pot.",
    tagLabel: "Split pot",
    additionalPlayerCount: 0,
    spoilerMode: "RESULT",
    finalStreetLabel: "RIVER",
    finalBoard: ["As", "Kd", "Qc", "Jh", "Ts"],
    finalPotChips: 12_000,
    finalPotBigBlinds: 120,
    players: [
      {
        playerId: "player-alpha",
        displayName: "Alpha",
        seat: 0,
        providerBrand: "chatgpt",
        position: "BTN",
        revealedHoleCards: ["Ah", "Ad"],
        endingStack: 12_900,
      },
      {
        playerId: "player-beta",
        displayName: "Beta",
        seat: 1,
        providerBrand: "claude",
        position: "BB",
        revealedHoleCards: ["Kh", "Kc"],
        endingStack: 12_900,
      },
    ],
    winners: [
      { playerId: "player-alpha", displayName: "Alpha", netChange: 6_000 },
      { playerId: "player-beta", displayName: "Beta", netChange: 6_000 },
    ],
  };
}

function expectPngDimensions(png: Buffer, width: number, height: number): void {
  expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  expect(png.subarray(12, 16).toString("ascii")).toBe("IHDR");
  expect(png.readUInt32BE(16)).toBe(width);
  expect(png.readUInt32BE(20)).toBe(height);
}

describe("moment social card renderer", () => {
  it("renders a deterministic 1200 by 675 PNG", () => {
    const rendered = Array.from({ length: 3 }, () => renderMomentSocialCard(suspenseProjection()));
    const first = rendered[0];
    if (!first) throw new Error("Expected a rendered card");

    expect(first.rendererVersion).toBe(MOMENT_SOCIAL_CARD_RENDERER_VERSION);
    expect(first.mimeType).toBe("image/png");
    expect(first.width).toBe(1_200);
    expect(first.height).toBe(675);
    expect(first.png.length).toBeGreaterThan(10_000);
    expectPngDimensions(first.png, 1_200, 675);
    expect(new Set(rendered.map((entry) => entry.projectionHash)).size).toBe(1);
    expect(new Set(rendered.map((entry) => entry.pngSha256)).size).toBe(1);
    expect(rendered.every((entry) => entry.png.equals(first.png))).toBe(true);
  });

  it("uses neutral hole-card backs for suspense", () => {
    const first = suspenseProjection();
    const firstSvg = renderMomentSocialCardSvg(first);
    expect(firstSvg).toContain('data-social-card-action="play-to-reveal"');
    expect(firstSvg.match(/data-card-face="back"/g)?.length).toBeGreaterThanOrEqual(7);
  });

  it("renders final cards and multiple winners only for result projections", () => {
    const svg = renderMomentSocialCardSvg(resultProjection());
    const rendered = renderMomentSocialCard(resultProjection());

    expect(svg).not.toContain('data-social-card-action="play-to-reveal"');
    expect(svg.match(/data-card-face="front"/g)?.length).toBe(9);
    expectPngDimensions(rendered.png, 1_200, 675);
  });

  it("contains no host-font, remote-image, or live text dependency", () => {
    const svg = renderMomentSocialCardSvg(suspenseProjection());
    expect(svg).not.toMatch(/<text\b/i);
    expect(svg).not.toMatch(/<image\b/i);
    expect(svg).not.toMatch(/font-family|@font-face|xlink:href|\shref=/i);
  });

  it("falls back deterministically for unsupported Unicode and markup-like copy", () => {
    const input: SuspenseSocialCardProjection = {
      ...suspenseProjection(),
      locale: "zh-CN",
      tournamentName: "模型冠军赛 ♠",
      title: "</title><script>alert(1)</script> 河牌逆转 🚨",
      summary: "谁会赢下底池？",
      tagLabel: "关键手牌",
      players: suspenseProjection().players.map((player, index) => ({
        ...player,
        displayName: index === 0 ? "深度思考模型" : player.displayName,
      })),
    };

    const first = renderMomentSocialCard(input);
    const second = renderMomentSocialCard(input);
    const svg = renderMomentSocialCardSvg(input);
    expect(first.textFallbackApplied).toBe(true);
    expect(first.pngSha256).toBe(second.pngSha256);
    expect(svg).not.toMatch(/<script|<\/title|河牌|🚨/i);
  });

  it("keeps long unbroken titles within the vector wrap budget", () => {
    const svg = renderMomentSocialCardSvg({
      ...suspenseProjection(),
      title: "SUPERCALIFRAGILISTICEXPIALIDOCIOUSSUPERCALIFRAGILISTIC",
    });
    expect(svg).toContain("<svg");
    expect(svg).not.toContain("SUPERCALIFRAGILISTIC");
    expect(renderMomentSocialCard({
      ...suspenseProjection(),
      title: "SUPERCALIFRAGILISTICEXPIALIDOCIOUSSUPERCALIFRAGILISTIC",
    }).textFallbackApplied).toBe(false);
  });
});
