/**
 * Core type contract for the Multi-Model Broker.
 *
 * This file is the single source of truth for the shapes crossing module
 * boundaries (Core <-> Providers <-> MCP interface layer <-> Storage).
 *
 * Rules:
 * - Provider raw responses MUST be normalized into `WorkerResult` before they
 *   reach the MCP layer.
 * - Nothing in here may contain a secret value. Secrets are referenced by the
 *   NAME of the environment variable that holds them.
 */

/* ------------------------------------------------------------------ */
/* Status vocabulary                                                   */
/* ------------------------------------------------------------------ */

/** Status reported in the unified MCP tool envelope. */
export type ToolStatus =
  | "completed"
  | "queued"
  | "running"
  | "partial_success"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "interrupted";

/** Status a Task can hold internally. */
export type TaskStatus = ToolStatus;

/** Status a single provider invocation (run) can hold. */
export type RunStatus = "completed" | "failed" | "timed_out" | "cancelled";

export type TraceLevel = "summary" | "verbose" | "debug";

/* ------------------------------------------------------------------ */
/* MCP envelope                                                        */
/* ------------------------------------------------------------------ */

export interface ToolEnvelope<T> {
  ok: boolean;
  status: ToolStatus;
  taskId?: string;
  traceId?: string;
  data?: T;
  warnings?: string[];
  error?: {
    code: string;
    message: string;
    retryable: boolean;
  };
}

/* ------------------------------------------------------------------ */
/* Workers / providers                                                 */
/* ------------------------------------------------------------------ */

export type AuthMode = "codex-local" | "api-key" | "vertex" | "unknown";

export interface WorkerInfo {
  id: string;
  enabled: boolean;
  healthy: boolean;
  provider: string;
  model?: string;
  authMode: AuthMode;
  capabilities: string[];
  maxConcurrency: number;
  reasonUnavailable?: string;
  /**
   * Tools whose sticky choice currently points at this worker - i.e. calling that tool without a
   * `worker` will run this one. Empty/absent means no remembered choice yet.
   */
  defaultFor?: Array<"run_worker" | "run_agent">;
}

export interface ProviderHealth {
  healthy: boolean;
  /** ISO-8601 timestamp of the check. */
  checkedAt: string;
  /** Human readable reason when `healthy === false`. Never contains secrets. */
  reason?: string;
  /** Optional sanitized details (model id, latency, http status, ...). */
  details?: Record<string, unknown>;
}

export interface WorkerRequest {
  taskId: string;
  runId: string;
  task: string;
  context?: string;
  workspace?: string;
  files?: string[];
  model?: string;
  timeoutMs: number;
  traceLevel: "summary" | "verbose";
  /**
   * Absolute, already-validated paths resolved by the path guard.
   * Providers must never resolve workspace paths themselves.
   */
  resolvedFiles?: string[];
  /** Emit a trace event from inside the provider. */
  emit?: (type: TraceEventType, payload: Record<string, unknown>) => void;
}

export interface WorkerResult {
  taskId: string;
  runId: string;
  provider: string;
  model?: string;
  status: RunStatus;
  answer: string;
  summary?: string;
  sessionId?: string;
  evidence?: Array<{ type: string; content: string; source?: string }>;
  artifacts?: Array<{
    name: string;
    path: string;
    mimeType?: string;
    sha256?: string;
  }>;
  usage?: {
    inputTokens?: number;
    /**
     * Tokens the provider billed as completion. For reasoning models this INCLUDES the
     * hidden reasoning tokens, so it is not comparable with a non-reasoning provider's
     * number unless `reasoningTokens` is subtracted - see the usage-normalisation note
     * in docs/known-limitations.md.
     */
    outputTokens?: number;
    /** Hidden reasoning tokens (a subset of outputTokens) when the provider reports them. */
    reasoningTokens?: number;
    /** Tokens served from a provider-side prompt cache, when reported. */
    cacheHitTokens?: number;
    cost?: number;
  };
  traceId: string;
  error?: { code: string; message: string; retryable: boolean };
}

/**
 * MCP tool profile names.
 *
 * Defined in core (not in the MCP interface) so the config schema and the profile registry cannot
 * drift: adding a profile here is the single edit that makes it configurable and registrable.
 */
export const PROFILE_NAMES = ["chatgpt-agent", "local-full"] as const;
export type ProfileName = (typeof PROFILE_NAMES)[number];

export interface WorkerProvider {
  readonly id: string;
  /** Declared capabilities, used by the deterministic router. */
  readonly capabilities: readonly string[];
  /** How this worker authenticates; reported by list_workers/doctor. */
  readonly authMode?: AuthMode;
  healthCheck(): Promise<ProviderHealth>;
  run(request: WorkerRequest, signal: AbortSignal): Promise<WorkerResult>;
  resume?(
    sessionId: string,
    request: WorkerRequest,
    signal: AbortSignal,
  ): Promise<WorkerResult>;
}

/* ------------------------------------------------------------------ */
/* Tasks / runs / traces                                               */
/* ------------------------------------------------------------------ */

export interface TaskRecord {
  id: string;
  parentId?: string;
  /**
   * Which tool created the task. `run_claude_code` is legacy: that tool was merged into
   * `run_agent` (`worker: "claude-code"`), so only already-stored rows still carry it.
   */
  kind: "run_worker" | "run_agent" | "run_claude_code" | "delegate" | "delegate_batch" | "batch_child";
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  requestJson: string;
  resultJson?: string;
  errorJson?: string;
  idempotencyKey?: string;
  traceId: string;
  /** Number of child tasks that reached a terminal state (batch parent only). */
  completedChildren?: number;
  totalChildren?: number;
}

export interface RunRecord {
  id: string;
  taskId: string;
  provider: string;
  model?: string;
  status: RunStatus;
  sessionId?: string;
  startedAt: string;
  finishedAt?: string;
  usageJson?: string;
  traceId: string;
}

export interface ArtifactRecord {
  id: string;
  runId: string;
  name: string;
  path: string;
  mimeType?: string;
  sha256?: string;
}

export type TraceEventType =
  | "task.created"
  | "task.status_changed"
  | "task.completed"
  | "route.selected"
  /** A run reused the worker/model the caller chose earlier (sticky choice), rather than a fresh instruction. */
  | "choice.remembered"
  | "run.started"
  | "run.finished"
  | "prompt.sent"
  | "provider.request"
  | "provider.response"
  | "provider.error"
  | "provider.retry"
  | "tool.event"
  | "usage"
  | "artifact"
  | "policy.denied"
  | "broker.startup"
  | "broker.recovered"
  | "note";

export interface TraceEvent {
  id: string;
  traceId: string;
  taskId?: string;
  runId?: string;
  seq: number;
  timestamp: string;
  type: TraceEventType;
  payload: Record<string, unknown>;
}

export interface TraceSummary {
  traceId: string;
  taskId?: string;
  events: TraceEvent[];
  truncated?: boolean;
}

/* ------------------------------------------------------------------ */
/* Requests flowing through the Core                                   */
/* ------------------------------------------------------------------ */

export interface Requirements {
  tests?: boolean;
  structured?: boolean;
  batch?: boolean;
  coding?: boolean;
  repository?: boolean;
  longContext?: boolean;
  multimodal?: boolean;
  chinesePriority?: boolean;
  lowCost?: boolean;
  independentReview?: boolean;
}

export interface TaskSubmission {
  task: string;
  context?: string;
  workspace?: string;
  files?: string[];
  /**
   * Optional model override for the worker. `auto` (or omitting it) means "let the provider decide",
   * which for the local Codex workers is whatever the Codex client itself is configured with.
   */
  model?: string;
  /** Explicitly selected worker; the router must not rewrite it. */
  worker?: string;
  requirements?: Requirements;
  timeoutMs?: number;
  waitMs?: number;
  traceLevel?: "summary" | "verbose";
  idempotencyKey?: string;
}

export interface RouterDecision {
  worker: string;
  reason: string;
  /** Worker ids evaluated in order (primary first). */
  candidates: string[];
  /** Set when the primary choice was unavailable and a fallback was used. */
  fallbackFrom?: string;
  /** Rules that matched, for auditability. */
  matchedRules: string[];
}

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

/**
 * Adapters that drive a LOCAL agent with file and command access.
 *
 * Such a worker must never be reachable through a tool that is advertised as read-only: the router
 * refuses to select it and `run_worker` refuses to accept it, so the only doors are the dedicated
 * mutating tool (`run_agent`) with honest annotations. See
 * src/interfaces/mcp/annotations.ts - that rule is the reason this list exists at all.
 */
export const WRITE_CAPABLE_ADAPTERS: ReadonlySet<string> = new Set(["codex-sdk", "claude-code"]);

/** The mutating tool a caller should use instead of the read-only ones. */
export function mutatingToolFor(_adapter: string): string {
  return "run_agent";
}

export interface ProviderConfig {
  enabled: boolean;
  adapter: "codex-sdk" | "claude-code" | "gemini-api" | "openai-compatible" | "mock";
  model?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  maxConcurrency: number;
  defaultTimeoutMs: number;
  authMode?: AuthMode;
  /** codex only */
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  /** mock only */
  mock?: MockConfig;
  /** provider specific extras, kept out of shared code paths */
  options?: Record<string, unknown>;
}

export interface MockConfig {
  /** Fixed delay before resolving. */
  delayMs?: number;
  /** "success" | "fail" | "timeout" | "hang" */
  behavior?: "success" | "fail" | "timeout" | "hang";
  /** Deterministic per-task behaviour overrides, keyed by task text prefix. */
  rules?: Array<{
    match: string;
    behavior?: MockConfig["behavior"];
    delayMs?: number;
    answer?: string;
    errorCode?: string;
  }>;
  answer?: string;
  usage?: { inputTokens?: number; outputTokens?: number; cost?: number };
  /** Fail the first N attempts with a retryable error (retry testing). */
  failFirstAttempts?: number;
}

export interface RoutingRule {
  primary: string;
  fallback?: string[];
}

export interface BrokerConfig {
  providers: Record<string, ProviderConfig>;
  routing: {
    coding?: RoutingRule;
    long_context?: RoutingRule;
    low_cost?: RoutingRule;
    chinese?: RoutingRule;
    general?: RoutingRule;
  };
  concurrency: {
    global: number;
    [providerId: string]: number;
  };
  limits: {
    maxTaskChars: number;
    maxContextChars: number;
    defaultWaitMs: number;
    maxWaitMs: number;
    maxBatchTasks: number;
    maxFiles: number;
    maxFileBytes: number;
    maxRetries: number;
    retryBaseDelayMs: number;
  };
  workspaces: Record<string, string>;
  trace: {
    storePrompts: boolean;
    retentionDays: number;
  };
  storage: {
    driver: "memory" | "sqlite";
    sqlitePath: string;
  };
  server: {
    /** Default profile when --profile is omitted. */
    defaultProfile: ProfileName;
    /**
     * When true, `run_agent.workspace` may be ANY absolute path (matching what the local Codex CLI
     * itself can reach) instead of only an allowlisted workspace name. Credential and system
     * locations stay refused - see SENSITIVE_PREFIXES in src/security/paths.ts.
     */
    allowAnyWorkspace: boolean;
  };
}

/* ------------------------------------------------------------------ */
/* Core service interfaces                                             */
/* ------------------------------------------------------------------ */

export interface Store {
  init(): Promise<void>;
  close(): Promise<void>;
  createTask(task: TaskRecord): Promise<void>;
  updateTask(id: string, patch: Partial<TaskRecord>): Promise<void>;
  getTask(id: string): Promise<TaskRecord | undefined>;
  findTaskByIdempotencyKey(key: string): Promise<TaskRecord | undefined>;
  listTasksByParent(parentId: string): Promise<TaskRecord[]>;
  /** Most recently created tasks first (CLI listing). */
  listRecentTasks(limit: number): Promise<TaskRecord[]>;
  createRun(run: RunRecord): Promise<void>;
  updateRun(id: string, patch: Partial<RunRecord>): Promise<void>;
  getRun(id: string): Promise<RunRecord | undefined>;
  listRunsByTask(taskId: string): Promise<RunRecord[]>;
  appendEvent(event: TraceEvent): Promise<void>;
  listEvents(traceId: string, level: TraceLevel): Promise<TraceEvent[]>;
  saveArtifacts(artifacts: ArtifactRecord[]): Promise<void>;
  listArtifactsByRun(runId: string): Promise<ArtifactRecord[]>;
  /**
   * Small persistent key/value store for operator preferences (e.g. the worker the caller chose
   * last time). Values are plain strings; keys are namespaced by the caller.
   */
  getSetting(key: string): Promise<string | undefined>;
  setSetting(key: string, value: string): Promise<void>;
  deleteSetting(key: string): Promise<void>;
  /** Marks queued/running tasks as interrupted after a broker restart. */
  markInterrupted(): Promise<number>;
  /** Tasks that were marked interrupted (used to emit one recovery event each). */
  listInterruptedTasks(): Promise<TaskRecord[]>;
  deleteOlderThan(isoDate: string): Promise<number>;
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

export interface Clock {
  now(): Date;
}
