import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { SqliteStore } from "../../src/storage/sqlite.js";
import { loadConfig } from "../../src/core/config.js";
import { createLogger } from "../../src/core/logger.js";
import { Scheduler } from "../../src/core/scheduler.js";
import { TaskManager } from "../../src/core/task-manager.js";
import { TraceStore } from "../../src/core/trace-store.js";
import { Broker } from "../../src/core/broker.js";
import { MockProvider } from "../../src/providers/mock/index.js";
import { ProviderRegistry } from "../../src/providers/provider.js";
import type { ProviderConfig } from "../../src/core/types.js";

/**
 * SQLite persistence: reopen the same file, keep every row, keep ids/seq
 * monotonic, make migrations idempotent, and turn a task that was still
 * queued/running when the process died into `interrupted` (never re-run).
 */
let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "broker-sqlite-"));
  file = path.join(dir, "nested", "broker.sqlite");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function taskRow(overrides: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    kind: "run_worker" as const,
    status: "completed" as const,
    createdAt: now,
    updatedAt: now,
    requestJson: JSON.stringify({ schema: 1, data: { task: "hello" } }),
    traceId: randomUUID(),
    ...overrides,
  };
}

describe("SqliteStore", () => {
  it("creates the database file, applies migrations once, and survives a reopen", async () => {
    const store = new SqliteStore(file);
    await store.init();
    await store.init(); // idempotent
    const task = taskRow();
    await store.createTask(task);
    await store.createRun({ id: randomUUID(), taskId: task.id, provider: "mock", status: "completed", startedAt: task.createdAt, traceId: task.traceId });
    await store.appendEvent({ id: randomUUID(), traceId: task.traceId, taskId: task.id, seq: 0, timestamp: task.createdAt, type: "task.created", payload: { kind: "run_worker" } });
    await store.appendEvent({ id: randomUUID(), traceId: task.traceId, taskId: task.id, seq: 0, timestamp: task.createdAt, type: "task.completed", payload: { status: "completed" } });
    await store.saveArtifacts([{ id: randomUUID(), runId: "run-1", name: "out.txt", path: "/tmp/out.txt" }]);
    await store.close();

    const reopened = new SqliteStore(file);
    await reopened.init();
    const loaded = await reopened.getTask(task.id);
    expect(loaded).toMatchObject({ id: task.id, kind: "run_worker", status: "completed" });
    const events = await reopened.listEvents(task.traceId, "debug");
    // seq is assigned by the store, monotonically, inside a transaction.
    expect(events.map((event) => event.seq)).toEqual([1, 2]);
    expect((await reopened.listRunsByTask(task.id))[0]).toMatchObject({ provider: "mock", status: "completed" });
    expect(await reopened.listArtifactsByRun("run-1")).toHaveLength(1);
    await reopened.close();
  });

  it("persists a JSON schema wrapper so the shape is detectable", async () => {
    const store = new SqliteStore(file);
    await store.init();
    const task = taskRow();
    await store.createTask(task);
    expect(task.requestJson).toContain('"schema":1');
    await store.appendEvent({ id: randomUUID(), traceId: task.traceId, taskId: task.id, seq: 0, timestamp: task.createdAt, type: "note", payload: { nested: { value: 1 } } });
    const raw = (await store.listEvents(task.traceId, "debug"))[0]!;
    expect(raw.payload).toEqual({ nested: { value: 1 } });
    await store.close();
  });

  it("enforces a unique idempotency key at the database level", async () => {
    const store = new SqliteStore(file);
    await store.init();
    const key = "idem:abcdef";
    await store.createTask(taskRow({ idempotencyKey: key }));
    await expect(store.createTask(taskRow({ idempotencyKey: key }))).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect((await store.findTaskByIdempotencyKey(key))?.id).toBeTruthy();
    await store.close();
  });

  it("marks queued and running tasks as interrupted and reports one recovery event per task", async () => {
    const store = new SqliteStore(file);
    await store.init();
    const queued = taskRow({ status: "queued" });
    const running = taskRow({ status: "running" });
    const done = taskRow({ status: "completed" });
    for (const task of [queued, running, done]) await store.createTask(task);

    const config = await loadConfig();
    const providerConfig: ProviderConfig = { enabled: true, adapter: "mock", maxConcurrency: 1, defaultTimeoutMs: 1000 };
    const providers = new ProviderRegistry();
    providers.register("mock", new MockProvider("mock", providerConfig), providerConfig);
    config.providers = { mock: providerConfig };
    const broker = new Broker({
      config,
      store,
      logger: createLogger({ level: "silent" }),
      providers,
      scheduler: new Scheduler(config.concurrency, config.providers),
      traceStore: new TraceStore(store, config.trace),
      taskManager: new TaskManager(store, new TraceStore(store, config.trace)),
    });
    await broker.init();

    expect((await broker.getTask(queued.id)).status).toBe("interrupted");
    expect((await broker.getTask(running.id)).status).toBe("interrupted");
    expect((await broker.getTask(done.id)).status).toBe("completed");
    const recovered = await broker.getTrace(queued.traceId, "debug");
    expect(recovered.events.map((event) => event.type)).toContain("broker.recovered");
    await store.close();
  });

  it("deletes only rows older than the cutoff", async () => {
    const store = new SqliteStore(file);
    await store.init();
    const old = taskRow({ updatedAt: "2020-01-01T00:00:00.000Z" });
    const fresh = taskRow();
    await store.createTask(old);
    await store.createTask(fresh);
    await store.appendEvent({ id: randomUUID(), traceId: old.traceId, taskId: old.id, seq: 0, timestamp: "2020-01-01T00:00:00.000Z", type: "task.created", payload: {} });
    await store.appendEvent({ id: randomUUID(), traceId: fresh.traceId, taskId: fresh.id, seq: 0, timestamp: fresh.createdAt, type: "task.created", payload: {} });

    const removed = await store.deleteOlderThan("2021-01-01T00:00:00.000Z");
    expect(removed).toBe(1);
    expect(await store.getTask(old.id)).toBeUndefined();
    expect(await store.getTask(fresh.id)).toBeTruthy();
    expect(await store.listEvents(old.traceId, "debug")).toHaveLength(0);
    expect(await store.listEvents(fresh.traceId, "debug")).toHaveLength(1);
    await store.close();
  });

  it("refuses an invalid retention cutoff", async () => {
    const store = new SqliteStore(file);
    await store.init();
    await expect(store.deleteOlderThan("not-a-date")).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await store.close();
  });
});
