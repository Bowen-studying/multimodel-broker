import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DeepSeekProvider } from "../../src/providers/deepseek/index.js";
import { GlmProvider } from "../../src/providers/glm/index.js";
import { ProviderRegistry } from "../../src/providers/provider.js";
import type { ProviderConfig, WorkerRequest } from "../../src/core/types.js";
import { FakeHttpServer } from "../fixtures/fake-http.js";

/**
 * Unit coverage for the OpenAI-compatible adapter against a scripted local
 * server. Everything here is verified against the fake server only; a real-key
 * smoke test is run separately (`npm run doctor`, CLI) and is NOT implied by
 * these tests passing.
 */
const KEY = "sk-test-key-do-not-log-0123456789abcdef";
let server: FakeHttpServer;
let baseUrl: string;

beforeEach(async () => {
  server = new FakeHttpServer();
  baseUrl = await server.start();
  process.env.BROKER_TEST_API_KEY = KEY;
});

afterEach(async () => {
  await server.stop();
  delete process.env.BROKER_TEST_API_KEY;
});

function config(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    enabled: true,
    adapter: "openai-compatible",
    model: "test-model-1",
    baseUrl,
    apiKeyEnv: "BROKER_TEST_API_KEY",
    maxConcurrency: 1,
    defaultTimeoutMs: 2000,
    ...overrides,
  };
}

function request(overrides: Partial<WorkerRequest> = {}): WorkerRequest {
  return { taskId: "t1", runId: "r1", task: "hello", timeoutMs: 2000, traceLevel: "summary", ...overrides };
}

describe("OpenAI-compatible provider", () => {
  it("returns answer, usage and the model actually used", async () => {
    server.setScript([
      {
        status: 200,
        body: {
          model: "test-model-1-2026",
          choices: [{ message: { role: "assistant", content: "the answer" } }],
          usage: { prompt_tokens: 11, completion_tokens: 22, prompt_cache_hit_tokens: 5 },
        },
      },
    ]);
    const provider = new DeepSeekProvider("deepseek", config());
    const result = await provider.run(request(), new AbortController().signal);
    expect(result).toMatchObject({ provider: "deepseek", status: "completed", answer: "the answer", model: "test-model-1-2026" });
    expect(result.usage).toMatchObject({ inputTokens: 11, outputTokens: 22, cacheHitTokens: 5 });
    // The wire request carries the configured model and never streams.
    const sent = JSON.parse(server.lastRequest!.body) as { model: string; stream: boolean; messages: Array<{ role: string; content: string }> };
    expect(sent.model).toBe("test-model-1");
    expect(sent.stream).toBe(false);
    expect(sent.messages[0]!.role).toBe("system");
    expect(sent.messages.at(-1)!.content).toContain("hello");
    expect(server.lastRequest!.headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it("separates hidden reasoning tokens from the billable completion count", async () => {
    // DeepSeek reports reasoning inside completion_tokens and details it separately. Without
    // this split, a 341-token completion looks comparable to a non-reasoning provider's 85.
    server.setScript([
      {
        status: 200,
        body: {
          id: "chatcmpl-reasoning",
          model: "deepseek-flash",
          choices: [{ message: { role: "assistant", content: "answer" } }],
          usage: {
            prompt_tokens: 44,
            completion_tokens: 341,
            prompt_tokens_details: { cached_tokens: 8 },
            completion_tokens_details: { reasoning_tokens: 249 },
          },
        },
      },
    ]);
    const provider = new DeepSeekProvider("deepseek", config({ model: "deepseek-flash" }));
    const result = await provider.run(request(), new AbortController().signal);
    expect(result.usage).toMatchObject({
      inputTokens: 44,
      outputTokens: 341,
      reasoningTokens: 249,
      cacheHitTokens: 8,
    });
  });

  it("maps 401 to a non-retryable PROVIDER_AUTH without leaking the key", async () => {
    server.setScript([{ status: 401, body: { error: { message: "invalid api key" } } }]);
    const provider = new GlmProvider("glm", config({ apiKeyEnv: "BROKER_TEST_API_KEY" }));
    await expect(provider.run(request(), new AbortController().signal)).rejects.toMatchObject({
      code: "PROVIDER_AUTH",
      retryable: false,
      httpStatus: 401,
    });
    const failure = await provider.run(request(), new AbortController().signal).catch((error: Error) => error);
    expect(JSON.stringify(failure)).not.toContain(KEY);
    expect(String((failure as Error).message)).not.toMatch(/Bearer|Authorization/i);
  });

  it("drops reasoning_content and refuses to answer with hidden thinking", async () => {
    server.setScript([
      {
        status: 200,
        body: { model: "test-model-1", choices: [{ message: { role: "assistant", content: "", reasoning_content: "SECRET CHAIN OF THOUGHT" } }] },
      },
    ]);
    const provider = new DeepSeekProvider("deepseek", config());
    const failure = await provider.run(request(), new AbortController().signal).catch((error: Error) => error as unknown as { code: string; message: string });
    expect(failure).toMatchObject({ code: "PROVIDER_BAD_RESPONSE" });
    expect(JSON.stringify(failure)).not.toContain("SECRET CHAIN OF THOUGHT");
  });

  it("reports a missing API key as SECRET_MISSING and still lists the worker as unavailable", async () => {
    const provider = new DeepSeekProvider("deepseek", config({ apiKeyEnv: "BROKER_TEST_KEY_THAT_DOES_NOT_EXIST" }));
    delete process.env.BROKER_TEST_KEY_THAT_DOES_NOT_EXIST;
    await expect(provider.run(request(), new AbortController().signal)).rejects.toMatchObject({ code: "SECRET_MISSING" });

    const registry = new ProviderRegistry();
    registry.register("deepseek", provider, config({ apiKeyEnv: "BROKER_TEST_KEY_THAT_DOES_NOT_EXIST" }));
    expect(registry.workerInfo()[0]).toMatchObject({ enabled: true, healthy: false, reasonUnavailable: "BROKER_TEST_KEY_THAT_DOES_NOT_EXIST not set" });
    expect(registry.available("deepseek")).toBe(false);
  });

  it("passes only the task/context text (never local files) for API workers", async () => {
    server.setScript([{ status: 200, body: { choices: [{ message: { content: "ok" } }] } }]);
    const provider = new GlmProvider("glm", config());
    await provider.run(request({ task: "TASK", context: "CTX", resolvedFiles: ["/etc/hostname"] }), new AbortController().signal);
    const body = server.lastRequest!.body;
    expect(body).toContain("TASK");
    expect(body).toContain("CTX");
    // GLM does not declare the "files" capability, so file contents are never uploaded.
    expect(body).not.toContain("/etc/hostname");
  });

  it("health check prefers the models endpoint, reports latency, and never returns the key", async () => {
    server.setScript([{ status: 200, body: { data: [{ id: "test-model-1" }] } }]);
    const provider = new DeepSeekProvider("deepseek", config());
    const health = await provider.healthCheck();
    expect(health.healthy).toBe(true);
    expect(health.details).toMatchObject({ mode: "models", httpStatus: 200 });
    expect(JSON.stringify(health)).not.toContain(KEY);
    expect(server.lastRequest!.url).toContain("/models");
  });

  it("falls back to a 1-token chat probe when /models is unsupported", async () => {
    server.setScript([{ status: 404, body: { error: "not found" } }, { status: 200, body: { choices: [{ message: { content: "pong" } }] } }]);
    const provider = new GlmProvider("glm", config());
    const health = await provider.healthCheck();
    expect(health.healthy).toBe(true);
    expect(health.details).toMatchObject({ mode: "chat" });
    expect(server.count).toBe(2);
    expect(JSON.parse(server.lastRequest!.body)).toMatchObject({ max_tokens: 1 });
  });

  it("reports an unhealthy provider without throwing when the endpoint fails", async () => {
    server.setScript([{ status: 503, body: { error: "unavailable" } }]);
    const health = await new DeepSeekProvider("deepseek", config()).healthCheck();
    expect(health.healthy).toBe(false);
    expect(health.reason).toMatch(/HTTP 503/);
  });

  it("is constructible without a base URL (so a disabled provider can still be listed) but fails loudly when used", async () => {
    const withoutUrl = { ...config(), baseUrl: "" };
    const provider = new DeepSeekProvider("deepseek", withoutUrl);
    const health = await provider.healthCheck();
    expect(health).toMatchObject({ healthy: false });
    expect(health.reason).toMatch(/baseUrl/);
    await expect(provider.run(request(), new AbortController().signal)).rejects.toMatchObject({ code: "CONFIG_ERROR" });
  });
});
