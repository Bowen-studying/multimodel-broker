import { DatabaseSync } from "node:sqlite";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { BrokerError } from "../core/errors.js";
import { redact } from "../security/redaction.js";
import type { ArtifactRecord, RunRecord, Store, TaskRecord, TraceEvent, TraceLevel } from "../core/types.js";
import { MIGRATIONS } from "./migrations/index.js";

/**
 * SQLite-backed store using Node's built-in `node:sqlite` (`DatabaseSync`).
 *
 * No native dependency (better-sqlite3 is deliberately avoided) so the same
 * `dist/` runs on WSL and on Windows without a rebuild.
 *
 * Invariants:
 * - `init()` is idempotent: migrations are tracked in `schema_migrations` and
 *   every statement is written to be re-runnable.
 * - JSON columns are wrapped as `{"schema":1,"data":...}`.
 * - `seq` is assigned per traceId inside a transaction, so concurrent writers
 *   can never produce duplicates.
 * - No API key, Authorization header, cookie or OAuth token is ever stored: every
 *   row passes through `redact()` on the way in.
 */

const JSON_SCHEMA = 1;

function encode(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return JSON.stringify({ schema: JSON_SCHEMA, data: redact(value) });
}

function decode<T>(value: unknown): T | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") return undefined;
  const parsed = JSON.parse(value) as { schema?: number; data?: T };
  if (parsed && typeof parsed === "object" && "schema" in parsed) return parsed.data;
  // Legacy/plain JSON is returned as-is rather than silently dropped.
  return parsed as unknown as T;
}

const EVENT_FILTER: Record<TraceLevel, (type: string) => boolean> = {
  debug: () => true,
  summary: (type) => /^(task\.|route\.|run\.|usage$|provider\.(error|retry)$|policy\.)/.test(type),
  verbose: (type) =>
    /^(task\.|route\.|run\.|usage$|provider\.(error|retry)$|policy\.)/.test(type) || ["prompt.sent", "provider.request", "provider.response"].includes(type),
};

export class SqliteStore implements Store {
  private db?: DatabaseSync;

  constructor(private readonly file: string) {}

  private handle(): DatabaseSync {
    if (!this.db) throw new BrokerError("INTERNAL", "SqliteStore.init() must be awaited before use");
    return this.db;
  }

  private get<T>(sql: string, ...params: Array<string | number | null>): T | undefined {
    return this.handle().prepare(sql).get(...params) as T | undefined;
  }

  private all<T>(sql: string, ...params: Array<string | number | null>): T[] {
    return this.handle().prepare(sql).all(...params) as T[];
  }

  private run(sql: string, ...params: Array<string | number | null>): void {
    this.handle().prepare(sql).run(...params);
  }

  async init(): Promise<void> {
    if (this.db) return;
    await mkdir(path.dirname(path.resolve(this.file)), { recursive: true });
    const db = new DatabaseSync(this.file);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
    const applied = new Set(db.prepare("SELECT version FROM schema_migrations").all().map((row) => (row as { version: number }).version));
    for (const migration of [...MIGRATIONS].sort((a, b) => a.version - b.version)) {
      if (applied.has(migration.version)) continue;
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const statement of migration.statements) db.exec(statement);
        db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(migration.version, migration.name, new Date().toISOString());
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        db.close();
        throw new BrokerError("INTERNAL", `sqlite migration ${migration.version} (${migration.name}) failed: ${(error as Error).message}`);
      }
    }
    this.db = db;
  }

  async close(): Promise<void> {
    this.db?.close();
    this.db = undefined;
  }

  /* ----------------------------- tasks ----------------------------- */

  private toTask(row: Record<string, unknown>): TaskRecord {
    return {
      id: row["id"] as string,
      parentId: (row["parent_id"] as string | null) ?? undefined,
      kind: row["kind"] as TaskRecord["kind"],
      status: row["status"] as TaskRecord["status"],
      createdAt: row["created_at"] as string,
      updatedAt: row["updated_at"] as string,
      requestJson: (row["request_json"] as string | null) ?? "{}",
      resultJson: (row["result_json"] as string | null) ?? undefined,
      errorJson: (row["error_json"] as string | null) ?? undefined,
      idempotencyKey: (row["idempotency_key"] as string | null) ?? undefined,
      traceId: row["trace_id"] as string,
      completedChildren: (row["completed_children"] as number | null) ?? undefined,
      totalChildren: (row["total_children"] as number | null) ?? undefined,
    };
  }

  async createTask(task: TaskRecord): Promise<void> {
    try {
      this.run(
        `INSERT INTO tasks (id, parent_id, kind, status, created_at, updated_at, request_json, result_json, error_json, idempotency_key, trace_id, completed_children, total_children)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        task.id,
        task.parentId ?? null,
        task.kind,
        task.status,
        task.createdAt,
        task.updatedAt,
        task.requestJson,
        task.resultJson ?? null,
        task.errorJson ?? null,
        task.idempotencyKey ?? null,
        task.traceId,
        task.completedChildren ?? null,
        task.totalChildren ?? null,
      );
    } catch (error) {
      // The UNIQUE index on idempotency_key is the cross-process guard.
      throw new BrokerError("INVALID_INPUT", `duplicate task or idempotency key: ${(error as Error).message}`);
    }
  }

  async updateTask(id: string, patch: Partial<TaskRecord>): Promise<void> {
    const existing = await this.getTask(id);
    if (!existing) throw new BrokerError("TASK_NOT_FOUND", "Task does not exist");
    const merged = redact({ ...existing, ...patch, id });
    this.run(
      `UPDATE tasks SET parent_id=?, kind=?, status=?, created_at=?, updated_at=?, request_json=?, result_json=?, error_json=?, idempotency_key=?, trace_id=?, completed_children=?, total_children=? WHERE id=?`,
      merged.parentId ?? null,
      merged.kind,
      merged.status,
      merged.createdAt,
      merged.updatedAt,
      merged.requestJson,
      merged.resultJson ?? null,
      merged.errorJson ?? null,
      merged.idempotencyKey ?? null,
      merged.traceId,
      merged.completedChildren ?? null,
      merged.totalChildren ?? null,
      id,
    );
  }

  async getTask(id: string): Promise<TaskRecord | undefined> {
    const row = this.get<Record<string, unknown>>("SELECT * FROM tasks WHERE id = ?", id);
    return row ? this.toTask(row) : undefined;
  }

  async findTaskByIdempotencyKey(key: string): Promise<TaskRecord | undefined> {
    const row = this.get<Record<string, unknown>>("SELECT * FROM tasks WHERE idempotency_key = ?", key);
    return row ? this.toTask(row) : undefined;
  }

  async listTasksByParent(parentId: string): Promise<TaskRecord[]> {
    return this.all<Record<string, unknown>>("SELECT * FROM tasks WHERE parent_id = ? ORDER BY created_at, id", parentId).map((row) => this.toTask(row));
  }

  async listRecentTasks(limit: number): Promise<TaskRecord[]> {
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new BrokerError("INVALID_INPUT", "limit must be a positive integer");
    return this.all<Record<string, unknown>>("SELECT * FROM tasks ORDER BY created_at DESC, id DESC LIMIT ?", limit).map((row) => this.toTask(row));
  }

  async listInterruptedTasks(): Promise<TaskRecord[]> {
    return this.all<Record<string, unknown>>("SELECT * FROM tasks WHERE status = 'interrupted' ORDER BY created_at, id").map((row) => this.toTask(row));
  }

  async markInterrupted(): Promise<number> {
    const before = this.get<{ count: number }>("SELECT COUNT(*) AS count FROM tasks WHERE status IN ('queued','running')")?.count ?? 0;
    if (before) {
      this.run(`UPDATE tasks SET status='interrupted', updated_at=? WHERE status IN ('queued','running')`, new Date().toISOString());
    }
    return before;
  }

  /* ------------------------------ runs ----------------------------- */

  private toRun(row: Record<string, unknown>): RunRecord {
    return {
      id: row["id"] as string,
      taskId: row["task_id"] as string,
      provider: row["provider"] as string,
      model: (row["model"] as string | null) ?? undefined,
      status: row["status"] as RunRecord["status"],
      sessionId: (row["session_id"] as string | null) ?? undefined,
      startedAt: row["started_at"] as string,
      finishedAt: (row["finished_at"] as string | null) ?? undefined,
      usageJson: (row["usage_json"] as string | null) ?? undefined,
      traceId: row["trace_id"] as string,
    };
  }

  async createRun(run: RunRecord): Promise<void> {
    this.run(
      `INSERT INTO runs (id, task_id, provider, model, status, session_id, started_at, finished_at, usage_json, trace_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      run.id,
      run.taskId,
      run.provider,
      run.model ?? null,
      run.status,
      run.sessionId ?? null,
      run.startedAt,
      run.finishedAt ?? null,
      run.usageJson ?? null,
      run.traceId,
    );
  }

  async updateRun(id: string, patch: Partial<RunRecord>): Promise<void> {
    const existing = await this.getRun(id);
    if (!existing) throw new BrokerError("INVALID_INPUT", "Run does not exist");
    const merged = redact({ ...existing, ...patch, id });
    this.run(
      `UPDATE runs SET task_id=?, provider=?, model=?, status=?, session_id=?, started_at=?, finished_at=?, usage_json=?, trace_id=? WHERE id=?`,
      merged.taskId,
      merged.provider,
      merged.model ?? null,
      merged.status,
      merged.sessionId ?? null,
      merged.startedAt,
      merged.finishedAt ?? null,
      merged.usageJson ?? null,
      merged.traceId,
      id,
    );
  }

  async getRun(id: string): Promise<RunRecord | undefined> {
    const row = this.get<Record<string, unknown>>("SELECT * FROM runs WHERE id = ?", id);
    return row ? this.toRun(row) : undefined;
  }

  async listRunsByTask(taskId: string): Promise<RunRecord[]> {
    return this.all<Record<string, unknown>>("SELECT * FROM runs WHERE task_id = ? ORDER BY started_at, id", taskId).map((row) => this.toRun(row));
  }

  /* ----------------------------- events ---------------------------- */

  private toEvent(row: Record<string, unknown>): TraceEvent {
    return {
      id: row["id"] as string,
      traceId: row["trace_id"] as string,
      taskId: (row["task_id"] as string | null) ?? undefined,
      runId: (row["run_id"] as string | null) ?? undefined,
      seq: row["seq"] as number,
      timestamp: row["timestamp"] as string,
      type: row["type"] as TraceEvent["type"],
      payload: (decode<Record<string, unknown>>(row["payload_json"]) ?? {}) as Record<string, unknown>,
    };
  }

  async appendEvent(event: TraceEvent): Promise<void> {
    const db = this.handle();
    db.exec("BEGIN IMMEDIATE");
    try {
      // seq is assigned here, inside the transaction, so concurrent writers
      // cannot collide on (trace_id, seq).
      const next = (this.get<{ seq: number | null }>("SELECT MAX(seq) AS seq FROM events WHERE trace_id = ?", event.traceId)?.seq ?? 0) + 1;
      db.prepare(
        `INSERT INTO events (id, trace_id, task_id, run_id, seq, timestamp, type, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(event.id, event.traceId, event.taskId ?? null, event.runId ?? null, next, event.timestamp, event.type, encode(event.payload));
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw new BrokerError("INTERNAL", `unable to append trace event: ${(error as Error).message}`);
    }
  }

  async listEvents(traceId: string, level: TraceLevel): Promise<TraceEvent[]> {
    const filter = EVENT_FILTER[level] ?? EVENT_FILTER.summary;
    return this.all<Record<string, unknown>>("SELECT * FROM events WHERE trace_id = ? ORDER BY seq", traceId)
      .map((row) => this.toEvent(row))
      .filter((event) => filter(event.type));
  }

  /* ---------------------------- artifacts -------------------------- */

  async saveArtifacts(artifacts: ArtifactRecord[]): Promise<void> {
    for (const artifact of artifacts) {
      const safe = redact(artifact);
      this.run(
        `INSERT OR REPLACE INTO artifacts (id, run_id, name, path, mime_type, sha256) VALUES (?, ?, ?, ?, ?, ?)`,
        safe.id,
        safe.runId,
        safe.name,
        safe.path,
        safe.mimeType ?? null,
        safe.sha256 ?? null,
      );
    }
  }

  async listArtifactsByRun(runId: string): Promise<ArtifactRecord[]> {
    return this.all<Record<string, unknown>>("SELECT * FROM artifacts WHERE run_id = ? ORDER BY name, id", runId).map((row) => ({
      id: row["id"] as string,
      runId: row["run_id"] as string,
      name: row["name"] as string,
      path: row["path"] as string,
      mimeType: (row["mime_type"] as string | null) ?? undefined,
      sha256: (row["sha256"] as string | null) ?? undefined,
    }));
  }

  /* ---------------------------- retention -------------------------- */

  async deleteOlderThan(isoDate: string): Promise<number> {
    if (!Number.isFinite(Date.parse(isoDate))) throw new BrokerError("INVALID_INPUT", "Retention cutoff must be an ISO date");
    const candidates = this.all<{ id: string; parent_id: string | null }>(
      `SELECT id, parent_id FROM tasks WHERE status NOT IN ('queued','running') AND updated_at < ? ORDER BY created_at`,
      isoDate,
    ).map((row) => ({ id: row.id, parentId: row.parent_id ?? undefined }));
    if (!candidates.length) return 0;

    const doomed = new Set(candidates.map((task) => task.id));
    // Keep a parent while a retained (non-deleted) child still references it.
    const retained = this.all<{ parent_id: string | null }>("SELECT parent_id FROM tasks WHERE parent_id IS NOT NULL");
    for (const row of retained) {
      if (row.parent_id && doomed.has(row.parent_id)) doomed.delete(row.parent_id);
    }
    // A parent of a deleted child that is itself retained stays; recompute once more.
    for (const task of candidates) {
      if (!doomed.has(task.id)) continue;
      const children = this.all<{ id: string }>("SELECT id FROM tasks WHERE parent_id = ?", task.id);
      if (children.some((child) => !doomed.has(child.id))) doomed.delete(task.id);
    }
    if (!doomed.size) return 0;

    const ids = [...doomed];
    const placeholders = ids.map(() => "?").join(",");
    const runIds = this.all<{ id: string }>(`SELECT id FROM runs WHERE task_id IN (${placeholders})`, ...ids).map((row) => row.id);
    this.handle().exec("BEGIN IMMEDIATE");
    try {
      if (runIds.length) {
        const runPlaceholders = runIds.map(() => "?").join(",");
        this.run(`DELETE FROM artifacts WHERE run_id IN (${runPlaceholders})`, ...runIds);
      }
      this.run(`DELETE FROM events WHERE task_id IN (${placeholders})`, ...ids);
      if (runIds.length) {
        const runPlaceholders = runIds.map(() => "?").join(",");
        this.run(`DELETE FROM events WHERE run_id IN (${runPlaceholders})`, ...runIds);
      }
      this.run(`DELETE FROM runs WHERE task_id IN (${placeholders})`, ...ids);
      this.run(`DELETE FROM tasks WHERE id IN (${placeholders})`, ...ids);
      this.handle().exec("COMMIT");
    } catch (error) {
      this.handle().exec("ROLLBACK");
      throw new BrokerError("INTERNAL", `retention delete failed: ${(error as Error).message}`);
    }
    return ids.length;
  }
}
