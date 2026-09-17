import { BrokerError } from "./errors.js";
import type { BrokerConfig, TaskSubmission, TraceLevel } from "./types.js";

export class RequestPolicy {
  constructor(private readonly limits: BrokerConfig["limits"]) {}

  clampWaitMs(waitMs?: number): number {
    if (waitMs !== undefined && (!Number.isFinite(waitMs) || waitMs < 0)) throw new BrokerError("INVALID_INPUT", "waitMs must be a nonnegative finite number");
    return Math.min(Math.floor(waitMs ?? this.limits.defaultWaitMs), this.limits.maxWaitMs, 45_000);
  }

  validateTraceLevel(level: unknown, allowDebug = false): TraceLevel {
    if (level === undefined) return "summary";
    if (level === "summary" || level === "verbose" || (allowDebug && level === "debug")) return level;
    throw new BrokerError("INVALID_INPUT", "traceLevel must be summary or verbose" + (allowDebug ? " or debug" : ""));
  }

  validateIdempotencyKey(key: unknown): void {
    if (key !== undefined && (typeof key !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(key))) throw new BrokerError("INVALID_INPUT", "idempotencyKey must be 1-128 letters, digits, '.', '_', ':', or '-' and start with a letter or digit");
  }

  validate(submission: TaskSubmission): TaskSubmission & { waitMs: number; traceLevel: "summary" | "verbose" } {
    if (!submission || typeof submission.task !== "string" || !submission.task.trim()) throw new BrokerError("INVALID_INPUT", "task must be nonempty text");
    if (submission.task.length > this.limits.maxTaskChars) throw new BrokerError("LIMIT_EXCEEDED", "task exceeds maxTaskChars");
    if (submission.context !== undefined && typeof submission.context !== "string") throw new BrokerError("INVALID_INPUT", "context must be text");
    if ((submission.context?.length ?? 0) > this.limits.maxContextChars) throw new BrokerError("LIMIT_EXCEEDED", "context exceeds maxContextChars");
    if (submission.files !== undefined && (!Array.isArray(submission.files) || submission.files.some((file) => typeof file !== "string"))) throw new BrokerError("INVALID_INPUT", "files must be a list of paths");
    if ((submission.files?.length ?? 0) > this.limits.maxFiles) throw new BrokerError("LIMIT_EXCEEDED", "files exceeds maxFiles");
    if (submission.files?.length && !submission.workspace) throw new BrokerError("INVALID_INPUT", "files requires a workspace name");
    for (const key of ["workspace", "worker"] as const) {
      if (submission[key] !== undefined && (typeof submission[key] !== "string" || !submission[key]!.trim())) throw new BrokerError("INVALID_INPUT", `${key} must be nonempty text`);
    }
    if (submission.requirements !== undefined && (!submission.requirements || typeof submission.requirements !== "object" || Array.isArray(submission.requirements) || Object.values(submission.requirements).some((value) => typeof value !== "boolean"))) throw new BrokerError("INVALID_INPUT", "requirements must contain boolean flags");
    if (submission.timeoutMs !== undefined && (!Number.isSafeInteger(submission.timeoutMs) || submission.timeoutMs <= 0 || submission.timeoutMs > 2_147_483_647)) throw new BrokerError("INVALID_INPUT", "timeoutMs must be a positive timer duration");
    if (submission.model !== undefined) {
      // It travels to a child process as an argument, so keep it to a plain identifier: no shell
      // metacharacters, no option-like leading dash, no unbounded length.
      if (typeof submission.model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(submission.model.trim())) {
        throw new BrokerError("INVALID_INPUT", "model must be a plain identifier such as gpt-6-astra");
      }
    }
    this.validateIdempotencyKey(submission.idempotencyKey);
    const traceLevel = this.validateTraceLevel(submission.traceLevel) as "summary" | "verbose";
    return { ...submission, waitMs: this.clampWaitMs(submission.waitMs), traceLevel };
  }

  validateBatch(tasks: TaskSubmission[]): void {
    if (!Array.isArray(tasks) || !tasks.length) throw new BrokerError("INVALID_INPUT", "tasks must be a nonempty list");
    if (tasks.length > this.limits.maxBatchTasks) throw new BrokerError("LIMIT_EXCEEDED", "tasks exceeds maxBatchTasks");
    tasks.forEach((task) => this.validate(task));
  }
}
