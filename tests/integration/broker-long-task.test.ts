import { describe, expect, it, vi } from "vitest";
import { Broker } from "../../src/core/broker.js";
import { loadConfig } from "../../src/core/config.js";
import { createLogger } from "../../src/core/logger.js";
import { Scheduler } from "../../src/core/scheduler.js";
import { TaskManager } from "../../src/core/task-manager.js";
import { TraceStore } from "../../src/core/trace-store.js";
import { MockProvider } from "../../src/providers/mock/index.js";
import { ProviderRegistry } from "../../src/providers/provider.js";
import { MemoryStore } from "../../src/storage/memory.js";

describe("long-running Broker tasks", () => {
  it("returns quickly, survives handler return, and reuses the same running and completed task", async () => {
    const config = await loadConfig();
    const pc = { enabled: true, adapter: "mock" as const, maxConcurrency: 1, defaultTimeoutMs: 10_000, mock: { delayMs: 1500, answer: "finished later" } };
    config.providers.mock = pc; config.routing.general = { primary: "mock" };
    const provider = new MockProvider("mock", pc); const run = vi.spyOn(provider, "run");
    const providers = new ProviderRegistry(); providers.register("mock", provider, pc);
    const store = new MemoryStore(); const traces = new TraceStore(store, config.trace); const manager = new TaskManager(store, traces);
    const broker = new Broker({ config, store, logger: createLogger({ level: "silent" }), providers, scheduler: new Scheduler(config.concurrency, config.providers), traceStore: traces, taskManager: manager });
    await broker.init(); const start = performance.now();
    const first = await broker.delegateLong({ task: "slow work", waitMs: 5, idempotencyKey: "one-logical-task" });
    // The call must return long before the ~1500 ms of work finishes. The bound
    // is generous on purpose: this asserts "did not block on completion", not a
    // machine-speed benchmark (the suite runs many test files in parallel).
    expect(performance.now() - start).toBeLessThan(700); expect(["running", "queued"]).toContain(first.status); expect(first.taskId).toBeTruthy(); expect(first.traceId).toBeTruthy();
    const duplicates = await Promise.all(Array.from({ length: 5 }, () => broker.delegateLong({ task: "slow work", waitMs: 0, idempotencyKey: "one-logical-task" })));
    expect(duplicates.every((result) => result.taskId === first.taskId)).toBe(true);
    expect((await manager.waitFor(first.taskId!, 5000))?.status).toBe("completed");
    const retrieved = await broker.getTask(first.taskId!);
    expect(retrieved.status).toBe("completed"); expect(retrieved.data?.results?.[0]?.answer).toBe("finished later"); expect(run).toHaveBeenCalledTimes(1);
    const again = await broker.delegateLong({ task: "slow work", waitMs: 5, idempotencyKey: "one-logical-task" });
    expect(again).toMatchObject({ taskId: first.taskId, status: "completed", data: { result: { answer: "finished later" } } }); expect(run).toHaveBeenCalledTimes(1);
  });
});
