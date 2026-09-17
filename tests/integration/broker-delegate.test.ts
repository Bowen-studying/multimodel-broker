import { beforeEach, describe, expect, it, vi } from "vitest";
import { Broker } from "../../src/core/broker.js";
import { loadConfig } from "../../src/core/config.js";
import { createLogger } from "../../src/core/logger.js";
import { Scheduler } from "../../src/core/scheduler.js";
import { TaskManager } from "../../src/core/task-manager.js";
import { TraceStore } from "../../src/core/trace-store.js";
import { BrokerError } from "../../src/core/errors.js";
import type { BrokerConfig, MockConfig } from "../../src/core/types.js";
import { MockProvider } from "../../src/providers/mock/index.js";
import { ProviderRegistry } from "../../src/providers/provider.js";
import { MemoryStore } from "../../src/storage/memory.js";
let config: BrokerConfig;
let store: MemoryStore;
let providers: ProviderRegistry;
let traces: TraceStore;
let manager: TaskManager;
let broker: Broker;
let scheduler: Scheduler;
const mocks = new Map<string, MockProvider>();
beforeEach(async () => {
  config = await loadConfig(); store = new MemoryStore(); providers = new ProviderRegistry(); mocks.clear();
  config.limits.retryBaseDelayMs = 1;
  const definitions: Record<string, MockConfig> = { code: { answer: "coding complete" }, success: { answer: "done", failFirstAttempts: 2 }, fail: { behavior: "fail" }, hang: { behavior: "hang" } };
  for (const [id, mock] of Object.entries(definitions)) {
    const pc = { enabled: true, adapter: "mock" as const, maxConcurrency: 2, defaultTimeoutMs: 1000, mock }; config.providers[id] = pc;
    const provider = new MockProvider(id, pc); providers.register(id, provider, pc); mocks.set(id, provider);
  }
  config.routing = { coding: { primary: "code", fallback: ["success"] }, general: { primary: "success" } };
  traces = new TraceStore(store, config.trace); manager = new TaskManager(store, traces); scheduler = new Scheduler(config.concurrency, config.providers);
  broker = new Broker({ config, store, logger: createLogger({ level: "silent" }), providers, scheduler, traceStore: traces, taskManager: manager });
  await broker.init();
});
describe("Broker delegation", () => {
  it("routes, completes, records usage, and returns an auditable route and trace", async () => {
    const result = await broker.delegate({ task: "write code", requirements: { coding: true } });
    expect(result).toMatchObject({ ok: true, status: "completed", data: { selectedWorker: "code", result: { answer: "coding complete", provider: "code" } } });
    expect(result.data?.routeReason).toMatch(/coding/); expect(result.traceId).toBeTruthy();
    const trace = await broker.getTrace(result.traceId!, "debug");
    expect(trace.events.map((e) => e.type)).toEqual(expect.arrayContaining(["route.selected", "run.started", "prompt.sent", "usage", "run.finished", "task.completed"]));
    expect(JSON.stringify(trace)).not.toContain("write code");
    const runs = await store.listRunsByTask(result.taskId!); expect(runs).toHaveLength(1); expect(runs[0]?.status).toBe("completed");
    expect(broker.ping().status).toBe("completed"); expect((await broker.listWorkers()).find((w) => w.id === "code")).toMatchObject({ healthy: true, authMode: "unknown", capabilities: ["text", "mock"] });
  });
  it("preserves every child outcome when one worker fails and two succeed", async () => {
    const batch = await broker.delegateBatch({ mode: "parallel", tasks: [{ worker: "code", task: "one" }, { worker: "fail", task: "two" }, { worker: "success", task: "three" }] });
    expect(batch.status).toBe("partial_success"); expect(batch.data?.children.map((c) => c.status)).toEqual(["completed", "failed", "completed"]);
    expect(batch.data?.children[0]?.data?.result?.answer).toBe("coding complete"); expect(batch.data?.children[2]?.data?.result?.answer).toBe("done");
    const task = await broker.getTask(batch.taskId!); expect(task.data?.children).toHaveLength(3); expect(task.data?.results).toHaveLength(3); expect(task.data?.completedChildren).toBe(3);
  });
  it("times out a hung worker and releases scheduler capacity", async () => {
    const result = await broker.runWorker({ worker: "hang", task: "timeout", timeoutMs: 10 });
    expect(result).toMatchObject({ ok: false, status: "timed_out", error: { code: "TIMEOUT", retryable: false } });
    expect(scheduler.stats().global.active).toBe(0);
  });
  it("enforces timeout even for a provider that ignores its abort signal", async () => {
    vi.spyOn(mocks.get("hang")!, "run").mockImplementation(() => new Promise(() => {}));
    expect((await broker.runWorker({ worker: "hang", task: "ignore", timeoutMs: 10 })).status).toBe("timed_out");
    expect(scheduler.stats().global.active).toBe(0);
  });
  it("retries bounded retryable failures and never retries ambiguous post-send failures", async () => {
    const success = vi.spyOn(mocks.get("success")!, "run");
    expect((await broker.delegate({ task: "retry" })).status).toBe("completed"); expect(success).toHaveBeenCalledTimes(3);
    const fail = vi.spyOn(mocks.get("fail")!, "run").mockRejectedValue(new BrokerError("CONNECTION_LOST_AFTER_SEND", "ambiguous"));
    expect((await broker.runWorker({ worker: "fail", task: "ambiguous" })).status).toBe("failed"); expect(fail).toHaveBeenCalledTimes(1);
    fail.mockClear().mockRejectedValue(new BrokerError("PROVIDER_HTTP_5XX", "temporary", { retryable: true }));
    expect((await broker.runWorker({ worker: "fail", task: "exhaust retries" })).status).toBe("failed"); expect(fail).toHaveBeenCalledTimes(3);
  });
  it("does not retry failures classified as nonretryable even with a normally retryable code", async () => {
    const run = vi.spyOn(mocks.get("fail")!, "run").mockRejectedValue(new BrokerError("PROVIDER_HTTP_5XX", "ambiguous HTTP 500", { retryable: false }));
    await broker.runWorker({ worker: "fail", task: "500" }); expect(run).toHaveBeenCalledTimes(1);
  });
  it("cancels queued and running tasks without overwriting their terminal state", async () => {
    const started = await broker.runWorkerLong({ worker: "hang", task: "cancel", waitMs: 0 });
    expect((await broker.cancelTask(started.taskId!)).status).toBe("cancelled");
    await manager.waitFor(started.taskId!, 100);
    expect((await broker.getTask(started.taskId!)).status).toBe("cancelled");
  });
  it("recovers tasks at startup without invoking providers", async () => {
    const queued = await manager.createTask("delegate", { task: "before restart" }, "recovery");
    const nextManager = new TaskManager(store, traces); const run = vi.spyOn(mocks.get("success")!, "run");
    const restarted = new Broker({ config, store, logger: createLogger({ level: "silent" }), providers, scheduler, traceStore: traces, taskManager: nextManager });
    await restarted.init();
    expect((await restarted.getTask(queued.id)).status).toBe("interrupted");
    expect((await restarted.delegate({ task: "before restart", idempotencyKey: "recovery" })).taskId).toBe(queued.id);
    expect(run).not.toHaveBeenCalled();
  });
  it("redacts secrets returned by providers before persistence and tool responses", async () => {
    const run = mocks.get("code")!.run.bind(mocks.get("code")!);
    vi.spyOn(mocks.get("code")!, "run").mockImplementation(async (req, signal) => ({ ...await run(req, signal), answer: "sk-provider-secret", evidence: [{ type: "text", content: "Authorization: Bearer hidden" }] }));
    const result = await broker.delegate({ task: "contains sk-user-secret", requirements: { coding: true } });
    const serialized = JSON.stringify([result, await broker.getTask(result.taskId!), await broker.getTrace(result.traceId!, "debug")]);
    expect(serialized).not.toMatch(/sk-provider-secret|sk-user-secret|Bearer hidden/);
    expect((await broker.getTask(result.taskId!, false)).data?.results).toBeUndefined();
    expect((await broker.getTask(result.taskId!, false)).data?.task.resultJson).toBeUndefined();
  });
});
