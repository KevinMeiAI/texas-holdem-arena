interface ClipboardWriter {
  writeText(value: string): Promise<void>;
}

interface DownloadLink {
  click(): void;
  remove(): void;
}

type RenderToBlob = (
  node: HTMLElement,
  options: Record<string, unknown>,
) => Promise<Blob | null>;

export interface CopyMomentLinkDependencies {
  clipboard?: ClipboardWriter | null;
  fallbackCopy?: ((value: string) => boolean) | null;
}

export interface DownloadMomentStoryCardDependencies {
  toBlob?: RenderToBlob;
  fontsReady?: PromiseLike<unknown> | null;
  waitForImages?: (node: HTMLElement) => Promise<void>;
  createObjectURL?: (blob: Blob) => string;
  revokeObjectURL?: (url: string) => void;
  createDownloadLink?: (url: string, filename: string) => DownloadLink;
}

const activeDownloads = new WeakMap<HTMLElement, Promise<void>>();

function browserClipboard(): ClipboardWriter | null {
  if (typeof navigator === "undefined") return null;
  return (navigator as Navigator & { clipboard?: ClipboardWriter }).clipboard ?? null;
}

function browserFallbackCopy(value: string): boolean {
  if (typeof document === "undefined" || typeof document.execCommand !== "function") return false;
  const field = document.createElement("textarea");
  field.value = value;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.insetInlineStart = "-10000px";
  field.style.opacity = "0";
  document.body.append(field);
  try {
    field.focus();
    field.select();
    return document.execCommand("copy");
  } finally {
    field.remove();
  }
}

export async function copyMomentLink(
  value: string,
  dependencies: CopyMomentLinkDependencies = {},
): Promise<void> {
  const normalized = value.trim();
  if (!normalized) throw new TypeError("Moment link cannot be empty");
  const clipboard = Object.prototype.hasOwnProperty.call(dependencies, "clipboard")
    ? dependencies.clipboard ?? null
    : browserClipboard();
  const fallback = Object.prototype.hasOwnProperty.call(dependencies, "fallbackCopy")
    ? dependencies.fallbackCopy ?? null
    : browserFallbackCopy;
  let primaryFailure: unknown = null;

  if (clipboard) {
    try {
      await clipboard.writeText(normalized);
      return;
    } catch (error) {
      primaryFailure = error;
    }
  }
  try {
    if (fallback?.(normalized)) return;
  } catch (error) {
    primaryFailure = error;
  }
  throw new Error("Unable to copy the moment link", { cause: primaryFailure });
}

async function waitForNodeImages(node: HTMLElement): Promise<void> {
  const images = [...node.querySelectorAll<HTMLImageElement>("img")];
  await Promise.all(images.map(async (image) => {
    if (!image.complete) {
      await new Promise<void>((resolve) => {
        image.addEventListener("load", () => resolve(), { once: true });
        image.addEventListener("error", () => resolve(), { once: true });
      });
    }
    if (typeof image.decode === "function") await image.decode().catch(() => undefined);
  }));
}

function browserDownloadLink(url: string, filename: string): DownloadLink {
  if (typeof document === "undefined") throw new Error("Downloads require a browser document");
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  document.body.append(link);
  return link;
}

async function performStoryCardDownload(
  node: HTMLElement,
  filename: string,
  dependencies: DownloadMomentStoryCardDependencies,
): Promise<void> {
  if (!filename.trim() || /[\\/]/.test(filename)) {
    throw new TypeError("Moment image filename is invalid");
  }
  if (dependencies.fontsReady !== null) {
    const fontsReady = dependencies.fontsReady
      ?? (typeof document !== "undefined" && "fonts" in document ? document.fonts.ready : null);
    if (fontsReady) await fontsReady;
  }
  await (dependencies.waitForImages ?? waitForNodeImages)(node);
  const toBlob = dependencies.toBlob
    ?? (await import("html-to-image")).toBlob as RenderToBlob;
  const blob = await toBlob(node, {
    width: 1_200,
    height: 675,
    pixelRatio: 1,
    cacheBust: true,
    backgroundColor: "#0d1d17",
  });
  if (!blob || blob.size === 0) throw new Error("Moment image export returned no data");

  const createObjectURL = dependencies.createObjectURL ?? URL.createObjectURL.bind(URL);
  const revokeObjectURL = dependencies.revokeObjectURL ?? URL.revokeObjectURL.bind(URL);
  const objectUrl = createObjectURL(blob);
  let link: DownloadLink | null = null;
  try {
    link = (dependencies.createDownloadLink ?? browserDownloadLink)(objectUrl, filename);
    link.click();
  } finally {
    link?.remove();
    revokeObjectURL(objectUrl);
  }
}

export function downloadMomentStoryCard(
  node: HTMLElement,
  filename: string,
  dependencies: DownloadMomentStoryCardDependencies = {},
): Promise<void> {
  const inFlight = activeDownloads.get(node);
  if (inFlight) return inFlight;
  let task: Promise<void>;
  task = performStoryCardDownload(node, filename, dependencies).finally(() => {
    if (activeDownloads.get(node) === task) activeDownloads.delete(node);
  });
  activeDownloads.set(node, task);
  return task;
}

// Moment and competitor cards share the same browser-safe export pipeline.
// Keep the original names as compatibility aliases for existing Moment UI.
export const copyShareLink = copyMomentLink;
export const downloadShareCard = downloadMomentStoryCard;
export type CopyShareLinkDependencies = CopyMomentLinkDependencies;
export type DownloadShareCardDependencies = DownloadMomentStoryCardDependencies;
