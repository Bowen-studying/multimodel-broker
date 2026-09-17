import type { Store, TaskRecord, TraceLevel } from "../../core/types.js";

/**
 * Ordered, idempotent schema migrations.
 *
 * Rules:
 * - every migration is applied at most once (tracked in `schema_migrations`);
 * - statements use IF NOT EXISTS so running them again is a no-op;
 * - columns follow task book section 12 exactly;
 * - JSON payloads are stored as `{"schema":1,"data":...}` so a future shape
 *   change is detectable instead of silently mis-parsed.
 */
export interface Migration {
  version: number;
  name: string;
  statements: string[];
}

export const migration001Initial: Migration = {
  version: 1,
  name: "initial",
  statements: [
    `CREATE TABLE IF NOT EXISTS tasks (
       id TEXT PRIMARY KEY,
       parent_id TEXT,
       kind TEXT NOT NULL,
       status TEXT NOT NULL,
       created_at TEXT NOT NULL,
       updated_at TEXT NOT NULL,
       request_json TEXT,
       result_json TEXT,
       error_json TEXT,
       idempotency_key TEXT,
       trace_id TEXT NOT NULL,
       completed_children INTEGER,
       total_children INTEGER
     )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_idempotency ON tasks(idempotency_key) WHERE idempotency_key IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id)`,
    `CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`,
    `CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at)`,
    `CREATE TABLE IF NOT EXISTS runs (
       id TEXT PRIMARY KEY,
       task_id TEXT NOT NULL,
       provider TEXT NOT NULL,
       model TEXT,
       status TEXT NOT NULL,
       session_id TEXT,
       started_at TEXT NOT NULL,
       finished_at TEXT,
       usage_json TEXT,
       trace_id TEXT NOT NULL
     )`,
    `CREATE INDEX IF NOT EXISTS idx_runs_task ON runs(task_id)`,
    `CREATE TABLE IF NOT EXISTS events (
       id TEXT PRIMARY KEY,
       trace_id TEXT NOT NULL,
       task_id TEXT,
       run_id TEXT,
       seq INTEGER NOT NULL,
       timestamp TEXT NOT NULL,
       type TEXT NOT NULL,
       payload_json TEXT NOT NULL,
       UNIQUE(trace_id, seq)
     )`,
    `CREATE INDEX IF NOT EXISTS idx_events_trace ON events(trace_id, seq)`,
    `CREATE TABLE IF NOT EXISTS artifacts (
       id TEXT PRIMARY KEY,
       run_id TEXT NOT NULL,
       name TEXT NOT NULL,
       path TEXT NOT NULL,
       mime_type TEXT,
       sha256 TEXT
     )`,
    `CREATE INDEX IF NOT EXISTS idx_artifacts_run ON artifacts(run_id)`,
  ],
};

export const MIGRATIONS: Migration[] = [migration001Initial];

/** Exposed for the sqlite store and its tests. */
export type { Store, TaskRecord, TraceLevel };
