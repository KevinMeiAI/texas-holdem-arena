import { Worker } from "node:worker_threads";
import type { SocialCardProjection } from "../../../../../packages/contracts/src/moment-social-card.js";
import type { RenderedMomentSocialCard } from "./moment-social-card-renderer.js";

interface WorkerSuccess extends Omit<RenderedMomentSocialCard, "png"> {
  ok: true;
  png: Uint8Array;
}

interface WorkerFailure {
  ok: false;
  message: string;
}

function workerMessage(value: unknown): WorkerSuccess | WorkerFailure | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.ok === false && typeof candidate.message === "string") {
    return { ok: false, message: candidate.message };
  }
  if (candidate.ok === true
    && candidate.png instanceof Uint8Array
    && typeof candidate.rendererVersion === "string"
    && candidate.mimeType === "image/png"
    && candidate.width === 1_200
    && candidate.height === 675
    && typeof candidate.projectionHash === "string"
    && typeof candidate.pngSha256 === "string"
    && typeof candidate.textFallbackApplied === "boolean") {
    return candidate as unknown as WorkerSuccess;
  }
  return null;
}

export function renderMomentSocialCardOffThread(
  projection: SocialCardProjection,
  timeoutMs = 10_000,
  workerUrl = new URL("./moment-social-card-worker.js", import.meta.url),
): Promise<RenderedMomentSocialCard> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerUrl, {
      workerData: projection,
    });
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      void worker.terminate();
      reject(new Error(`Moment social card worker timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timeout.unref();
    const clearWorkerTimeout = () => clearTimeout(timeout);
    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      clearWorkerTimeout();
      void worker.terminate();
      reject(error);
    };
    worker.once("message", (raw) => {
      if (settled) return;
      const message = workerMessage(raw);
      if (!message) {
        rejectOnce(new Error("Moment social card worker returned an invalid response"));
        return;
      }
      if (!message.ok) {
        rejectOnce(new Error(message.message));
        return;
      }
      settled = true;
      clearWorkerTimeout();
      resolve({
        rendererVersion: message.rendererVersion,
        mimeType: message.mimeType,
        width: message.width,
        height: message.height,
        projectionHash: message.projectionHash,
        pngSha256: message.pngSha256,
        textFallbackApplied: message.textFallbackApplied,
        png: Buffer.from(message.png),
      });
    });
    worker.once("error", (error) => rejectOnce(error));
    worker.once("exit", (code) => {
      if (code !== 0) rejectOnce(new Error(`Moment social card worker exited with code ${code}`));
      else if (!settled) rejectOnce(new Error("Moment social card worker exited without a response"));
    });
  });
}
