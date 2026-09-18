import { z } from "zod";

/**
 * Zod input schemas for every MCP tool.
 *
 * Every documented constraint of the task book (section 6) is encoded here so a
 * model can act on the descriptions, and so malformed input is rejected before
 * it reaches the Broker. Values that are additionally configuration-driven
 * (maxTaskChars, maxFiles, ...) are enforced again by `RequestPolicy`; the
 * numbers below are the hard upper bounds that must hold for any configuration.
 *
 * Objects are `strict()`: unknown fields are rejected instead of silently
 * dropped, which is what the MCP layer passes to the SDK as the input schema.
 */

/** Hard ceiling for a task text (config `limits.maxTaskChars` may be lower). */
export const TASK_MAX_CHARS = 100_000;
/** Hard ceiling for `context` (config `limits.maxContextChars` may be lower). */
export const CONTEXT_MAX_CHARS = 500_000;
/** Hard ceiling for the number of attached workspace files. */
export const FILES_MAX = 20;
/** Hard ceiling for a single MCP call's blocking wait (`limits.maxWaitMs`). */
export const WAIT_MS_MAX = 45_000;
export const WAIT_MS_DEFAULT = 15_000;
/** Hard ceiling for one batch. */
export const BATCH_MAX_TASKS = 8;

const idempotencyKey = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
  .optional()
  .describe(
    "Optional caller-generated key. A repeated call with the same key returns the existing task instead of starting a second (billable) run.",
  );

const workspaceName = z
  .string()
  .min(1)
  .max(64)
  .optional()
  .describe("Name of a workspace from the broker's allowlist. Absolute paths and '..' are rejected.");

/** A workspace-relative path: no drive letter, no leading slash, no '..'. */
const workspaceRelativePath = z
  .string()
  .min(1)
  .max(1024)
  .refine((value) => !/^(?:[A-Za-z]:|[\\/~])/.test(value), "must not be an absolute path or start with '~'")
  .refine((value) => !value.split(/[\\/]/).includes(".."), "must not contain a '..' segment");

const files = z
  .array(workspaceRelativePath)
  .max(FILES_MAX)
  .optional()
  .describe(
    "Workspace-relative file paths (forward or back slashes). Absolute paths, drive letters, '..' and symlink escapes are rejected. Requires `workspace`.",
  );

const taskText = z
  .string()
  .min(1)
  .max(TASK_MAX_CHARS)
  .describe("The task text to hand to the worker. Sent verbatim as the worker prompt.");

const contextText = z
  .string()
  .max(CONTEXT_MAX_CHARS)
  .optional()
  .describe("Optional supporting material (facts, snippets the caller already has). Not a private file dump.");

const timeoutMs = z
  .number()
  .int()
  .positive()
  .max(2_147_483_647)
  .optional()
  .describe("Per-run wall-clock budget in milliseconds. Defaults to the worker's configured timeout.");

const waitMs = z
  .number()
  .int()
  .min(0)
  .max(WAIT_MS_MAX)
  .optional()
  .describe(
    `How long this single MCP call may block before returning status "running" plus a taskId (default ${WAIT_MS_DEFAULT}, max ${WAIT_MS_MAX}). Poll with get_task.`,
  );

const traceLevel = z
  .enum(["summary", "verbose"])
  .optional()
  .describe("Trace detail recorded for this task. 'verbose' adds the prompt/provider request metadata. Defaults to 'summary'.");

const requirements = z
  .object({
    coding: z.boolean().optional(),
    repository: z.boolean().optional(),
    longContext: z.boolean().optional(),
    multimodal: z.boolean().optional(),
    chinesePriority: z.boolean().optional(),
    lowCost: z.boolean().optional(),
    structured: z.boolean().optional(),
    batch: z.boolean().optional(),
    independentReview: z.boolean().optional(),
  })
  .strict()
  .optional()
  .describe(
    "Deterministic routing hints. coding/repository/tests -> coding worker; longContext/multimodal -> long-context worker; lowCost/structured/batch/independentReview -> low-cost worker; chinesePriority -> Chinese-first worker.",
  );

const childTask = z
  .object({
    id: z.string().min(1).max(64).optional().describe("Caller-supplied label echoed back with this child's result."),
    worker: z.string().min(1).max(64).optional().describe("Explicit worker for this child. Omitted = routed by requirements."),
    task: taskText,
    context: contextText,
    workspace: workspaceName,
    files,
    requirements,
    timeoutMs,
  })
  .strict();

export const PingSchema = z.object({}).strict();
export const ListWorkersSchema = z.object({}).strict();

export const RunWorkerSchema = z
  .object({
    worker: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe(
        "Worker id from list_workers; an explicit choice is never rewritten by the router, and it is REMEMBERED: omit `worker` on a later call to reuse the same one, or name a different worker to switch (list_workers marks the current choice with defaultFor). Pick by what the task needs: 'deepseek'/'glm' are cheap API workers that only return text (questions, explanations, drafting, review) and cannot touch files; anything that must change files or run commands belongs in run_agent, which is a separate (write-capable) tool. Write-capable workers are refused here.",
      ),
    task: taskText,
    context: contextText,
    workspace: workspaceName,
    files,
    timeoutMs,
    waitMs,
    traceLevel,
    idempotencyKey,
  })
  .strict();

export const RunAgentSchema = z
  .object({
    worker: z
      .enum(["codex", "codex-win", "claude-code"])
      .optional()
      .describe(
        // No built-in default: the broker never picks a harness or model on its own. A choice made
        // here sticks, so follow-up calls may omit it (and switch by naming another one).
        "Which local agent runs the task. Name it the first time - this broker has no default of its own, so a call with no `worker` and nothing remembered is refused. Naming one makes it sticky: omit `worker` on a later call to reuse it, or name a different one to switch (list_workers marks the current choice with defaultFor). All three edit files and run shell commands without prompting; pick by harness and by what the workspace means:\n"
        + "- 'codex': the broker machine's own Codex. The workspace is a WRITE BOUNDARY - Codex is confined to it by the sandbox, and a run draws on the Codex subscription quota. Use it when the work needs Codex's own context or is confined to one directory. Paths on this machine are /home/... or /mnt/<drive>/...\n"
        + "- 'codex-win': the Windows Codex build, so the run is recorded in that machine's Codex store. EXPERIMENTAL - its transport is known to fail in some networks (reconnect/timeout, or an invalid-path error), and it is not needed just to touch Windows files (see below). Same sandbox and quota story as 'codex'.\n"
        + "- 'claude-code': the local Claude Code CLI on the backend its operator configured. The workspace is only the STARTING DIRECTORY - the agent runs as the operator's user and can reach well beyond it, so treat it as 'the tree to work in', not a sandbox. It bills per token to that backend instead of using the Codex quota, which makes it the cheap choice for small, well-specified edits (seconds, fractions of a cent).\n"
        + "Windows files: this broker runs inside WSL, so the Windows drives are already visible as /mnt/<drive>/... - hand ANY worker a workspace like /mnt/c/Users/<you>/Desktop and it can work there (for 'codex-win' the path is translated for it). Do not reach for 'codex-win' merely because the target is a Windows path.\n"
        + "A worker that is not enabled on this machine is refused before anything runs.",
      ),
    task: taskText,
    context: contextText,
    model: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "model ids are plain identifiers")
      .optional()
      .describe(
        "Optional model override for this run, as an id your provider actually serves (for the Codex workers a Codex model; for 'claude-code' whatever your configured backend offers). An override is remembered per worker and reapplied when a later call omits it; pass \"auto\" to forget it and fall back to the worker's configured model. Omit it entirely to use whatever is already in effect - this project ships no model default of its own. A rejected model fails the run with the provider's own message.",
      ),
    workspace: workspaceName.optional().describe(
      "Working directory for the run: an allowlisted workspace name, or an absolute path when this instance allows it. Required. For the Codex workers it is the write boundary (the sandbox confines writes to it); for 'claude-code' it is only where the agent starts.",
    ),
    files,
    timeoutMs,
    waitMs,
    traceLevel,
    idempotencyKey,
  })
  .strict();

export const DelegateSchema = z
  .object({
    task: taskText,
    context: contextText,
    workspace: workspaceName,
    files,
    requirements,
    timeoutMs,
    waitMs,
    traceLevel,
    idempotencyKey,
  })
  .strict();

export const DelegateBatchSchema = z
  .object({
    mode: z.literal("parallel").describe("V1 supports parallel independent tasks only. Sequential and DAG are not implemented."),
    tasks: z.array(childTask).min(1).max(BATCH_MAX_TASKS).describe(`Independent child tasks, 1-${BATCH_MAX_TASKS}. Children cannot see each other's output (no anchoring).`),
    maxConcurrency: z
      .number()
      .int()
      .positive()
      .max(64)
      .optional()
      .describe("How many children may run at once inside this one MCP call. Defaults to the configured global concurrency."),
    failurePolicy: z.literal("collect_all").optional().describe("Only 'collect_all' is supported: every child's outcome is returned even if some fail."),
    waitMs,
    traceLevel,
    idempotencyKey,
  })
  .strict();

export const GetTaskSchema = z
  .object({
    taskId: z.string().min(1).max(128).describe("Task id returned by run_worker/delegate/delegate_batch."),
    includeResults: z.boolean().optional().describe("Include already-finished worker results (default true). Set false for status only."),
  })
  .strict();

export const GetTraceSchema = z
  .object({
    traceId: z.string().min(1).max(128).describe("Trace id returned alongside a task."),
    level: z
      .enum(["summary", "verbose", "debug"])
      .optional()
      .describe("summary = task/route/status/usage/errors; verbose = + prompt and provider request/response metadata; debug = everything recorded. Defaults to summary."),
  })
  .strict();

export const CancelTaskSchema = z
  .object({
    taskId: z.string().min(1).max(128).describe("Task id to cancel. Local profile only."),
  })
  .strict();

export type RunWorkerArgs = z.infer<typeof RunWorkerSchema>;
export type DelegateArgs = z.infer<typeof DelegateSchema>;
export type DelegateBatchArgs = z.infer<typeof DelegateBatchSchema>;
export type GetTaskArgs = z.infer<typeof GetTaskSchema>;
export type GetTraceArgs = z.infer<typeof GetTraceSchema>;
export type CancelTaskArgs = z.infer<typeof CancelTaskSchema>;
