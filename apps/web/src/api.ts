import { useCallback, useEffect, useRef, useState } from "react";

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
  }
}

export async function apiRequest<T>(
  url: string,
  options: RequestInit & { csrfToken?: string } = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  if (options.csrfToken) headers.set("x-arena-csrf", options.csrfToken);
  const response = await fetch(url, { ...options, headers, credentials: "same-origin" });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const code = typeof payload.error === "string" ? payload.error : "request_failed";
    const message = typeof payload.message === "string" ? payload.message : code.replaceAll("_", " ");
    throw new ApiError(response.status, code, message);
  }
  return payload as T;
}

export function useApiResource<T>(url: string | null, intervalMs = 0) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(Boolean(url));
  const [error, setError] = useState<string | null>(null);
  const generationRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    if (!url) return;
    const generation = ++generationRef.current;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    try {
      const result = await apiRequest<T>(url, { signal: controller.signal });
      if (generation !== generationRef.current) return;
      setData(result);
      setError(null);
    } catch (reason) {
      if (controller.signal.aborted || generation !== generationRef.current) return;
      setError(reason instanceof Error ? reason.message : "Request failed");
    } finally {
      if (generation === generationRef.current) {
        controllerRef.current = null;
        setLoading(false);
      }
    }
  }, [url]);

  useEffect(() => {
    generationRef.current += 1;
    controllerRef.current?.abort();
    controllerRef.current = null;
    setData(null);
    setError(null);
    setLoading(Boolean(url));
    if (!url) return;
    let cancelled = false;
    let timer: number | null = null;
    const run = async () => {
      await refresh();
      if (!cancelled && intervalMs > 0) timer = window.setTimeout(() => void run(), intervalMs);
    };
    void run();
    return () => {
      cancelled = true;
      generationRef.current += 1;
      controllerRef.current?.abort();
      controllerRef.current = null;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [intervalMs, refresh, url]);

  return { data, setData, loading, error, refresh };
}
