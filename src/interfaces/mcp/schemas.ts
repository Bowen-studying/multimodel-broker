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
      .describe(
        "Worker id from list_workers; an explicit choice is never rewritten by the router. Pick by what the task needs: 'deepseek'/'glm' are cheap API workers that only return text (questions, explanations, drafting, review) and cannot touch files; anything that must read or change files, or run commands, belongs in run_agent (local Codex) or run_claude_code (local Claude Code on DeepSeek), which are separate tools.",
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
      .enum(["codex", "codex-win"])
      .default("codex")
      .describe("Which local Codex runtime to use. 'codex' = the broker's own Codex on this machine (use it for paths on this machine). 'codex-win' = the Windows Codex build, run with Windows paths, so the session is written to the Windows Codex store and appears in the Codex app - give a workspace mounted under /mnt/<drive> and it is translated for you. Both edit files and run commands; neither prompts for approval while it runs."),
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
        "Optional model override for this run, e.g. gpt-6-astra, gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna, gpt-5.5. Omit it (or pass \"auto\") to let Codex use the model configured on this machine. Only models the signed-in account actually offers work; a rejected model fails the run with the provider's own message.",
      ),
    workspace: workspaceName.optional().describe(
      "Workspace name from the allowlist. Required in practice: the agent may only write inside an allowlisted workspace, and the broker refuses the call without one.",
    ),
    files,
    timeoutMs,
    waitMs,
    traceLevel,
    idempotencyKey,
  })
  .strict();

export const RunClaudeCodeSchema = z
  .object({
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
        "Backend model for this run. Omit to use the worker's configured default (deepseek-flash). Available on this account: deepseek-flash (cheap, default) and deepseek-v4-pro (about 4x the input price, ~3x the output price).",
      ),
    workspace: workspaceName.describe(
      "Working directory for the run: an allowlisted workspace name, or an absolute path when this instance runs with server.allowAnyWorkspace=true (system and credential trees stay refused). Claude Code runs as the operator's own user, so this sets where it starts, not a hard sandbox.",
    ),
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
