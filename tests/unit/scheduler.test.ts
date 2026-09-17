import { describe, expect, it } from "vitest";
import { Semaphore, Scheduler } from "../../src/core/scheduler.js";
const delay = () => new Promise<void>((resolve) => setTimeout(resolve, 5));
describe("semaphores and scheduler", () => {
  it("maintains FIFO and makes release idempotent", async () => {
    const semaphore = new Semaphore(1); const first = await semaphore.acquire(); const order: number[] = [];
    const pending = [1, 2, 3].map(async (id) => { const release = await semaphore.acquire(); order.push(id); release(); release(); });
    expect(semaphore.stats()).toEqual({ capacity: 1, active: 1, queued: 3 });
    first(); first(); await Promise.all(pending);
    expect(order).toEqual([1, 2, 3]); expect(semaphore.stats().active).toBe(0);
  });
  it("enforces global and per-provider caps under concurrent load", async () => {
    const scheduler = new Scheduler({ global: 3, a: 1, b: 2 });
    let global = 0; let peak = 0; const active = { a: 0, b: 0 }; const peaks = { a: 0, b: 0 };
    await Promise.all(Array.from({ length: 20 }, (_, index) => {
      const id = index % 2 ? "a" : "b";
      return scheduler.run(id, async () => { global++; active[id]++; peak = Math.max(peak, global); peaks[id] = Math.max(peaks[id], active[id]); await delay(); active[id]--; global--; });
    }));
    expect(peak).toBeLessThanOrEqual(3); expect(peak).toBeGreaterThan(1); expect(peaks.a).toBe(1); expect(peaks.b).toBe(2);
    expect(scheduler.stats().global.active).toBe(0);
  });
  it("preserves provider FIFO and releases both permits on error", async () => {
    const scheduler = new Scheduler({ global: 3, a: 1 }); const order: number[] = [];
    const results = await Promise.allSettled([1, 2, 3].map((id) => scheduler.run("a", async () => { order.push(id); await delay(); if (id === 1) throw new Error("failure"); return id; })));
    expect(order).toEqual([1, 2, 3]); expect(results[0]?.status).toBe("rejected");
    expect(scheduler.stats().global.active).toBe(0); expect(scheduler.stats().providers.a?.active).toBe(0);
  });
});
