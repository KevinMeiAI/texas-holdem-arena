import { createHash } from "node:crypto";
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

function bodyHash(body: unknown): string {
  return createHash("sha256").update(JSON.stringify(body), "utf8").digest("hex");
}

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
        output_text: '{"type":"action","action":"check","amount_to":null,"decision_summary":"safe","query":null}',
        usage: { input_tokens: 12, output_tokens: 7, total_tokens: 19 },
      });
    }
    if (url.endsWith("/anthropic/messages")) {
      return jsonResponse({
        id: "msg_1",
        content: [{ type: "text", text: '{"type":"action","action":"call","amount_to":null,"decision_summary":null,"query":null}' }],
        usage: { input_tokens: 20, output_tokens: 4 },
      });
    }
    if (url.includes("/gemini/models/gemini-test:generateContent")) {
      return jsonResponse({
        responseId: "gem_1",
        candidates: [{ content: { parts: [{ text: '{"type":"action","action":"check","amount_to":null,"decision_summary":null,"query":null}' }] } }],
        usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 3, totalTokenCount: 12 },
      });
    }
    if (url.endsWith("/compatible/v1/chat/completions")) {
      return jsonResponse({
        id: "chat_1",
        choices: [{ message: { content: '{"type":"history_query","action":null,"amount_to":null,"decision_summary":null,"query":{"kind":"recent_hands","count":2,"limit":20}}' } }],
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

function strictRequest(): CanonicalModelRequest {
  return {
    ...request(),
    parserPolicy: "arena-parser-strict-v1",
    adapterProtocolVersion: "arena-adapters-v2",
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
    expect(bodyHash(body)).toBe("b0d5c3e2e3c1c20b0b7e49f8bd8be350d70494f5019d4422f70dead78bf28678");
    expect(result.transportAudit).toMatchObject({
      adapterVersion: "arena-adapters-v1",
      appliedOutputMode: "json_schema",
      renderedUserTextSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      redactedWireBodySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
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
    expect(bodyHash(captured.at(-1)?.body)).toBe("2991559ae6c5c312fcf5213e987ed381e331af63011454fc424cdbc2df2edf32");
    expect(result.transportAudit?.appliedOutputMode).toBe("json_schema");
  });

  it("maps Gemini structured action output", async () => {
    const provider = new GoogleGeminiProvider({
      ...common,
      provider: "google-gemini",
      model: "gemini-test",
      baseUrl: "https://provider.test/gemini",
    });
    const result = await provider.decide(request());
    expect(result.parsed).toEqual({ type: "action", action: "check" });
    expect(result.usage.totalTokens).toBe(12);
    expect(captured.at(-1)?.body).toMatchObject({
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: expect.any(Object),
      },
    });
    expect(bodyHash(captured.at(-1)?.body)).toBe("c677c0f59d45cee03d5afa5a6b675d1e319a1827f947de0b3b0157f027c76259");
    expect(result.transportAudit?.appliedSchemaSha256).toMatch(/^[a-f0-9]{64}$/);
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
    expect(bodyHash(captured.at(-1)?.body)).toBe("8c4aa3f99fa1d5b07fbd3b5e05a2c2eae2511798e1e44ff88b39b8e9a749c8f0");
    expect(result.transportAudit?.appliedOutputMode).toBe("json_object");
  });

  it("maps the xAI profile to OpenAI-compatible JSON Schema", async () => {
    const provider = new OpenAICompatibleProvider({
      ...common,
      provider: "openai-compatible",
      providerProfile: "xai",
      model: "grok-4",
      baseUrl: "https://provider.test/compatible/v1",
    });
    await provider.decide(request());
    expect(captured.at(-1)?.body).toMatchObject({
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "arena_action_or_history",
          schema: expect.any(Object),
          strict: true,
        },
      },
    });
  });

  it.each([
    ["qwen", "qwen3.8-max"],
    ["doubao", "doubao-seed-1-6-251015"],
    ["wenxin", "ernie-4.5-turbo-128k-preview"],
  ] as const)("maps the %s profile to the documented OpenAI-compatible JSON Schema envelope", async (providerProfile, model) => {
    const provider = new OpenAICompatibleProvider({
      ...common,
      provider: "openai-compatible",
      providerProfile,
      model,
      baseUrl: "https://provider.test/compatible/v1",
    });
    await provider.decide(request());
    expect(captured.at(-1)?.body).toMatchObject({
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "arena_action_or_history",
          schema: expect.any(Object),
          strict: true,
        },
      },
    });
  });

  it.each([
    ["qwen", "qwen-plus"],
  ] as const)("falls back to JSON Object for %s model %s", async (providerProfile, model) => {
    const provider = new OpenAICompatibleProvider({
      ...common,
      provider: "openai-compatible",
      providerProfile,
      model,
      baseUrl: "https://provider.test/compatible/v1",
    });
    await provider.decide(request());
    expect(captured.at(-1)?.body).toMatchObject({ response_format: { type: "json_object" } });
  });

  it.each([
    ["doubao", "doubao-seed-2-0-pro-260215"],
    ["wenxin", "ernie-5.1"],
    ["hunyuan", "hunyuan-turbos-latest"],
    ["minimax", "MiniMax-M2.5"],
  ] as const)("uses prompt-enforced JSON for unverified %s model %s", async (providerProfile, model) => {
    const provider = new OpenAICompatibleProvider({
      ...common,
      provider: "openai-compatible",
      providerProfile,
      model,
      baseUrl: "https://provider.test/compatible/v1",
    });
    await provider.decide(request());
    expect(captured.at(-1)?.body).not.toHaveProperty("response_format");
  });

  it("locks all v2 adapter wire fixtures", async () => {
    const fixtures: { provider: { decide(request: CanonicalModelRequest): Promise<unknown> }; expectedHash: string }[] = [
      {
        provider: new OpenAIResponsesProvider({
          ...common,
          provider: "openai-responses",
          baseUrl: "https://provider.test/openai",
        }),
        expectedHash: "44fdd3cc32e26693f4fcc5d46731740fb6d1ba7ab835c15e715d622c595d642e",
      },
      {
        provider: new AnthropicMessagesProvider({
          ...common,
          provider: "anthropic-messages",
          model: "claude-test",
          baseUrl: "https://provider.test/anthropic",
        }),
        expectedHash: "660a840a6655145034de496802bd572b27cf687dde3d5f035483431beda31b22",
      },
      {
        provider: new GoogleGeminiProvider({
          ...common,
          provider: "google-gemini",
          model: "gemini-test",
          baseUrl: "https://provider.test/gemini",
        }),
        expectedHash: "2186957664eb9eaa974a3074552ba2706ae7dc81686635b1f80d3a0b74b287c8",
      },
      {
        provider: new OpenAICompatibleProvider({
          ...common,
          provider: "openai-compatible",
          providerProfile: "xai",
          model: "grok-4",
          baseUrl: "https://provider.test/compatible/v1",
        }),
        expectedHash: "59e8ed5864640bf6b8956da850a6e4e2af7234ff649f9bad801d48e989c7ec5c",
      },
    ];
    for (const fixture of fixtures) {
      await fixture.provider.decide(strictRequest());
      expect(bodyHash(captured.at(-1)?.body)).toBe(fixture.expectedHash);
    }
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
