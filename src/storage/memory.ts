import { BrokerError } from "../core/errors.js";
import type { ArtifactRecord, RunRecord, Store, TaskRecord, TraceEvent, TraceLevel } from "../core/types.js";
import { redact } from "../security/redaction.js";

const copy = <T>(value: T): T => structuredClone(value);
const clean = <T>(value: T): T => copy(redact(value));

export class MemoryStore implements Store {
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly runs = new Map<string, RunRecord>();
  private readonly events = new Map<string, TraceEvent[]>();
  private readonly artifacts = new Map<string, ArtifactRecord>();
  async init(): Promise<void> {}
  async close(): Promise<void> {}
  async createTask(task: TaskRecord): Promise<void> {
    if (this.tasks.has(task.id) || (task.idempotencyKey && [...this.tasks.values()].some((t) => t.idempotencyKey === task.idempotencyKey))) throw new BrokerError("INVALID_INPUT", "Duplicate task or idempotency key");
    this.tasks.set(task.id, clean(task));
  }
  async updateTask(id: string, patch: Partial<TaskRecord>): Promise<void> {
    const task = this.tasks.get(id);
    if (!task) throw new BrokerError("TASK_NOT_FOUND", "Task does not exist");
    this.tasks.set(id, clean({ ...task, ...patch, id }));
  }
  async getTask(id: string): Promise<TaskRecord | undefined> { return copy(this.tasks.get(id)); }
  async findTaskByIdempotencyKey(key: string): Promise<TaskRecord | undefined> { return copy([...this.tasks.values()].find((t) => t.idempotencyKey === key)); }
  async listTasksByParent(parentId: string): Promise<TaskRecord[]> { return copy([...this.tasks.values()].filter((t) => t.parentId === parentId)); }
  async listRecentTasks(limit: number): Promise<TaskRecord[]> {
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new BrokerError("INVALID_INPUT", "limit must be a positive integer");
    return copy(
      [...this.tasks.values()]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
        .slice(0, limit),
    );
  }
  async createRun(run: RunRecord): Promise<void> {
    if (this.runs.has(run.id)) throw new BrokerError("INVALID_INPUT", "Duplicate run");
    this.runs.set(run.id, clean(run));
  }
  async updateRun(id: string, patch: Partial<RunRecord>): Promise<void> {
    const run = this.runs.get(id);
    if (!run) throw new BrokerError("INVALID_INPUT", "Run does not exist");
    this.runs.set(id, clean({ ...run, ...patch, id }));
  }
  async getRun(id: string): Promise<RunRecord | undefined> { return copy(this.runs.get(id)); }
  async listRunsByTask(taskId: string): Promise<RunRecord[]> { return copy([...this.runs.values()].filter((r) => r.taskId === taskId)); }
  async appendEvent(event: TraceEvent): Promise<void> {
    const events = this.events.get(event.traceId) ?? [];
    // Store owns the final sequence assignment, including across TraceStore instances.
    events.push(clean({ ...event, seq: (events.at(-1)?.seq ?? 0) + 1 }));
    this.events.set(event.traceId, events);
  }
  async listEvents(traceId: string, level: TraceLevel): Promise<TraceEvent[]> {
    return copy((this.events.get(traceId) ?? []).filter((e) => level === "debug" || /^(task\.|route\.|run\.|usage$|provider\.(error|retry)$|policy\.)/.test(e.type) || (level === "verbose" && ["prompt.sent", "provider.request", "provider.response"].includes(e.type))));
  }
  async saveArtifacts(artifacts: ArtifactRecord[]): Promise<void> { for (const artifact of artifacts) this.artifacts.set(artifact.id, clean(artifact)); }
  async listArtifactsByRun(runId: string): Promise<ArtifactRecord[]> { return copy([...this.artifacts.values()].filter((a) => a.runId === runId)); }
  async markInterrupted(): Promise<number> {
    let count = 0;
    for (const task of this.tasks.values()) {
      if (task.status === "queued" || task.status === "running") {
        task.status = "interrupted";
        task.updatedAt = new Date().toISOString();
        count++;
      }
    }
    return count;
  }
  async listInterruptedTasks(): Promise<TaskRecord[]> {
    return copy([...this.tasks.values()].filter((task) => task.status === "interrupted").sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)));
  }
  async deleteOlderThan(isoDate: string): Promise<number> {
    if (!Number.isFinite(Date.parse(isoDate))) throw new BrokerError("INVALID_INPUT", "Retention cutoff must be an ISO date");
    const ids = new Set([...this.tasks.values()].filter((t) => !["queued", "running"].includes(t.status) && Date.parse(t.updatedAt) < Date.parse(isoDate)).map((t) => t.id));
    // Keep parents while a retained child still references them.
    let changed = true;
    while (changed) {
      changed = false;
      for (const task of this.tasks.values()) if (!ids.has(task.id) && task.parentId && ids.delete(task.parentId)) changed = true;
    }
    const runIds = new Set([...this.runs.values()].filter((r) => ids.has(r.taskId)).map((r) => r.id));
    const traceIds = new Set([...this.tasks.values()].filter((t) => ids.has(t.id)).map((t) => t.traceId));
    for (const id of ids) this.tasks.delete(id);
    for (const id of runIds) this.runs.delete(id);
    for (const id of traceIds) this.events.delete(id);
    for (const [id, events] of this.events) this.events.set(id, events.filter((e) => !(e.taskId && ids.has(e.taskId)) && !(e.runId && runIds.has(e.runId))));
    for (const artifact of this.artifacts.values()) if (runIds.has(artifact.runId)) this.artifacts.delete(artifact.id);
    return ids.size;
  }
}
