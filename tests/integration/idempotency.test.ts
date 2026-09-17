import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ProviderConfig } from "../../src/core/types.js";
import { createHarness } from "../fixtures/harness.js";
import { MockProvider } from "../../src/providers/mock/index.js";
import { ProviderRegistry } from "../../src/providers/provider.js";
import { SqliteStore } from "../../src/storage/sqlite.js";

/**
 * `idempotencyKey` must collapse repeated submissions of the same logical task -
 * including while it is still running, and including across broker processes
 * that share one SQLite database - into a single execution.
 */
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "broker-idem-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const slow: ProviderConfig = { enabled: true, adapter: "mock", maxConcurrency: 4, defaultTimeoutMs: 5000, mock: { delayMs: 300, answer: "slow answer" } };
const fast: ProviderConfig = { enabled: true, adapter: "mock", maxConcurrency: 4, defaultTimeoutMs: 2000, mock: { answer: "fast answer" } };

describe("idempotency", () => {
  it("returns the same taskId twice and runs the worker only once", async () => {
    const provider = new MockProvider("fast", fast);
    const run = vi.spyOn(provider, "run");
    const registry = new ProviderRegistry();
    registry.register("fast", provider, fast);
    const harness = await createHarness({ providers: { fast }, routing: { general: { primary: "fast", fallback: [] } }, registry });

    const first = await harness.broker.delegate({ task: "same work", idempotencyKey: "key-1" });
    const second = await harness.broker.delegate({ task: "same work", idempotencyKey: "key-1" });
    expect(second.taskId).toBe(first.taskId);
    expect(second.traceId).toBe(first.traceId);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("returns the existing running task instead of starting a second execution", async () => {
    const provider = new MockProvider("slow", slow);
    const run = vi.spyOn(provider, "run");
    const registry = new ProviderRegistry();
    registry.register("slow", provider, slow);
    const harness = await createHarness({ providers: { slow }, routing: { general: { primary: "slow", fallback: [] } }, registry });

    const started = await harness.broker.delegate({ task: "long work", idempotencyKey: "key-2", waitMs: 50 });
    expect(started.status).toBe("running");
    const duplicates = await Promise.all(
      Array.from({ length: 4 }, () => harness.broker.delegate({ task: "long work", idempotencyKey: "key-2", waitMs: 0 })),
    );
    expect(duplicates.every((result) => result.taskId === started.taskId)).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    expect((await harness.taskManager.waitFor(started.taskId!, 3000))?.status).toBe("completed");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("never starts a second execution for a task another broker process owns (shared SQLite)", async () => {
    const file = path.join(dir, "shared.sqlite");
    const firstStore = new SqliteStore(file);
    const secondStore = new SqliteStore(file);
    const firstProvider = new MockProvider("slow", slow);
    const secondProvider = new MockProvider("slow", slow);
    const firstRun = vi.spyOn(firstProvider, "run");
    const secondRun = vi.spyOn(secondProvider, "run");
    const firstRegistry = new ProviderRegistry();
    const secondRegistry = new ProviderRegistry();
    firstRegistry.register("slow", firstProvider, slow);
    secondRegistry.register("slow", secondProvider, slow);

    const first = await createHarness({ providers: { slow }, routing: { general: { primary: "slow", fallback: [] } }, registry: firstRegistry, store: firstStore });
    const second = await createHarness({ providers: { slow }, routing: { general: { primary: "slow", fallback: [] } }, registry: secondRegistry, store: secondStore });

    const started = await first.broker.delegate({ task: "cross-process work", idempotencyKey: "shared-key", waitMs: 50 });
    expect(started.status).toBe("running");

    // The second broker sees a non-terminal task row for that key. It must wait,
    // not execute again: a second execution would be billed twice.
    const fromSecond = await second.broker.delegate({ task: "cross-process work", idempotencyKey: "shared-key", waitMs: 0 });
    expect(fromSecond.taskId).toBe(started.taskId);
    expect(secondRun).not.toHaveBeenCalled();
    expect(firstRun).toHaveBeenCalledTimes(1);

    const finished = await second.broker.getTask(started.taskId!);
    expect(["running", "completed"]).toContain(finished.status);
    await first.taskManager.waitFor(started.taskId!, 3000);
    await firstStore.close();
    await secondStore.close();
  });

  it("does not reuse a key for a different logical task without the caller asking for it", async () => {
    const harness = await createHarness({ providers: { fast }, routing: { general: { primary: "fast", fallback: [] } } });
    const one = await harness.broker.delegate({ task: "work A", idempotencyKey: "key-a" });
    const two = await harness.broker.delegate({ task: "work B", idempotencyKey: "key-b" });
    expect(two.taskId).not.toBe(one.taskId);
    expect(await harness.store.findTaskByIdempotencyKey("key-a")).toBeUndefined(); // stored as a digest, never raw
  });
});
