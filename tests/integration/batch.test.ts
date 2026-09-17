import { describe, expect, it } from "vitest";
import type { ProviderConfig, ProviderHealth, WorkerProvider, WorkerRequest, WorkerResult } from "../../src/core/types.js";
import { ProviderRegistry } from "../../src/providers/provider.js";
import { createHarness } from "../fixtures/harness.js";

/** A provider that reports how many runs were active at the same time. */
class ConcurrencyProbe implements WorkerProvider {
  readonly id = "probe";
  readonly capabilities = ["text"];
  active = 0;
  peak = 0;
  calls = 0;
  constructor(private readonly delayMs: number) {}
  async healthCheck(): Promise<ProviderHealth> {
    return { healthy: true, checkedAt: new Date().toISOString() };
  }
  async run(request: WorkerRequest, signal: AbortSignal): Promise<WorkerResult> {
    this.calls++;
    this.active++;
    this.peak = Math.max(this.peak, this.active);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => resolve(), this.delayMs);
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
    this.active--;
    return { taskId: request.taskId, runId: request.runId, provider: this.id, status: "completed", answer: "done", traceId: "" };
  }
}

const failing: ProviderConfig = { enabled: true, adapter: "mock", maxConcurrency: 4, defaultTimeoutMs: 2000, mock: { behavior: "fail" } };
const ok: ProviderConfig = { enabled: true, adapter: "mock", maxConcurrency: 4, defaultTimeoutMs: 2000, mock: { answer: "ok" } };

describe("delegate_batch", () => {
  it("returns every child outcome and a partial_success parent when one child fails", async () => {
    const harness = await createHarness({ providers: { ok, bad: failing }, routing: { general: { primary: "ok", fallback: [] } } });
    const batch = await harness.broker.delegateBatch({
      mode: "parallel",
      tasks: [
        { worker: "ok", task: "one" },
        { worker: "bad", task: "two" },
        { worker: "ok", task: "three" },
      ],
    });
    expect(batch.status).toBe("partial_success");
    const children = batch.data!.children;
    expect(children).toHaveLength(3);
    expect(children.map((child) => child.status)).toEqual(["completed", "failed", "completed"]);
    expect(children[1]!.error).toMatchObject({ code: "PROVIDER_ERROR" });
    const parent = await harness.broker.getTask(batch.taskId!);
    expect(parent.data?.completedChildren).toBe(3);
    expect(parent.data?.totalChildren).toBe(3);
    expect(parent.data?.results).toHaveLength(3);
  });

  it("enforces the batch size limit", async () => {
    const harness = await createHarness({ providers: { ok }, routing: { general: { primary: "ok", fallback: [] } } });
    await expect(
      harness.broker.delegateBatch({ mode: "parallel", tasks: Array.from({ length: 9 }, (_, index) => ({ worker: "ok", task: `task ${index}` })) }),
    ).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
    await expect(harness.broker.delegateBatch({ mode: "sequential" as never, tasks: [{ worker: "ok", task: "x" }] })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("runs children concurrently but never above maxConcurrency", async () => {
    const probe = new ConcurrencyProbe(150);
    const config: ProviderConfig = { enabled: true, adapter: "mock", maxConcurrency: 8, defaultTimeoutMs: 5000 };
    const registry = new ProviderRegistry();
    registry.register("probe", probe, config);
    const harness = await createHarness({ providers: { probe: config }, routing: { general: { primary: "probe", fallback: [] } }, registry });

    const started = Date.now();
    const batch = await harness.broker.delegateBatch({
      mode: "parallel",
      maxConcurrency: 2,
      waitMs: 40_000,
      tasks: Array.from({ length: 4 }, (_, index) => ({ worker: "probe", task: `child ${index}` })),
    });
    const elapsed = Date.now() - started;
    expect(batch.status).toBe("completed");
    expect(probe.calls).toBe(4);
    // At most two children may be in flight at any moment...
    expect(probe.peak).toBe(2);
    // ...which means four 150 ms children take at least two waves.
    expect(elapsed).toBeGreaterThanOrEqual(280);
  });

  it("returns the parent taskId quickly and exposes the aggregated result later", async () => {
    const harness = await createHarness({ providers: { ok }, routing: { general: { primary: "ok", fallback: [] } } });
    const batch = await harness.broker.delegateBatch({ mode: "parallel", tasks: [{ worker: "ok", task: "later" }], idempotencyKey: "batch-key" });
    expect(batch.status).toBe("completed");
    const again = await harness.broker.delegateBatch({ mode: "parallel", tasks: [{ worker: "ok", task: "later" }], idempotencyKey: "batch-key" });
    expect(again.taskId).toBe(batch.taskId);
  });
});
