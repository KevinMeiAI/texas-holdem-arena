import { useCallback, useEffect, useState } from "react";

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

  const refresh = useCallback(async () => {
    if (!url) return;
    try {
      const result = await apiRequest<T>(url);
      setData(result);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Request failed");
    } finally {
      setLoading(false);
    }
  }, [url]);

  useEffect(() => {
    setLoading(Boolean(url));
    void refresh();
    if (!url || intervalMs <= 0) return;
    const timer = window.setInterval(() => void refresh(), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs, refresh, url]);

  return { data, setData, loading, error, refresh };
}
