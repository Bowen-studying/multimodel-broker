import { createHash, randomUUID } from "node:crypto";
import { redact } from "../security/redaction.js";
import { BrokerError, toBrokerError } from "./errors.js";
import type { Clock, Store, TaskRecord, ToolStatus } from "./types.js";
import { TraceStore } from "./trace-store.js";

export const isTerminal = (status: ToolStatus): boolean => status !== "queued" && status !== "running";
export function aggregateStatus(children: Array<ToolStatus | { status: ToolStatus }>): "completed" | "partial_success" | "failed" | "timed_out" | "cancelled" {
  const statuses = children.map((child) => typeof child === "string" ? child : child.status);
  if (!statuses.length) return "failed";
  if (statuses.every((s) => s === "completed")) return "completed";
  if (statuses.some((s) => s === "completed" || s === "partial_success")) return "partial_success";
  if (statuses.every((s) => s === "cancelled")) return "cancelled";
  if (statuses.every((s) => s === "timed_out")) return "timed_out";
  return "failed";
}

export class TaskManager {
  private readonly controllers = new Map<string, AbortController>();
  private readonly runs = new Map<string, Promise<void>>();
  private creation: Promise<unknown> = Promise.resolve();
  private readonly traces: TraceStore;
  constructor(private readonly store: Store, traceStore?: TraceStore, private readonly clock: Clock = { now: () => new Date() }) {
    this.traces = traceStore ?? new TraceStore(store, { storePrompts: false, retentionDays: 30 }, clock);
  }
  createTask(kind: TaskRecord["kind"], request: unknown, idempotencyKey?: string): Promise<TaskRecord> {
    return this.findOrCreateTask(kind, request, idempotencyKey).then((result) => result.task);
  }

  /**
   * Idempotent task creation. `reused` is true when an existing task matched the
   * idempotency key: the caller must NOT start a second execution for it (this is
   * what prevents a duplicate paid run when two broker processes share a SQLite
   * database).
   */
  findOrCreateTask(kind: TaskRecord["kind"], request: unknown, idempotencyKey?: string): Promise<{ task: TaskRecord; reused: boolean }> {
    // Persist a digest, never a caller-supplied key that might itself be a secret.
    // Grouping keeps the digest distinct from token-shaped strings in redaction.
    const storedKey = idempotencyKey === undefined ? undefined : `idem:${createHash("sha256").update(idempotencyKey).digest("hex").match(/.{16}/g)!.join(".")}`;
    const operation = this.creation.catch(() => {}).then(async () => {
      if (storedKey) {
        const existing = await this.store.findTaskByIdempotencyKey(storedKey);
        if (existing) return { task: existing, reused: true };
      }
      const id = randomUUID();
      const now = this.clock.now().toISOString();
      const task: TaskRecord = { id, kind, status: "queued", createdAt: now, updatedAt: now, requestJson: JSON.stringify(this.traces.protectPrompts(redact(request as Record<string, unknown>))), idempotencyKey: storedKey, traceId: this.traces.startTrace(id) };
      try {
        await this.store.createTask(task);
      } catch (error) {
        // A concurrent writer (another process on the same SQLite file) may have
        // inserted the same key between our lookup and this insert.
        const raced = storedKey ? await this.store.findTaskByIdempotencyKey(storedKey) : undefined;
        if (raced) return { task: raced, reused: true };
        throw error;
      }
      this.controllers.set(id, new AbortController());
      await this.traces.emit(task.traceId, "task.created", { kind }, { taskId: id });
      return { task, reused: false };
    });
    this.creation = operation;
    return operation;
  }
  signal(taskId: string): AbortSignal {
    const controller = this.controllers.get(taskId);
    if (!controller) throw new BrokerError("TASK_NOT_FOUND", "Task is not active in this process");
    return controller.signal;
  }
  hasRun(taskId: string): boolean { return this.runs.has(taskId); }
  registerRun(taskId: string, promise: Promise<unknown>): void {
    if (this.runs.has(taskId)) { void promise.catch(() => {}); return; }
    const held = promise.then(() => {}, async (error: unknown) => {
      const task = await this.store.getTask(taskId);
      if (task && !isTerminal(task.status)) await this.setStatus(taskId, "failed", { errorJson: JSON.stringify(redact(toBrokerError(error).toJSON())) });
    }).finally(() => { this.runs.delete(taskId); this.controllers.delete(taskId); });
    this.runs.set(taskId, held);
    // Retain the original operation and attach a rejection handler for detached work.
    void held.catch(() => {});
  }
  async setStatus(taskId: string, status: ToolStatus, patch: Partial<TaskRecord> = {}): Promise<TaskRecord> {
    const task = await this.store.getTask(taskId);
    if (!task) throw new BrokerError("TASK_NOT_FOUND", "Task does not exist");
    if (isTerminal(task.status)) return task;
    // An abort may happen between the asynchronous read and this update.
    if (this.controllers.get(taskId)?.signal.aborted && status !== "cancelled") return (await this.store.getTask(taskId))!;
    await this.store.updateTask(taskId, { ...redact(patch), status, updatedAt: this.clock.now().toISOString() });
    await this.traces.emit(task.traceId, status === "completed" ? "task.completed" : "task.status_changed", { status }, { taskId });
    return (await this.store.getTask(taskId))!;
  }
  async waitFor(taskId: string, waitMs: number): Promise<TaskRecord | undefined> {
    const task = await this.store.getTask(taskId);
    if (!task) throw new BrokerError("TASK_NOT_FOUND", "Task does not exist");
    if (isTerminal(task.status)) return task;
    if (waitMs <= 0) return undefined;
    const deadline = Date.now() + waitMs;
    // Poll the Store as well as retained runs: callers may update a task independently.
    while (Date.now() < deadline) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(10, Math.max(0, deadline - Date.now())));
        const running = this.runs.get(taskId);
        if (running) void running.then(() => { clearTimeout(timer); resolve(); }, () => { clearTimeout(timer); resolve(); });
      });
      const current = await this.store.getTask(taskId);
      if (current && isTerminal(current.status)) return current;
    }
    return undefined;
  }
  async cancel(taskId: string): Promise<TaskRecord> {
    const task = await this.store.getTask(taskId);
    if (!task) throw new BrokerError("TASK_NOT_FOUND", "Task does not exist");
    if (isTerminal(task.status)) return task;
    this.controllers.get(taskId)?.abort(new BrokerError("CANCELLED", "Task cancelled", { retryable: false }));
    for (const child of await this.store.listTasksByParent(taskId)) await this.cancel(child.id);
    return this.setStatus(taskId, "cancelled");
  }
  aggregateStatus(children: Parameters<typeof aggregateStatus>[0]): ReturnType<typeof aggregateStatus> { return aggregateStatus(children); }
  async recoveredInterrupted(): Promise<number> { return this.store.markInterrupted(); }
}
