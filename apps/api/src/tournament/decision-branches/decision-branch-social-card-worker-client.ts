import { Worker } from "node:worker_threads";
import {
  DECISION_BRANCH_SOCIAL_CARD_RENDERER_VERSION,
  DECISION_BRANCH_SOCIAL_CARD_SIZE,
  type DecisionBranchSocialCardProjection,
} from "../../../../../packages/contracts/src/decision-branch-social-card.js";
import type { RenderedDecisionBranchSocialCard } from "./decision-branch-social-card-renderer.js";

interface WorkerSuccess extends Omit<RenderedDecisionBranchSocialCard, "png"> {
  ok: true;
  png: Uint8Array;
}

interface WorkerFailure {
  ok: false;
  message: string;
}

function sha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function workerMessage(value: unknown): WorkerSuccess | WorkerFailure | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.ok === false && typeof candidate.message === "string") {
    return { ok: false, message: candidate.message };
  }
  if (candidate.ok === true
    && candidate.png instanceof Uint8Array
    && candidate.rendererVersion === DECISION_BRANCH_SOCIAL_CARD_RENDERER_VERSION
    && candidate.mimeType === "image/png"
    && candidate.width === DECISION_BRANCH_SOCIAL_CARD_SIZE.width
    && candidate.height === DECISION_BRANCH_SOCIAL_CARD_SIZE.height
    && sha256(candidate.projectionHash)
    && sha256(candidate.pngSha256)
    && typeof candidate.textFallbackApplied === "boolean") {
    return candidate as unknown as WorkerSuccess;
  }
  return null;
}

export function renderDecisionBranchSocialCardOffThread(
  projection: DecisionBranchSocialCardProjection,
  timeoutMs = 10_000,
  workerUrl = new URL("./decision-branch-social-card-worker.js", import.meta.url),
): Promise<RenderedDecisionBranchSocialCard> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerUrl, { workerData: projection });
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      void worker.terminate();
      reject(new Error(`Decision Branch social card worker timed out after ${timeoutMs}ms`));
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
        rejectOnce(new Error("Decision Branch social card worker returned an invalid response"));
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
      if (code !== 0) rejectOnce(new Error(`Decision Branch social card worker exited with code ${code}`));
      else if (!settled) rejectOnce(new Error("Decision Branch social card worker exited without a response"));
    });
  });
}
