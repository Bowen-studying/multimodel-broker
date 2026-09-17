import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProviderConfig } from "../../src/core/types.js";
import { createHarness, type Harness } from "../fixtures/harness.js";
import { FakeHttpServer, reservedClosedPortUrl } from "../fixtures/fake-http.js";

/**
 * Retry policy is owned by the Broker, not the provider. These tests use a real
 * Broker plus the real OpenAI-compatible adapter against a scripted local
 * server: 429/5xx are retried within the bound, ambiguous post-send failures are
 * never retried, and connection failures are retried.
 */
let server: FakeHttpServer;
let baseUrl: string;
let harness: Harness;

const KEY = "sk-retry-test-0123456789abcdef";
process.env.BROKER_RETRY_TEST_KEY = KEY;

beforeEach(async () => {
  server = new FakeHttpServer();
  baseUrl = await server.start();
  // Health probes get their own answer so they never consume the scripted chat
  // responses and never inflate the request counts under test.
  server.modelsResponse = { status: 200, body: { data: [{ id: "test-model-1" }] } };
  const providerConfig: ProviderConfig = {
    enabled: true,
    adapter: "openai-compatible",
    model: "test-model-1",
    baseUrl,
    apiKeyEnv: "BROKER_RETRY_TEST_KEY",
    maxConcurrency: 4,
    defaultTimeoutMs: 2000,
  };
  harness = await createHarness({ providers: { deepseek: providerConfig }, routing: { general: { primary: "deepseek", fallback: [] } }, retryBaseDelayMs: 5, maxRetries: 2 });
});

afterEach(async () => {
  await server.stop();
});

const ok = { status: 200, body: { choices: [{ message: { content: "done" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } } };

describe("provider retry and failure classification", () => {
  it("retries a 429 and then succeeds", async () => {
    server.setScript([{ status: 429, body: { error: "rate limited" } }, ok]);
    const result = await harness.broker.runWorker({ worker: "deepseek", task: "retry me" });
    expect(result).toMatchObject({ ok: true, status: "completed" });
    expect(server.chatCount).toBe(2);
    const trace = await harness.broker.getTrace(result.traceId!, "debug");
    expect(trace.events.map((event) => event.type)).toContain("provider.retry");
  });

  it("retries transient 502/503 up to the bound and then succeeds", async () => {
    server.setScript([{ status: 502, body: {} }, { status: 503, body: {} }, ok]);
    const result = await harness.broker.runWorker({ worker: "deepseek", task: "5xx" });
    expect(result).toMatchObject({ ok: true, status: "completed" });
    expect(server.chatCount).toBe(3);
  });

  it("does NOT auto-retry a bare HTTP 500 (ambiguous, possibly already billed)", async () => {
    server.setScript([{ status: 500, body: {} }]);
    const result = await harness.broker.runWorker({ worker: "deepseek", task: "ambiguous 500" });
    expect(result).toMatchObject({ ok: false, status: "failed", error: { code: "PROVIDER_HTTP_5XX", retryable: false } });
    expect(server.chatCount).toBe(1);
  });

  it("gives up on a persistent 503 with a retryable 5xx error", async () => {
    server.setScript([{ status: 503, body: { error: "unavailable" } }]);
    const result = await harness.broker.runWorker({ worker: "deepseek", task: "persistent" });
    expect(result).toMatchObject({ ok: false, status: "failed", error: { code: "PROVIDER_HTTP_5XX", retryable: true } });
    // 1 initial attempt + maxRetries(2) = 3 requests, no more.
    expect(server.chatCount).toBe(3);
  });

  it("never retries a connection lost after the request was sent", async () => {
    server.setScript([{ destroy: true }]);
    const result = await harness.broker.runWorker({ worker: "deepseek", task: "ambiguous" });
    expect(result).toMatchObject({ ok: false, status: "failed", error: { code: "CONNECTION_LOST_AFTER_SEND", retryable: false } });
    // Exactly one request reached the server: a retry could double-bill.
    expect(server.chatCount).toBe(1);
  });

  it("retries a refused connection and reports CONNECTION_FAILED when it stays down", async () => {
    const deadUrl = await reservedClosedPortUrl();
    const dead = await createHarness({
      providers: {
        deepseek: {
          enabled: true,
          adapter: "openai-compatible",
          model: "test-model-1",
          baseUrl: deadUrl,
          apiKeyEnv: "BROKER_RETRY_TEST_KEY",
          maxConcurrency: 1,
          defaultTimeoutMs: 2000,
        },
      },
      routing: { general: { primary: "deepseek", fallback: [] } },
      retryBaseDelayMs: 5,
      maxRetries: 2,
    });
    const result = await dead.broker.runWorker({ worker: "deepseek", task: "connect" });
    expect(result).toMatchObject({ ok: false, status: "failed", error: { code: "CONNECTION_FAILED", retryable: true } });
    const trace = await dead.broker.getTrace(result.traceId!, "debug");
    expect(trace.events.filter((event) => event.type === "provider.retry")).toHaveLength(2);
  });

  it("records usage and never stores the API key in the trace", async () => {
    server.setScript([ok]);
    const result = await harness.broker.runWorker({ worker: "deepseek", task: "usage" });
    const trace = JSON.stringify(await harness.broker.getTrace(result.traceId!, "debug"));
    expect(trace).toContain('"inputTokens":1');
    expect(trace).not.toContain(KEY);
    expect(trace).not.toMatch(/Bearer|Authorization/i);
  });
});
