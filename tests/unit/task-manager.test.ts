import { beforeEach, describe, expect, it } from "vitest";
import { MemoryStore } from "../../src/storage/memory.js";
import { TaskManager, aggregateStatus } from "../../src/core/task-manager.js";
import type { ToolStatus } from "../../src/core/types.js";
let store: MemoryStore;
let manager: TaskManager;
beforeEach(() => { store = new MemoryStore(); manager = new TaskManager(store); });
describe("TaskManager", () => {
  it("deduplicates long token-shaped keys without storing their values or conflating different keys", async () => {
    const key = "a".repeat(100);
    const first = await manager.createTask("delegate", { task: "work" }, key);
    const second = await manager.createTask("delegate", { task: "work" }, key);
    const other = await manager.createTask("delegate", { task: "work" }, "b".repeat(100));
    expect(second.id).toBe(first.id);
    expect(other.id).not.toBe(first.id);
    expect(JSON.stringify(await store.getTask(first.id))).not.toContain(key);
  });
  it("deduplicates concurrent submissions and a running task", async () => {
    const records = await Promise.all(Array.from({ length: 10 }, () => manager.createTask("delegate", { task: "private task" }, "same-key")));
    expect(new Set(records.map((r) => r.id)).size).toBe(1);
    const first = records[0]!;
    await manager.setStatus(first.id, "running");
    expect((await manager.createTask("delegate", { task: "other" }, "same-key")).id).toBe(first.id);
    expect((await store.getTask(first.id))?.requestJson).not.toContain("private task");
  });
  it("returns undefined at the wait deadline and retains background work until completion", async () => {
    const task = await manager.createTask("delegate", { task: "work" });
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    manager.registerRun(task.id, gate.then(async () => { await manager.setStatus(task.id, "completed"); }));
    expect(await manager.waitFor(task.id, 5)).toBeUndefined(); expect(manager.hasRun(task.id)).toBe(true);
    finish(); expect((await manager.waitFor(task.id, 100))?.status).toBe("completed");
  });
  it("normalizes detached rejection without an unhandled rejection", async () => {
    const task = await manager.createTask("delegate", {});
    manager.registerRun(task.id, Promise.reject(new Error("failure")));
    expect((await manager.waitFor(task.id, 100))?.status).toBe("failed");
  });
  it("cancels the controller and preserves cancelled status against late completion", async () => {
    const task = await manager.createTask("delegate", {}); const signal = manager.signal(task.id);
    expect((await manager.cancel(task.id)).status).toBe("cancelled"); expect(signal.aborted).toBe(true);
    expect((await manager.setStatus(task.id, "completed")).status).toBe("cancelled");
  });
  it.each<[ToolStatus[], ToolStatus]>([[["completed", "completed"], "completed"], [["completed", "failed", "completed"], "partial_success"], [["failed", "failed"], "failed"], [["timed_out", "timed_out"], "timed_out"], [["cancelled", "cancelled"], "cancelled"], [["failed", "timed_out"], "failed"], [[], "failed"]])("aggregates %j as %s", (statuses, result) => { expect(aggregateStatus(statuses)).toBe(result); });
  it("recovers queued and running tasks without rerunning them", async () => {
    const a = await manager.createTask("delegate", {}); const b = await manager.createTask("delegate", {}); const c = await manager.createTask("delegate", {});
    await manager.setStatus(b.id, "running"); await manager.setStatus(c.id, "completed");
    expect(await manager.recoveredInterrupted()).toBe(2);
    expect((await store.getTask(a.id))?.status).toBe("interrupted"); expect((await store.getTask(b.id))?.status).toBe("interrupted"); expect((await store.getTask(c.id))?.status).toBe("completed");
  });
});
