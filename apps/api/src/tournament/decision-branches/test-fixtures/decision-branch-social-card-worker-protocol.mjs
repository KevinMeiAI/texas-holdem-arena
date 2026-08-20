import { parentPort, workerData } from "node:worker_threads";

if (!parentPort) throw new Error("Fixture requires a parent port");

if (workerData?.title === "FIXTURE HANG") {
  setInterval(() => undefined, 1_000);
} else if (workerData?.title === "FIXTURE ERROR") {
  parentPort.postMessage({ ok: false, message: "fixture renderer failed" });
} else if (workerData?.title === "FIXTURE INVALID") {
  parentPort.postMessage({ ok: true, mimeType: "text/plain" });
} else {
  const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  parentPort.postMessage({
    ok: true,
    rendererVersion: "decision-branch-social-card-renderer-v1",
    mimeType: "image/png",
    width: 1_200,
    height: 675,
    projectionHash: "a".repeat(64),
    pngSha256: "b".repeat(64),
    textFallbackApplied: false,
    png,
  }, [png.buffer]);
}
