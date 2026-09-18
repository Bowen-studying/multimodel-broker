/**
 * Tool annotations, exactly as specified by the task book (section 7).
 *
 * WHY `readOnlyHint: true` IS LEGITIMATE FOR THE DELEGATION TOOLS
 * --------------------------------------------------------------
 * `run_worker`, `delegate` and `delegate_batch` consume compute (model quota)
 * and return text. They do not create, update or delete user files, user
 * repositories, database records or third-party business objects, and they
 * perform no external write side effects. That is the definition under which a
 * model-inference tool may be declared read-only.
 *
 * They DO reach outside the process (a third-party model API is called over the
 * network), which is why `openWorldHint` is `true` - never `false` to slip past
 * a client filter.
 *
 * RULE: any future capability that writes (files, git, deploys, DB rows,
 * third-party objects) MUST be exposed as its own tool with `readOnlyHint:
 * false` (and `destructiveHint` set honestly). It must never be folded into
 * `run_worker` while keeping this annotation. Mislabeling annotations to get a
 * client to accept a tool is forbidden by the task book (section 0.6).
 */

export interface ToolAnnotation {
  /** Stable title shown by clients. */
  title: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  openWorldHint: boolean;
  idempotentHint?: boolean;
}

/** Tools exposed by every profile. */
export const TOOL_ANNOTATIONS = {
  ping: {
    title: "Ping Broker",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  list_workers: {
    title: "List Workers",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  run_worker: {
    title: "Run Worker",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
    // A repeated call runs the model again unless the caller passes an
    // idempotencyKey, so this tool is NOT idempotent by itself.
    idempotentHint: false,
  },
  run_agent: {
    title: "Run Local Agent (writes files and runs commands)",
    // Honest annotation: this is the one tool that changes files on disk. It drives whichever local
    // agent the caller names (Codex, the Windows Codex build, or local Claude Code), so it is
    // mutating, potentially destructive and reaches outside the process. Every write-capable worker
    // is reachable ONLY here - never through a tool advertised as read-only.
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: true,
    // Re-running writes again (and a repeated call is a new agent run), so it is
    // not idempotent unless the caller supplies an idempotencyKey.
    idempotentHint: false,
  },
  delegate: {
    title: "Delegate Task",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
    idempotentHint: false,
  },
  delegate_batch: {
    title: "Delegate Batch (parallel)",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
    idempotentHint: false,
  },
  get_task: {
    title: "Get Task",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  get_trace: {
    title: "Get Trace",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  cancel_task: {
    title: "Cancel Task (local profile only)",
    // Cancelling mutates broker state and aborts a running provider call, so it
    // is honestly annotated as a non-read-only, destructive tool and is only
    // exposed in the local/full profile - never in the ChatGPT Pro profile.
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false,
  },
} as const satisfies Record<string, ToolAnnotation>;

/** Annotation payload shape accepted by the MCP SDK (no `title` duplicates). */
export type McpAnnotations = {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  openWorldHint: boolean;
  idempotentHint?: boolean;
};

export function annotationsFor(name: keyof typeof TOOL_ANNOTATIONS): { title: string; annotations: McpAnnotations } {
  const { title, ...annotations } = TOOL_ANNOTATIONS[name];
  return { title, annotations };
}
