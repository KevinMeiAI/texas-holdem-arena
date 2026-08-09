import { ProviderCallError } from "./provider.js";

export interface JsonHttpResponse {
  status: number;
  headers: Headers;
  body: unknown;
}

function statusError(status: number): ProviderCallError {
  if (status === 401 || status === 403) {
    return new ProviderCallError("AUTH", `Provider authentication failed (${status})`, false, status);
  }
  if (status === 429) return new ProviderCallError("RATE_LIMIT", "Provider rate limit", true, status);
  if (status >= 500) return new ProviderCallError("SERVER", `Provider server error (${status})`, true, status);
  return new ProviderCallError("CONFIG", `Provider rejected request (${status})`, false, status);
}

export async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
): Promise<JsonHttpResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new ProviderCallError("TIMEOUT", "Provider response timed out", true);
      }
      throw new ProviderCallError("NETWORK", "Provider network request failed", true);
    }
    if (!response.ok) throw statusError(response.status);
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw new ProviderCallError("INVALID_RESPONSE", "Provider HTTP response was not JSON", false, response.status);
    }
    return { status: response.status, headers: response.headers, body: parsed };
  } finally {
    clearTimeout(timeout);
  }
}

export function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ProviderCallError("INVALID_RESPONSE", `Provider response is missing ${label}`, false);
  }
  return value;
}

export function finiteToken(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
