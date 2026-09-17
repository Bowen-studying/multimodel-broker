import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProviderConfig } from "../../src/core/types.js";
import { createHarness, type Harness } from "../fixtures/harness.js";
import { FakeHttpServer } from "../fixtures/fake-http.js";

process.env.BROKER_TIMEOUT_TEST_KEY = "sk-timeout-test-0123456789abcdef";

let server: FakeHttpServer;
let harness: Harness;

beforeEach(async () => {
  server = new FakeHttpServer();
  const baseUrl = await server.start();
  server.modelsResponse = { status: 200, body: { data: [{ id: "test-model-1" }] } };
  const providerConfig: ProviderConfig = {
    enabled: true,
    adapter: "openai-compatible",
    model: "test-model-1",
    baseUrl,
    apiKeyEnv: "BROKER_TIMEOUT_TEST_KEY",
    maxConcurrency: 1,
    defaultTimeoutMs: 300,
  };
  harness = await createHarness({ providers: { deepseek: providerConfig }, routing: { general: { primary: "deepseek", fallback: [] } }, retryBaseDelayMs: 5, maxRetries: 0 });
});

afterEach(async () => {
  await server.stop();
});

describe("provider timeout", () => {
  it("times out a server that never answers and aborts the socket", async () => {
    server.setScript([{ hang: true }]);
    const result = await harness.broker.runWorker({ worker: "deepseek", task: "never answer", timeoutMs: 300 });
    expect(result).toMatchObject({ ok: false, status: "timed_out", error: { code: "TIMEOUT", retryable: false } });
    // The request really was aborted client-side, not merely reported as failed.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(server.closedConnections).toBeGreaterThan(0);
    expect(harness.scheduler.stats().global.active).toBe(0);
  });

  it("does not raise an unhandled rejection when a hung response arrives after the deadline", async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    server.setScript([{ hang: true }]);
    const result = await harness.broker.runWorker({ worker: "deepseek", task: "late response", timeoutMs: 250 });
    expect(result.status).toBe("timed_out");
    await new Promise((resolve) => setTimeout(resolve, 200));
    process.off("unhandledRejection", onRejection);
    expect(rejections).toEqual([]);
  });
});
