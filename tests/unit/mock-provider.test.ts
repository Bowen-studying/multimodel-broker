import { describe, expect, it } from "vitest";
import { MockProvider } from "../../src/providers/mock/index.js";
import type { WorkerRequest } from "../../src/core/types.js";
const request: WorkerRequest = { taskId: "task", runId: "run", task: "hello", timeoutMs: 10, traceLevel: "summary" };
describe("MockProvider", () => {
  it("returns templated answers and fixed usage", async () => {
    const mock = new MockProvider("worker", { answer: "{{worker}}: {{task}} / {{context}}", usage: { inputTokens: 3, outputTokens: 4, cost: 0.1 } });
    expect(await mock.run({ ...request, context: "world" }, new AbortController().signal)).toMatchObject({ answer: "worker: hello / world", status: "completed", usage: { inputTokens: 3, outputTokens: 4, cost: 0.1 } });
    expect(mock.capabilities).toEqual(["text", "mock"]); expect(mock.authMode).toBe("unknown"); expect((await mock.healthCheck()).healthy).toBe(true);
  });
  it("matches task prefixes in order for success/fail/timeout rules", async () => {
    const mock = new MockProvider("worker", { rules: [{ match: "ok", answer: "custom" }, { match: "bad", behavior: "fail", errorCode: "PROVIDER_AUTH" }, { match: "slow", behavior: "timeout" }] });
    expect((await mock.run({ ...request, task: "okay" }, new AbortController().signal)).answer).toBe("custom");
    await expect(mock.run({ ...request, task: "bad task" }, new AbortController().signal)).rejects.toMatchObject({ code: "PROVIDER_AUTH", retryable: false });
    await expect(mock.run({ ...request, task: "slow task" }, new AbortController().signal)).rejects.toMatchObject({ code: "TIMEOUT" });
  });
  it.each(["hang", "success", "timeout"] as const)("aborts %s and rejects a pre-aborted signal", async (behavior) => {
    const mock = new MockProvider("worker", { behavior, delayMs: 1000 }); const controller = new AbortController();
    const run = mock.run(request, controller.signal); controller.abort();
    await expect(run).rejects.toMatchObject({ code: "CANCELLED" });
    await expect(mock.run(request, controller.signal)).rejects.toMatchObject({ code: "CANCELLED" });
  });
  it("fails the first N attempts of each run with a retryable classification", async () => {
    const mock = new MockProvider("worker", { failFirstAttempts: 2 }); const signal = new AbortController().signal;
    for (let i = 0; i < 2; i++) await expect(mock.run(request, signal)).rejects.toMatchObject({ code: "PROVIDER_RATE_LIMITED", retryable: true });
    expect((await mock.run(request, signal)).status).toBe("completed");
    await expect(mock.run({ ...request, runId: "different" }, signal)).rejects.toMatchObject({ retryable: true });
  });
});
