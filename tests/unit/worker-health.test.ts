import { describe, expect, it } from "vitest";
import { ProviderRegistry } from "../../src/providers/provider.js";
import type { ProviderConfig, ProviderHealth, WorkerProvider, WorkerRequest, WorkerResult } from "../../src/core/types.js";

/**
 * `list_workers` is what a human or a model looks at before delegating, so the
 * health it reports has to be a fact, not an empty cache. These tests pin the
 * "probe on demand, then cache" behaviour without any network access.
 */
class ProbedProvider implements WorkerProvider {
  readonly capabilities = ["text"];
  checks = 0;
  constructor(readonly id: string, private readonly outcome: () => ProviderHealth | Promise<ProviderHealth>) {}
  async healthCheck(): Promise<ProviderHealth> {
    this.checks += 1;
    return this.outcome();
  }
  async run(request: WorkerRequest): Promise<WorkerResult> {
    return { taskId: request.taskId, runId: request.runId, provider: this.id, status: "completed", answer: "ok", traceId: "" };
  }
}

const config = (extra: Partial<ProviderConfig> = {}): ProviderConfig => ({ enabled: true, adapter: "mock", maxConcurrency: 1, defaultTimeoutMs: 1000, ...extra });
const healthy = (): ProviderHealth => ({ healthy: true, checkedAt: new Date().toISOString() });

describe("worker health reporting", () => {
  it("says 'pending' before a probe and reports the real answer after refreshAll", async () => {
    const registry = new ProviderRegistry();
    const provider = new ProbedProvider("mock", healthy);
    registry.register("mock", provider, config());

    // Before any probe the cache is empty - the state ChatGPT saw as
    // "Health check pending" while run_worker still worked.
    expect(registry.workerInfo()[0]).toMatchObject({ healthy: false, reasonUnavailable: "Health check pending" });

    await registry.refreshAll();
    expect(provider.checks).toBe(1);
    expect(registry.workerInfo()[0]).toMatchObject({ healthy: true, reasonUnavailable: undefined });
  });

  it("caches probes so a second refresh inside the TTL does not probe again", async () => {
    const registry = new ProviderRegistry();
    const provider = new ProbedProvider("mock", healthy);
    registry.register("mock", provider, config());

    await registry.refreshAll();
    await registry.refreshAll();
    expect(provider.checks).toBe(1);
  });

  it("surfaces a failing probe as unhealthy with its reason, never as pending", async () => {
    const registry = new ProviderRegistry();
    registry.register("bad", new ProbedProvider("bad", () => ({ healthy: false, checkedAt: new Date().toISOString(), reason: "quota exhausted" })), config());
    registry.register("boom", new ProbedProvider("boom", () => { throw new Error("socket hang up"); }), config());

    await registry.refreshAll();
    const workers = registry.workerInfo();
    expect(workers.find((worker) => worker.id === "bad")).toMatchObject({ healthy: false, reasonUnavailable: "quota exhausted" });
    expect(workers.find((worker) => worker.id === "boom")).toMatchObject({ healthy: false, reasonUnavailable: "socket hang up" });
  });

  it("does not probe disabled providers and still explains why they are unavailable", async () => {
    const registry = new ProviderRegistry();
    const disabled = new ProbedProvider("off", healthy);
    registry.register("off", disabled, config({ enabled: false }));

    await registry.refreshAll();
    expect(disabled.checks).toBe(0);
    expect(registry.workerInfo()[0]).toMatchObject({ enabled: false, healthy: false, reasonUnavailable: "Worker disabled" });
  });

  it("still reports a missing key as the reason, even when the probe succeeds", async () => {
    const registry = new ProviderRegistry();
    registry.register("keyed", new ProbedProvider("keyed", healthy), config({ apiKeyEnv: "BROKER_TEST_KEY_THAT_DOES_NOT_EXIST" }));

    await registry.refreshAll();
    expect(registry.workerInfo()[0]).toMatchObject({ enabled: true, healthy: false, reasonUnavailable: "BROKER_TEST_KEY_THAT_DOES_NOT_EXIST not set" });
  });
});
