import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CanonicalModelRequest } from "../../contracts/src/model-protocol.js";
import { AnthropicMessagesProvider } from "./anthropic-messages.js";
import { GoogleGeminiProvider } from "./google-gemini.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";
import { OpenAIResponsesProvider } from "./openai-responses.js";

interface CapturedRequest {
  url: string;
  headers: Headers;
  body: unknown;
}

const captured: CapturedRequest[] = [];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  captured.length = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    const body = JSON.parse(String(init?.body)) as unknown;
    captured.push({ url, headers, body });

    if (url.includes("/rate-limit/")) return jsonResponse({ error: "limit" }, 429);
    if (url.includes("/slow/")) {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    }
    if (url.includes("/invalid/")) {
      return jsonResponse({ choices: [{ message: { content: "not json" } }] });
    }
    if (url.endsWith("/openai/responses")) {
      return jsonResponse({
        id: "resp_1",
        output_text: '{"type":"action","action":"check","decision_summary":"safe"}',
        usage: { input_tokens: 12, output_tokens: 7, total_tokens: 19 },
      });
    }
    if (url.endsWith("/anthropic/messages")) {
      return jsonResponse({
        id: "msg_1",
        content: [{ type: "text", text: '{"type":"action","action":"call"}' }],
        usage: { input_tokens: 20, output_tokens: 4 },
      });
    }
    if (url.includes("/gemini/models/gemini-test:generateContent")) {
      return jsonResponse({
        responseId: "gem_1",
        candidates: [{ content: { parts: [{ text: '{"type":"runout_vote","accept_run_it_twice":true}' }] } }],
        usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 3, totalTokenCount: 12 },
      });
    }
    if (url.endsWith("/compatible/v1/chat/completions")) {
      return jsonResponse({
        id: "chat_1",
        choices: [{ message: { content: '{"type":"history_query","query":{"kind":"recent_hands","count":2,"limit":20}}' } }],
        usage: { prompt_tokens: 15, completion_tokens: 5, total_tokens: 20 },
      });
    }
    return jsonResponse({ error: "not found" }, 404);
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function request(expectedOutput: CanonicalModelRequest["expectedOutput"] = "ACTION_OR_HISTORY"): CanonicalModelRequest {
  return {
    requestId: "decision-1",
    expectedOutput,
    systemPrompt: "identical locked prompt",
    systemPromptHash: "a".repeat(64),
    userPayload: { legal_actions: { check: true } },
    timeoutMs: 500,
  };
}

const common = {
  model: "test",
  apiKey: "secret",
  timeoutMs: 500,
  parameters: {},
  providerProfile: "auto",
  providerDefaultOutputMode: "auto",
  outputMode: "inherit",
} as const;

describe("real provider transport adapters", () => {
  it("maps OpenAI Responses without changing the system prompt", async () => {
    const provider = new OpenAIResponsesProvider({
      ...common,
      provider: "openai-responses",
      baseUrl: "https://provider.test/openai",
    });
    const result = await provider.decide(request());
    expect(result.parsed).toMatchObject({ type: "action", action: "check" });
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 7, totalTokens: 19 });
    const body = captured.at(-1)?.body as {
      input?: { role: string; content: { text: string }[] }[];
      text?: { format?: { type?: string; strict?: boolean; schema?: unknown } };
    };
    expect(body.input?.[0]?.content[0]?.text).toBe("identical locked prompt");
    expect(body.text?.format).toMatchObject({ type: "json_schema", strict: true, schema: expect.any(Object) });
  });

  it("maps Anthropic Messages", async () => {
    const provider = new AnthropicMessagesProvider({
      ...common,
      provider: "anthropic-messages",
      model: "claude-test",
      baseUrl: "https://provider.test/anthropic",
    });
    const result = await provider.decide(request());
    expect(result.parsed).toMatchObject({ type: "action", action: "call" });
    expect(result.usage.totalTokens).toBe(24);
    expect(captured.at(-1)?.headers.get("x-api-key")).toBe("secret");
    expect(captured.at(-1)?.body).toMatchObject({
      output_config: { format: { type: "json_schema", schema: expect.any(Object) } },
    });
  });

  it("maps Gemini and keeps runout output separate", async () => {
    const provider = new GoogleGeminiProvider({
      ...common,
      provider: "google-gemini",
      model: "gemini-test",
      baseUrl: "https://provider.test/gemini",
    });
    const result = await provider.decide(request("RUNOUT_VOTE"));
    expect(result.parsed).toEqual({ type: "runout_vote", accept_run_it_twice: true });
    expect(result.usage.totalTokens).toBe(12);
    expect(captured.at(-1)?.body).toMatchObject({
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: expect.any(Object),
      },
    });
  });

  it("maps OpenAI-compatible chat completions and history queries", async () => {
    const provider = new OpenAICompatibleProvider({
      ...common,
      provider: "openai-compatible",
      baseUrl: "https://provider.test/compatible/v1",
    });
    const result = await provider.decide(request());
    expect(result.parsed).toMatchObject({ type: "history_query", query: { count: 2 } });
    expect(captured.at(-1)?.body).toMatchObject({ response_format: { type: "json_object" } });
  });

  it("classifies 429, timeout and protocol failures independently", async () => {
    const rateLimited = new OpenAICompatibleProvider({
      ...common,
      provider: "openai-compatible",
      baseUrl: "https://provider.test/rate-limit/v1",
    });
    await expect(rateLimited.decide(request())).rejects.toMatchObject({ kind: "RATE_LIMIT", retryable: true });

    const slow = new OpenAICompatibleProvider({
      ...common,
      provider: "openai-compatible",
      baseUrl: "https://provider.test/slow/v1",
    });
    await expect(slow.decide({ ...request(), timeoutMs: 10 })).rejects.toMatchObject({ kind: "TIMEOUT", retryable: true });

    const invalid = new OpenAICompatibleProvider({
      ...common,
      provider: "openai-compatible",
      baseUrl: "https://provider.test/invalid/v1",
    });
    await expect(invalid.decide(request())).rejects.toMatchObject({ kind: "INVALID_RESPONSE", retryable: false });
  });
});
