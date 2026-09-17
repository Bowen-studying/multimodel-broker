import { BrokerError, ErrorCodes, type ErrorCode } from "../../core/errors.js";
import type { MockConfig, ProviderConfig, ProviderHealth, WorkerProvider, WorkerRequest, WorkerResult } from "../../core/types.js";

export class MockProvider implements WorkerProvider {
  readonly capabilities = ["text", "mock"];
  readonly authMode = "unknown" as const;
  private readonly attempts = new Map<string, number>();
  private readonly config: MockConfig;
  constructor(readonly id = "mock", config: ProviderConfig | MockConfig = {}) {
    this.config = "adapter" in config ? config.mock ?? {} : config;
  }
  async healthCheck(): Promise<ProviderHealth> { return { healthy: true, checkedAt: new Date().toISOString() }; }
  async run(request: WorkerRequest, signal: AbortSignal): Promise<WorkerResult> {
    const aborted = () => signal.reason instanceof BrokerError ? signal.reason : new BrokerError("CANCELLED", "Mock run cancelled", { retryable: false });
    if (signal.aborted) throw aborted();
    const rule = this.config.rules?.find((candidate) => request.task.startsWith(candidate.match));
    const behavior = rule?.behavior ?? this.config.behavior ?? "success";
    const attempt = (this.attempts.get(request.runId) ?? 0) + 1;
    this.attempts.set(request.runId, attempt);
    if (attempt <= (this.config.failFirstAttempts ?? 0)) throw new BrokerError("PROVIDER_RATE_LIMITED", "Mock retryable rate limit");
    await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => { if (timer) clearTimeout(timer); signal.removeEventListener("abort", abort); };
      const abort = () => { cleanup(); reject(aborted()); };
      signal.addEventListener("abort", abort, { once: true });
      if (behavior === "hang") return;
      timer = setTimeout(() => {
        cleanup();
        if (behavior === "timeout") reject(new BrokerError("TIMEOUT", "Mock run timed out", { retryable: false }));
        else resolve();
      }, behavior === "timeout" ? request.timeoutMs : rule?.delayMs ?? this.config.delayMs ?? 0);
    });
    if (behavior === "fail") {
      const code = rule?.errorCode && Object.hasOwn(ErrorCodes, rule.errorCode) ? rule.errorCode as ErrorCode : "PROVIDER_ERROR";
      throw new BrokerError(code, "Mock configured failure", { retryable: false });
    }
    this.attempts.delete(request.runId);
    const answer = (rule?.answer ?? this.config.answer ?? "Mock answer: {{task}}").replace(/\{\{(task|context|worker)\}\}/g, (_, name: string) => name === "worker" ? this.id : name === "task" ? request.task : request.context ?? "");
    return { taskId: request.taskId, runId: request.runId, provider: this.id, model: request.model, status: "completed", answer, traceId: "", usage: { ...this.config.usage ?? { inputTokens: 10, outputTokens: 5, cost: 0 } } };
  }
}
