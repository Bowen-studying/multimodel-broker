import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toBrokerError } from "../../core/errors.js";
import type { ToolEnvelope, WorkerInfo } from "../../core/types.js";
import type { Broker } from "../../core/broker.js";
import { redact } from "../../security/redaction.js";
import { annotationsFor } from "./annotations.js";
import { toolsForProfile, type ProfileName, type ToolName } from "./profiles.js";
import {
  CancelTaskSchema,
  DelegateBatchSchema,
  DelegateSchema,
  GetTaskSchema,
  GetTraceSchema,
  ListWorkersSchema,
  PingSchema,
  RunAgentSchema,
  RunWorkerSchema,
  type DelegateBatchArgs,
  type GetTraceArgs,
} from "./schemas.js";

/**
 * The MCP layer ONLY calls the Broker. It never talks to a provider, a store or
 * a router directly, and it contains no provider-specific logic (task book 2.4,
 * 4).
 *
 * Every handler returns the unified `ToolEnvelope` as JSON text content AND as
 * `structuredContent`, and sets `isError` when `ok === false`. Error messages
 * are `BrokerError` messages only - never a stack trace, never a secret.
 */

export interface ToolMetadata {
  name: ToolName;
  title: string;
  description: string;
  annotations: ReturnType<typeof annotationsFor>["annotations"];
}

/** Descriptions are what a calling model reads; keep them operational. */
export const TOOL_DESCRIPTIONS: Record<ToolName, string> = {
  ping: "Health probe for the broker itself. Returns the service name. Use it to check the connection before delegating work.",
  list_workers:
    "List the configured workers with enabled/healthy state, provider, model, auth mode, capabilities, max concurrency and (when unavailable) the reason. Call this before run_worker to pick a valid worker id. A worker marked `defaultFor: [tool]` is the sticky choice that tool will use if you omit `worker` - call this first whenever you need to know what the current choice is before switching it.",
  run_worker:
    "Run one explicitly chosen API worker on a task and return its answer. Choose the worker from list_workers: `deepseek` for general reasoning, explanation, code reading and second opinions at low cost; `glm` for Chinese-first or very cheap work; `mock` only to test connectivity. Blocks up to `waitMs` (default 15s, max 45s); if the worker is still running, returns status 'running' plus a taskId to poll with get_task. Read-only in the sense that it only spends model compute and returns text: it does not write files, repositories or third-party objects. Prefer this over run_agent whenever the task can be answered without access to the local machine. The worker you name is remembered for this tool, so the next call may omit `worker` to keep using it - name a different worker only when you actually want to switch.",
  run_agent:
    "Run a LOCAL agent that can read AND WRITE files and execute shell commands - the only write-capable tool here. Choose `worker`: 'codex' (this machine's Codex; slower, draws on the Codex subscription quota, and `workspace` is a real write boundary the sandbox confines it to), 'codex-win' (the Windows Codex build, Windows paths, runs land in that machine's Codex store; same quota and sandbox), or 'claude-code' (the local Claude Code CLI on the backend its operator configured: seconds per small edit, billed per token to that backend, and `workspace` is only the STARTING directory because it runs as the operator's user). Prefer run_worker for anything that only needs text; use this when files must actually change. Your answer comes back with an audit line (files touched, commands run, cost). Blocks up to `waitMs` (default 15s, max 45s), then returns status 'running' plus a taskId to poll with get_task - give the whole task in one message, since every extra agent turn re-sends the context and costs more. Requires `workspace`. A worker that is not enabled on this machine is refused before anything runs. The worker you name is remembered (see defaultFor in list_workers): later calls may omit `worker` to reuse the same harness on a different task, and naming another one switches - so switching is always one explicit argument.",
  delegate:
    "Let the broker pick a worker deterministically from `requirements` (no LLM routing) and run the task. Returns the selected worker, the route reason, the route audit and the worker result or a taskId. Explicit `worker` is accepted and never rewritten.",
  delegate_batch:
    "Run 1-8 independent tasks in parallel inside ONE call (mode 'parallel', failurePolicy 'collect_all'). Children are isolated from each other (no shared context, no cross-visibility). Blocks up to `waitMs`; then returns the parent taskId. Partial results are kept when some children fail.",
  get_task:
    "Fetch a task by id: current status, completion counters, child tasks and (optionally) the worker results that already finished. Use it to poll a task that returned status 'running'.",
  get_trace:
    "Fetch the audit trace of a task: delegation goal, route reason, provider/model, timings, explicit tool events, usage and errors. Never contains hidden chain-of-thought, API keys, cookies or OAuth tokens.",
  cancel_task: "Cancel a queued or running task (and its children). Local profile only; not exposed to the ChatGPT Pro bridge.",
};

export function toolMetadata(profile: ProfileName): ToolMetadata[] {
  return toolsForProfile(profile).map((name) => ({
    name,
    title: annotationsFor(name).title,
    description: TOOL_DESCRIPTIONS[name],
    annotations: annotationsFor(name).annotations,
  }));
}

type Envelope = ToolEnvelope<unknown>;

function asResult(envelope: Envelope) {
  // JSON round-trip drops `undefined` members so structuredContent stays clean.
  const payload = JSON.parse(JSON.stringify(envelope)) as Record<string, unknown>;
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    isError: envelope.ok !== true,
  };
}

function failure(error: unknown, logger?: { error(msg: string, fields?: Record<string, unknown>): void }) {
  const brokerError = toBrokerError(error, "INTERNAL");
  // Message only: never a stack trace, never provider internals.
  const status = brokerError.code === "TIMEOUT" ? "timed_out" : brokerError.code === "CANCELLED" ? "cancelled" : "failed";
  const envelope: Envelope = { ok: false, status, error: redact(brokerError.toJSON()) };
  logger?.error("MCP tool call failed", { code: brokerError.code });
  return asResult(envelope);
}

type Handler<Args> = (args: Args) => Promise<Envelope>;

function register<Args>(
  server: McpServer,
  name: ToolName,
  schema: unknown,
  handler: Handler<Args>,
  logger: { error(msg: string, fields?: Record<string, unknown>): void },
): void {
  const { title, annotations } = annotationsFor(name);
  server.registerTool(
    name,
    {
      title,
      description: TOOL_DESCRIPTIONS[name],
      // A full (strict) ZodObject is passed straight through, so unknown fields
      // are rejected by the SDK's validation instead of being silently dropped.
      inputSchema: schema as never,
      annotations,
    },
    (async (args: unknown) => {
      try {
        return asResult(await handler(args as Args));
      } catch (error) {
        return failure(error, logger);
      }
    }) as never,
  );
}

export interface ToolLogger {
  error(msg: string, fields?: Record<string, unknown>): void;
}

/** Register the profile's tools on `server`; each one only calls the Broker. */
export function registerTools(server: McpServer, broker: Broker, profile: ProfileName, logger?: ToolLogger): void {
  const log = logger ?? { error: () => {} };
  const enabled = new Set(toolsForProfile(profile));

  if (enabled.has("ping")) {
    register<Record<string, never>>(server, "ping", PingSchema, async () => broker.ping() as Envelope, log);
  }
  if (enabled.has("list_workers")) {
    register<Record<string, never>>(
      server,
      "list_workers",
      ListWorkersSchema,
      async () => ({ ok: true, status: "completed", data: { workers: await broker.listWorkers() } }) as ToolEnvelope<{ workers: WorkerInfo[] }>,
      log,
    );
  }
  if (enabled.has("run_worker")) {
    register(server, "run_worker", RunWorkerSchema, async (args: Parameters<Broker["runWorker"]>[0]) => broker.runWorker(args) as Promise<Envelope>, log);
  }
  if (enabled.has("run_agent")) {
    register(server, "run_agent", RunAgentSchema, async (args: Parameters<Broker["runAgent"]>[0]) => broker.runAgent(args) as Promise<Envelope>, log);
  }
  if (enabled.has("delegate")) {
    register(server, "delegate", DelegateSchema, async (args: Parameters<Broker["delegate"]>[0]) => broker.delegate(args) as Promise<Envelope>, log);
  }
  if (enabled.has("delegate_batch")) {
    register<DelegateBatchArgs>(server, "delegate_batch", DelegateBatchSchema, async (args) => {
      // `id` is a caller-side label only: it is stripped before the Broker sees
      // the child, and echoed back in `data.labels` (same order).
      const labels = args.tasks.map((child) => child.id);
      const envelope = (await broker.delegateBatch({ ...args, tasks: args.tasks.map(({ id: _id, ...child }) => child) })) as ToolEnvelope<{
        children: Envelope[];
        labels?: Array<string | undefined>;
      }>;
      if (envelope.data && labels.some((label) => label !== undefined)) {
        envelope.data = { ...envelope.data, labels };
      }
      return envelope as Envelope;
    }, log);
  }
  if (enabled.has("get_task")) {
    register(server, "get_task", GetTaskSchema, async (args: { taskId: string; includeResults?: boolean }) => broker.getTask(args.taskId, args.includeResults ?? true) as Promise<Envelope>, log);
  }
  if (enabled.has("get_trace")) {
    register<GetTraceArgs>(server, "get_trace", GetTraceSchema, async (args) => {
      const trace = await broker.getTrace(args.traceId, args.level ?? "summary");
      return { ok: true, status: "completed", traceId: args.traceId, data: { ...trace } } as Envelope;
    }, log);
  }
  if (enabled.has("cancel_task")) {
    register(server, "cancel_task", CancelTaskSchema, async (args: { taskId: string }) => broker.cancelTask(args.taskId) as Promise<Envelope>, log);
  }
}

/** Exposed for tests: the error shapes the MCP layer can return. */
export type { Envelope as ToolResultEnvelope };
