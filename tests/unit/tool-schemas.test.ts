import { describe, expect, it } from "vitest";
import {
  BATCH_MAX_TASKS,
  CancelTaskSchema,
  DelegateBatchSchema,
  DelegateSchema,
  GetTaskSchema,
  GetTraceSchema,
  PingSchema,
  RunAgentSchema,
  RunWorkerSchema,
  TASK_MAX_CHARS,
  WAIT_MS_MAX,
} from "../../src/interfaces/mcp/schemas.js";

/**
 * Schema-level contract. Anything a model can get wrong (too-long task, bad
 * waitMs, non-parallel batch, nine children, absolute file path, unknown field)
 * must be rejected here, before the Broker is called.
 */
describe("MCP tool schemas", () => {
  it("accepts a minimal run_worker call and applies documented defaults", () => {
    const parsed = RunWorkerSchema.parse({ worker: "mock", task: "hello" });
    expect(parsed).toEqual({ worker: "mock", task: "hello" });
    expect(RunWorkerSchema.parse({ worker: "mock", task: "hello", waitMs: 1000 }).waitMs).toBe(1000);
  });

  it("never invents a worker for run_agent, and accepts only write-capable ones", () => {
    // Omitting `worker` is allowed (the broker reuses the choice you named before), but the schema
    // injects no default: the harness - and therefore the model - is always the caller's choice.
    const omitted = RunAgentSchema.parse({ task: "edit a file", workspace: "scratch" });
    expect(omitted.worker).toBeUndefined();
    for (const worker of ["codex", "codex-win", "claude-code"] as const) {
      expect(RunAgentSchema.parse({ worker, task: "edit a file", workspace: "scratch" }).worker).toBe(worker);
    }
    for (const worker of ["deepseek", "glm", "mock", "claude-code-x"]) {
      expect(RunAgentSchema.safeParse({ worker, task: "edit a file", workspace: "scratch" }).success).toBe(false);
    }
  });

  it("rejects unknown fields instead of silently dropping them", () => {
    for (const schema of [PingSchema, RunWorkerSchema, RunAgentSchema, DelegateSchema, DelegateBatchSchema, GetTaskSchema, GetTraceSchema, CancelTaskSchema]) {
      expect(schema.safeParse({ taskId: "x", task: "y", nope: 1, worker: "mock", mode: "parallel", tasks: [{ task: "t" }] }).success).toBe(false);
    }
    expect(RunWorkerSchema.safeParse({ worker: "mock", task: "hello", bogus: true }).success).toBe(false);
    expect(DelegateSchema.safeParse({ task: "hello", requirements: { coding: true, madeUp: true } }).success).toBe(false);
  });

  it.each([
    ["empty task", { worker: "mock", task: "" }],
    ["task over the hard ceiling", { worker: "mock", task: "x".repeat(TASK_MAX_CHARS + 1) }],
    ["empty worker", { worker: "", task: "hello" }],
    ["negative waitMs", { worker: "mock", task: "hello", waitMs: -1 }],
    ["waitMs above the documented maximum", { worker: "mock", task: "hello", waitMs: WAIT_MS_MAX + 1 }],
    ["fractional waitMs", { worker: "mock", task: "hello", waitMs: 10.5 }],
    ["bad traceLevel", { worker: "mock", task: "hello", traceLevel: "debug" }],
    ["absolute file path", { worker: "mock", task: "hello", workspace: "w", files: ["/etc/passwd"] }],
    ["windows absolute file path", { worker: "mock", task: "hello", workspace: "w", files: ["C:\\secret.txt"] }],
    ["too many files", { worker: "mock", task: "hello", workspace: "w", files: Array.from({ length: 21 }, (_, i) => `f${i}.txt`) }],
    ["bad idempotency key", { worker: "mock", task: "hello", idempotencyKey: " has space" }],
    ["bad timeoutMs", { worker: "mock", task: "hello", timeoutMs: 0 }],
  ])("rejects %s", (_label, input) => {
    expect(RunWorkerSchema.safeParse(input).success).toBe(false);
  });

  it("only accepts parallel collect_all batches of at most eight children", () => {
    expect(DelegateBatchSchema.safeParse({ mode: "parallel", tasks: [{ task: "a" }] }).success).toBe(true);
    expect(DelegateBatchSchema.safeParse({ mode: "sequential", tasks: [{ task: "a" }] }).success).toBe(false);
    expect(DelegateBatchSchema.safeParse({ mode: "parallel", tasks: [] }).success).toBe(false);
    expect(DelegateBatchSchema.safeParse({ mode: "parallel", tasks: Array.from({ length: BATCH_MAX_TASKS }, () => ({ task: "a" })) }).success).toBe(true);
    expect(DelegateBatchSchema.safeParse({ mode: "parallel", tasks: Array.from({ length: BATCH_MAX_TASKS + 1 }, () => ({ task: "a" })) }).success).toBe(false);
    expect(DelegateBatchSchema.safeParse({ mode: "parallel", failurePolicy: "fail_fast", tasks: [{ task: "a" }] }).success).toBe(false);
    expect(DelegateBatchSchema.safeParse({ mode: "parallel", tasks: [{ task: "a", id: "one", requirements: { coding: true } }] }).success).toBe(true);
  });

  it("requires a task id for get_task/cancel_task and a trace for get_trace", () => {
    expect(GetTaskSchema.safeParse({ taskId: "abc" }).success).toBe(true);
    expect(GetTaskSchema.safeParse({}).success).toBe(false);
    expect(GetTaskSchema.safeParse({ taskId: "abc", includeResults: "yes" }).success).toBe(false);
    expect(GetTraceSchema.safeParse({ traceId: "abc", level: "debug" }).success).toBe(true);
    expect(GetTraceSchema.safeParse({ traceId: "abc", level: "everything" }).success).toBe(false);
    expect(CancelTaskSchema.safeParse({ taskId: "abc" }).success).toBe(true);
    expect(CancelTaskSchema.safeParse({}).success).toBe(false);
  });

  it("documents every constraint a caller can hit", () => {
    const described = JSON.stringify({
      run: RunWorkerSchema.shape.task.description,
      wait: RunWorkerSchema.shape.waitMs.description,
      files: RunWorkerSchema.shape.files.description,
      batch: DelegateBatchSchema.shape.mode.description,
      requirements: DelegateSchema.shape.requirements.description,
    });
    expect(described).toMatch(/worker/i);
    expect(described).toMatch(/45|default/i);
    expect(described).toMatch(/absolute|relative/i);
    expect(described).toMatch(/parallel/i);
  });
});
