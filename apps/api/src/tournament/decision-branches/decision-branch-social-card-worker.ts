import { parentPort, workerData } from "node:worker_threads";
import { renderDecisionBranchSocialCard } from "./decision-branch-social-card-renderer.js";

if (!parentPort) throw new Error("Decision Branch social card worker requires a parent port");

try {
  const rendered = renderDecisionBranchSocialCard(workerData);
  const png = Uint8Array.from(rendered.png);
  parentPort.postMessage({
    ok: true,
    rendererVersion: rendered.rendererVersion,
    mimeType: rendered.mimeType,
    width: rendered.width,
    height: rendered.height,
    projectionHash: rendered.projectionHash,
    pngSha256: rendered.pngSha256,
    textFallbackApplied: rendered.textFallbackApplied,
    png,
  }, [png.buffer]);
} catch (error) {
  parentPort.postMessage({
    ok: false,
    message: error instanceof Error ? error.message : "Unknown renderer failure",
  });
}
