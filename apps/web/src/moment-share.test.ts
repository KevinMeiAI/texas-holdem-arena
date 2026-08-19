import { describe, expect, it, vi } from "vitest";
import { canonicalMomentUrl, momentStoryCardFilename } from "./moment-story-card-model";
import { copyMomentLink, downloadMomentStoryCard } from "./moment-share";

describe("moment sharing", () => {
  it("copies with the Clipboard API when available", async () => {
    const writeText = vi.fn(async () => undefined);
    const fallbackCopy = vi.fn(() => true);
    await copyMomentLink("https://arena.example/moments/final-hand", {
      clipboard: { writeText },
      fallbackCopy,
    });
    expect(writeText).toHaveBeenCalledWith("https://arena.example/moments/final-hand");
    expect(fallbackCopy).not.toHaveBeenCalled();
  });

  it("falls back when the Clipboard API rejects", async () => {
    const fallbackCopy = vi.fn(() => true);
    await copyMomentLink("https://arena.example/moments/final-hand", {
      clipboard: { writeText: vi.fn(async () => { throw new Error("denied"); }) },
      fallbackCopy,
    });
    expect(fallbackCopy).toHaveBeenCalledWith("https://arena.example/moments/final-hand");
  });

  it("reports a clear error when neither copy path succeeds", async () => {
    await expect(copyMomentLink("https://arena.example/moments/final-hand", {
      clipboard: { writeText: vi.fn(async () => { throw new Error("denied"); }) },
      fallbackCopy: () => false,
    })).rejects.toThrow("Unable to copy the moment link");
  });

  it("uses canonical URLs and safe PNG filenames from the story-card helpers", () => {
    expect(canonicalMomentUrl("https://arena.example/app", "Final-Hand"))
      .toBe("https://arena.example/moments/final-hand");
    expect(momentStoryCardFilename({ handNo: 19, slug: "final-hand" }))
      .toBe("arena-h019-final-hand.png");
  });

  it("downloads a rendered card and always revokes its object URL", async () => {
    const blob = new Blob(["png"], { type: "image/png" });
    const click = vi.fn();
    const remove = vi.fn();
    const revokeObjectURL = vi.fn();
    const waitForImages = vi.fn(async () => undefined);
    const node = {} as HTMLElement;

    await downloadMomentStoryCard(node, "arena-h019-final-hand.png", {
      fontsReady: Promise.resolve(),
      waitForImages,
      toBlob: vi.fn(async () => blob),
      createObjectURL: vi.fn(() => "blob:moment"),
      revokeObjectURL,
      createDownloadLink: vi.fn(() => ({ click, remove })),
    });

    expect(waitForImages).toHaveBeenCalledWith(node);
    expect(click).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:moment");
  });

  it("rejects empty image output without creating a download URL", async () => {
    const createObjectURL = vi.fn(() => "blob:empty");
    await expect(downloadMomentStoryCard({} as HTMLElement, "moment.png", {
      fontsReady: null,
      waitForImages: async () => undefined,
      toBlob: async () => new Blob([]),
      createObjectURL,
    })).rejects.toThrow("returned no data");
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it("propagates renderer failures without constructing a download", async () => {
    const createDownloadLink = vi.fn();
    await expect(downloadMomentStoryCard({} as HTMLElement, "moment.png", {
      fontsReady: null,
      waitForImages: async () => undefined,
      toBlob: async () => { throw new Error("renderer failed"); },
      createDownloadLink,
    })).rejects.toThrow("renderer failed");
    expect(createDownloadLink).not.toHaveBeenCalled();
  });
});
