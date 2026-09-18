import { randomUUID } from "node:crypto";
import { BrokerError, toBrokerError } from "./errors.js";
import { WRITE_CAPABLE_ADAPTERS, type BrokerConfig, type Clock, type Logger, type Store, type TaskRecord, type TaskSubmission, type ToolEnvelope, type TraceLevel, type WorkerInfo, type WorkerRequest, type WorkerResult, type RouterDecision } from "./types.js";
import { ProviderRegistry } from "../providers/provider.js";
import { WorkspaceGuard } from "../security/paths.js";
import { redact } from "../security/redaction.js";
import { RequestPolicy } from "./policy.js";
import { Router } from "./router.js";
import { Scheduler, Semaphore } from "./scheduler.js";
import { TaskManager, aggregateStatus, isTerminal } from "./task-manager.js";
import { TraceStore } from "./trace-store.js";

export interface BrokerOptions {
  config: BrokerConfig; store: Store; logger: Logger; providers: ProviderRegistry;
  scheduler: Scheduler; traceStore: TraceStore; taskManager: TaskManager; clock?: Clock;
}
export interface WorkerData { selectedWorker: string; routeReason: string; route: RouterDecision; result?: WorkerResult }
export interface BatchSubmission {
  mode: "parallel"; tasks: TaskSubmission[]; maxConcurrency?: number; failurePolicy?: "collect_all";
  waitMs?: number; traceLevel?: "summary" | "verbose"; idempotencyKey?: string;
}
export interface BatchData { children: Array<ToolEnvelope<WorkerData>> }

export class Broker {
  private readonly clock: Clock;
  private readonly policy: RequestPolicy;
  private readonly router: Router;
  private readonly paths: WorkspaceGuard;
  private initialization?: Promise<void>;
  constructor(private readonly options: BrokerOptions) {
    this.clock = options.clock ?? { now: () => new Date() };
    this.policy = new RequestPolicy(options.config.limits);
    this.router = new Router(options.config, options.providers);
    this.paths = new WorkspaceGuard(options.config.workspaces, options.config.limits, { allowAnyWorkspace: options.config.server.allowAnyWorkspace });
  }
  init(): Promise<void> {
    return (this.initialization ??= (async () => {
      await this.options.store.init();
      const recovered = await this.options.taskManager.recoveredInterrupted();
      this.options.logger.info("Broker initialized", { recovered });
      if (recovered) {
        // One audit event per recovered task: a queued/running task is marked
        // interrupted, never silently re-run (that could double-bill).
        for (const task of await this.options.store.listInterruptedTasks()) {
          await this.options.traceStore.emit(task.traceId, "broker.recovered", { from: "queued|running", to: "interrupted" }, { taskId: task.id });
        }
      }
      this.options.providers.refresh();
    })());
  }
  ping(): ToolEnvelope<{ service: string }> { return { ok: true, status: "completed", data: { service: "multimodel-broker" } }; }
  /**
   * Reports the worker list with live health facts. The probes are awaited, so
   * `healthy`/`reasonUnavailable` describe the workers now instead of saying
   * "Health check pending" until some later probe happens to land.
   */
  async listWorkers(): Promise<WorkerInfo[]> {
    await this.options.providers.refreshAll();
    const { store } = this.options;
    // Surface the sticky choices so a caller can see what "no worker given" would do, and switch
    // deliberately by naming a different one.
    const remembered: Array<["run_worker" | "run_agent", string]> = [];
    for (const tool of ["run_worker", "run_agent"] as const) {
      const worker = await store.getSetting(`default.worker.${tool}`);
      if (worker) remembered.push([tool, worker]);
    }
    return this.options.providers.workerInfo().map((worker) => {
      const defaultFor = remembered.filter(([, id]) => id === worker.id).map(([tool]) => tool);
      return {
        ...worker,
        maxConcurrency: this.options.config.concurrency[worker.id] ?? worker.maxConcurrency,
        ...(defaultFor.length > 0 ? { defaultFor } : {}),
      };
    });
  }
  /**
   * Run one API worker. Naming a `worker` is an explicit choice and is REMEMBERED (so the next call
   * may omit it and still use the same one); omitting it reuses that remembered choice, and there is
   * no built-in default - with nothing remembered the caller has to name a worker.
   */
  async runWorker(submission: TaskSubmission): Promise<ToolEnvelope<WorkerData>> {
    const resolved = await this.resolveChoice("run_worker", submission, {
      // A write-capable worker is refused by the router for this tool; do not remember one.
      rememberable: (worker) => {
        const adapter = this.options.config.providers[worker]?.adapter;
        return !adapter || !WRITE_CAPABLE_ADAPTERS.has(adapter);
      },
    });
    if (!resolved.worker) {
      throw new BrokerError("INVALID_INPUT", "run_worker requires an explicit worker: name one, or call it once with a worker to make that choice sticky");
    }
    return this.submit("run_worker", resolved);
  }
  delegate(submission: TaskSubmission): Promise<ToolEnvelope<WorkerData>> { return this.submit("delegate", submission); }
  runWorkerLong(submission: TaskSubmission): Promise<ToolEnvelope<WorkerData>> { return this.runWorker(submission); }
  delegateLong(submission: TaskSubmission): Promise<ToolEnvelope<WorkerData>> { return this.delegate(submission); }

  /**
   * Run the local Codex agent, which - unlike every other tool here - can modify files.
   *
   * v0.1 deliberately narrow: `codex` only (it is the only worker with a real local agent
   * runtime), and a workspace is mandatory so the write surface is always an allowlisted
   * directory. Whether writing is permitted at all is a LOCAL decision
   * (`providers.codex.sandbox` + `options.allowWritableSandbox`); a remote caller can ask,
   * never grant itself the capability.
   */
  /**
   * `run_agent` is the only tool that runs a real local agent (file edits + commands), so it accepts
   * only the local-agent adapters declared in config - today the `codex` worker and, when enabled,
   * `codex-win` (the Windows app's build). A caller cannot invent a worker id, and a disabled
   * provider is refused here instead of failing halfway through a run.
   */
  /**
   * `run_agent` is the only tool that can change files, so its worker gate is what decides which
   * local runtimes a caller may reach: any enabled worker whose adapter is write-capable
   * (codex-sdk, claude-code) qualifies, and nothing else does - the API workers must stay
   * unreachable here, and a caller cannot invent a worker id.
   */
  private assertLocalAgentWorker(worker: string): void {
    const provider = this.options.config.providers[worker];
    const adapter = provider?.adapter;
    if (!adapter || !WRITE_CAPABLE_ADAPTERS.has(adapter) || provider?.enabled === false) {
      throw new BrokerError(
        "INVALID_INPUT",
        `run_agent needs an enabled write-capable worker (${[...WRITE_CAPABLE_ADAPTERS].join(", ")}); received "${worker}"`,
      );
    }
  }

  async runAgent(submission: TaskSubmission): Promise<ToolEnvelope<WorkerData>> {
    // Which harness (and therefore which model) runs is the caller's decision; once made it sticks,
    // so a follow-up call may omit it. Nothing is defaulted by the broker itself.
    const resolved = await this.resolveChoice("run_agent", submission, { validate: (worker) => this.assertLocalAgentWorker(worker) });
    const worker = resolved.worker;
    if (!worker) {
      throw new BrokerError(
        "INVALID_INPUT",
        "run_agent requires a worker: name the harness to run (codex | codex-win | claude-code). Once you name one, later calls may omit it.",
      );
    }
    this.assertLocalAgentWorker(worker);
    if (!resolved.workspace) {
      throw new BrokerError(
        "INVALID_INPUT",
        "run_agent requires a workspace: a write-capable agent has to start somewhere (and for the Codex workers it is also the sandbox boundary)",
      );
    }
    return this.submit("run_agent", { ...resolved, worker });
  }

  /**
   * Sticky choice, with an explicit way out.
   *
   * - `worker` given: it becomes the remembered worker for this tool, and shows up in list_workers.
   * - `worker` omitted: the remembered one is used (the request is marked so the trace says so).
   * - `model` given: remembered per worker, and applied when a later call omits it.
   * - `model: "auto"`: forgets that override, so the worker's own configured model applies again.
   *
   * The preference lives in this instance's own store (its own database), so instances - and
   * operators - never share a choice.
   */
  private async resolveChoice(
    tool: "run_worker" | "run_agent",
    submission: TaskSubmission,
    opts: { validate?: (worker: string) => void; rememberable?: (worker: string) => boolean } = {},
  ): Promise<TaskSubmission & { remembered?: boolean }> {
    const { store } = this.options;
    const workerKey = `default.worker.${tool}`;
    if (submission.worker) {
      // Validate BEFORE remembering: a refused worker must never become the sticky choice, or the
      // next call that omits `worker` would inherit an unusable one.
      opts.validate?.(submission.worker);
      if (opts.rememberable?.(submission.worker) === false) return submission;
      await store.setSetting(workerKey, submission.worker);
      const modelKey = `default.model.${submission.worker}`;
      if (submission.model === "auto") await store.deleteSetting(modelKey);
      else if (submission.model) await store.setSetting(modelKey, submission.model);
      return submission;
    }
    const remembered = await store.getSetting(workerKey);
    if (!remembered) return submission;
    try {
      opts.validate?.(remembered);
    } catch {
      // A remembered choice that no longer works (provider disabled since, config changed) is
      // forgotten rather than re-thrown, so the caller gets the plain "name a worker" error.
      await store.deleteSetting(workerKey);
      return submission;
    }
    const rememberedModel = submission.model === undefined ? await store.getSetting(`default.model.${remembered}`) : undefined;
    return { ...submission, worker: remembered, model: submission.model ?? rememberedModel, remembered: true };
  }


  private async submit(kind: "run_worker" | "run_agent" | "run_claude_code" | "delegate" | "batch_child", submission: TaskSubmission & { remembered?: boolean }, parentId?: string): Promise<ToolEnvelope<WorkerData>> {
    const request = this.policy.validate(submission);
    const { taskManager, store } = this.options;
    const { task, reused } = await taskManager.findOrCreateTask(kind, request, request.idempotencyKey);
    // `reused` means an identical idempotencyKey was already seen - possibly by
    // another broker process sharing this database. Starting a second execution
    // would double-bill, so a reused task is only waited on, never re-run.
    if (!reused && !isTerminal(task.status) && !taskManager.hasRun(task.id)) {
      // Register synchronously after the check: concurrent duplicate submissions share this run.
      taskManager.registerRun(task.id, (async () => {
        if (parentId) {
          await store.updateTask(task.id, { parentId });
          const parent = await store.getTask(parentId);
          if (parent?.status === "cancelled") { await taskManager.cancel(task.id); return; }
        }
        await this.execute(task, request);
      })());
    }
    const final = await taskManager.waitFor(task.id, request.waitMs);
    return this.envelope<WorkerData>(final ?? (await store.getTask(task.id))!);
  }

  private envelope<T>(task: TaskRecord): ToolEnvelope<T> {
    return redact({ ok: !["failed", "timed_out", "cancelled", "interrupted"].includes(task.status), status: task.status, taskId: task.id, traceId: task.traceId,
      data: task.resultJson ? JSON.parse(task.resultJson) as T : undefined,
      error: task.errorJson ? JSON.parse(task.errorJson) as ToolEnvelope<T>["error"] : undefined });
  }

  private async execute(task: TaskRecord, request: TaskSubmission & { remembered?: boolean }): Promise<void> {
    const { taskManager, store, traceStore, providers, scheduler, config, logger } = this.options;
    let route: RouterDecision | undefined;
    try {
      const signal = taskManager.signal(task.id);
      if (signal.aborted) return;
      // Only the mutating tools may land on a local agent; the read-only ones must not (see
      // WRITE_CAPABLE_ADAPTERS). The task kind records which tool asked, so this cannot be spoofed.
      route = this.router.route(request, {
        // `run_claude_code` is legacy: merged into run_agent, but stored rows may still carry it.
        allowWriteCapable: task.kind === "run_agent" || task.kind === "run_claude_code",
      });
      await traceStore.emit(task.traceId, "route.selected", { ...route }, { taskId: task.id });
      if (request.remembered) {
        // Never silent: the trace records that this run reused a remembered choice rather than a
        // fresh instruction from the caller.
        await traceStore.emit(task.traceId, "choice.remembered", { tool: task.kind, worker: route.worker, model: request.model ?? null }, { taskId: task.id });
      }
      const data: WorkerData = { selectedWorker: route.worker, routeReason: route.reason, route };
      await taskManager.setStatus(task.id, "queued", { resultJson: JSON.stringify(redact(data)) });
      let resolvedFiles: string[] | undefined;
      let workspace: string | undefined;
      if (request.workspace) {
        workspace = await this.paths.resolveWorkspace(request.workspace);
        resolvedFiles = (await this.paths.validateFiles(request.workspace, request.files ?? [])).map((file) => file.absolutePath);
      }
      const entry = providers.get(route.worker)!;
      const result = await scheduler.run(route.worker, async () => {
        if (signal.aborted) throw signal.reason;
        await taskManager.setStatus(task.id, "running");
        const runId = randomUUID();
        const startedAt = this.clock.now().toISOString();
        const timeoutMs = request.timeoutMs ?? entry.config.defaultTimeoutMs;
        const controller = new AbortController();
        const cancel = () => controller.abort(signal.reason ?? new BrokerError("CANCELLED", "Task cancelled", { retryable: false }));
        signal.addEventListener("abort", cancel, { once: true });
        if (signal.aborted) cancel();
        const timer = setTimeout(() => controller.abort(new BrokerError("TIMEOUT", "Worker deadline exceeded", { retryable: false })), timeoutMs);
        let open = true;
        // A caller-supplied model wins over the configured one; `auto` means "use the configured
        // model". Without this the documented per-run override never left the broker.
        const effectiveModel = request.model && request.model !== "auto" ? request.model : entry.config.model;
        const workerRequest: WorkerRequest = { taskId: task.id, runId, task: request.task, context: request.context, workspace, files: request.files, resolvedFiles, model: effectiveModel, timeoutMs, traceLevel: request.traceLevel ?? "summary",
          emit: (type, payload) => { if (open) void traceStore.emit(task.traceId, type, payload, { taskId: task.id, runId }).catch((error: unknown) => logger.error("Unable to persist provider trace", { error })); },
        };
        let result: WorkerResult;
        try {
          await traceStore.emit(task.traceId, "run.started", { provider: route!.worker, model: workerRequest.model }, { taskId: task.id, runId });
          await traceStore.emit(task.traceId, "prompt.sent", { task: request.task, context: request.context }, { taskId: task.id, runId });
          result = await this.withRetries(() => entry.provider.run(workerRequest, controller.signal), controller.signal, task, runId);
          result = redact({ ...result, taskId: task.id, runId, provider: route!.worker, traceId: task.traceId });
        } catch (error) {
          const failure = toBrokerError(error, "PROVIDER_ERROR");
          result = { taskId: task.id, runId, provider: route!.worker, model: entry.config.model, traceId: task.traceId,
            status: failure.code === "TIMEOUT" ? "timed_out" : failure.code === "CANCELLED" ? "cancelled" : "failed", answer: "", error: redact(failure.toJSON()) };
          await traceStore.emit(task.traceId, "provider.error", { ...result.error }, { taskId: task.id, runId });
        } finally {
          open = false;
          clearTimeout(timer);
          signal.removeEventListener("abort", cancel);
        }
        await store.createRun({ id: runId, taskId: task.id, provider: result.provider, model: result.model, status: result.status, sessionId: result.sessionId, startedAt, finishedAt: this.clock.now().toISOString(), usageJson: result.usage ? JSON.stringify(result.usage) : undefined, traceId: task.traceId });
        if (result.artifacts?.length) await store.saveArtifacts(result.artifacts.map((artifact) => ({ ...artifact, id: randomUUID(), runId })));
        if (result.usage) await traceStore.emit(task.traceId, "usage", { ...result.usage }, { taskId: task.id, runId });
        await traceStore.emit(task.traceId, "provider.response", { answer: result.answer, summary: result.summary, sessionId: result.sessionId, provider: result.provider, model: result.model }, { taskId: task.id, runId });
        await traceStore.emit(task.traceId, "run.finished", { status: result.status, startedAt, finishedAt: this.clock.now().toISOString() }, { taskId: task.id, runId });
        return result;
      });
      await taskManager.setStatus(task.id, result.status, { resultJson: JSON.stringify({ ...data, result }), errorJson: result.error ? JSON.stringify(result.error) : undefined });
    } catch (error) {
      const failure = toBrokerError(error);
      logger.warn("Task failed", { taskId: task.id, error: failure.toJSON() });
      await traceStore.emit(task.traceId, "provider.error", { ...redact(failure.toJSON()) }, { taskId: task.id });
      await taskManager.setStatus(task.id, failure.code === "CANCELLED" ? "cancelled" : failure.code === "TIMEOUT" ? "timed_out" : "failed", { errorJson: JSON.stringify(redact(failure.toJSON())) });
    }
  }

  private async withRetries(invoke: () => Promise<WorkerResult>, signal: AbortSignal, task: TaskRecord, runId: string): Promise<WorkerResult> {
    const { config, traceStore } = this.options;
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await this.abortable(invoke, signal);
        if (result.status === "failed" && result.error) {
          const error = toBrokerError(new BrokerError("PROVIDER_ERROR", result.error.message));
          // The code and explicit classification must both permit an automatic retry.
          const classified = new BrokerError(result.error.code as BrokerError["code"], error.message);
          if (classified.retryable && result.error.retryable) throw classified;
        }
        return result;
      } catch (error) {
        const failure = toBrokerError(error, "PROVIDER_ERROR");
        if (signal.aborted) throw signal.reason;
        if (!failure.retryable || !new BrokerError(failure.code, "").retryable || attempt >= config.limits.maxRetries) throw failure;
        await traceStore.emit(task.traceId, "provider.retry", { attempt: attempt + 1, code: failure.code }, { taskId: task.id, runId });
        await this.delay(config.limits.retryBaseDelayMs * 2 ** attempt, signal);
      }
    }
  }

  private abortable<T>(fn: () => Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise<T>((resolve, reject) => {
      const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
      signal.addEventListener("abort", abort, { once: true });
      void Promise.resolve().then(() => { if (signal.aborted) throw signal.reason; return fn(); }).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
  }
  private delay(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(signal.reason); };
      const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
      signal.addEventListener("abort", abort, { once: true });
    });
  }

  async delegateBatch(submission: BatchSubmission): Promise<ToolEnvelope<BatchData>> {
    if (submission.mode !== "parallel" || (submission.failurePolicy !== undefined && submission.failurePolicy !== "collect_all")) throw new BrokerError("INVALID_INPUT", "Only parallel collect_all batches are supported");
    this.policy.validateBatch(submission.tasks);
    this.policy.validateIdempotencyKey(submission.idempotencyKey);
    this.policy.validateTraceLevel(submission.traceLevel);
    const waitMs = this.policy.clampWaitMs(submission.waitMs);
    const capacity = submission.maxConcurrency ?? this.options.config.concurrency.global;
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new BrokerError("INVALID_INPUT", "maxConcurrency must be a positive integer");
    const { taskManager, store } = this.options;
    const { task: parent, reused } = await taskManager.findOrCreateTask("delegate_batch", submission, submission.idempotencyKey);
    if (reused) {
      // Same reasoning as in submit(): never re-run work that already exists.
      return this.envelope<BatchData>(await taskManager.waitFor(parent.id, waitMs) ?? (await store.getTask(parent.id))!);
    }
    if (!isTerminal(parent.status) && !taskManager.hasRun(parent.id)) taskManager.registerRun(parent.id, (async () => {
      await taskManager.setStatus(parent.id, "running", { totalChildren: submission.tasks.length, completedChildren: 0 });
      const semaphore = new Semaphore(capacity);
      const settled = await Promise.allSettled(submission.tasks.map(async (child) => {
        const release = await semaphore.acquire();
        try {
          if (taskManager.signal(parent.id).aborted) throw new BrokerError("CANCELLED", "Batch cancelled", { retryable: false });
          const started = await this.submit("batch_child", { ...child, idempotencyKey: undefined, traceLevel: child.traceLevel ?? submission.traceLevel, waitMs: 0 }, parent.id);
          const taskId = started.taskId!;
          let record = await store.getTask(taskId);
          while (record && !isTerminal(record.status)) record = await taskManager.waitFor(taskId, 45_000) ?? await store.getTask(taskId);
          const children = await store.listTasksByParent(parent.id);
          await store.updateTask(parent.id, { completedChildren: children.filter((task) => isTerminal(task.status)).length });
          return this.envelope<WorkerData>(record!);
        } finally { release(); }
      }));
      const children: Array<ToolEnvelope<WorkerData>> = settled.map((item) => item.status === "fulfilled" ? item.value : { ok: false, status: toBrokerError(item.reason).code === "CANCELLED" ? "cancelled" : "failed", error: redact(toBrokerError(item.reason).toJSON()) });
      await taskManager.setStatus(parent.id, aggregateStatus(children), { resultJson: JSON.stringify({ children }), completedChildren: children.length, totalChildren: children.length });
    })());
    return this.envelope<BatchData>(await taskManager.waitFor(parent.id, waitMs) ?? (await store.getTask(parent.id))!);
  }

  async getTask(taskId: string, includeResults = true): Promise<ToolEnvelope<{ task: TaskRecord; children: TaskRecord[]; results?: WorkerResult[]; completedChildren: number; totalChildren: number }>> {
    const task = await this.options.store.getTask(taskId);
    if (!task) throw new BrokerError("TASK_NOT_FOUND", "Task does not exist");
    const children = await this.options.store.listTasksByParent(taskId);
    const results = includeResults ? [task, ...children].flatMap((record) => { const result = record.resultJson ? (JSON.parse(record.resultJson) as WorkerData).result : undefined; return result ? [result] : []; }) : undefined;
    if (!includeResults) for (const record of [task, ...children]) delete record.resultJson;
    return { ...this.envelope(task), data: { task, children, results, completedChildren: task.completedChildren ?? children.filter((child) => isTerminal(child.status)).length, totalChildren: task.totalChildren ?? children.length } };
  }
  getTrace(traceId: string, level: TraceLevel = "summary") { return this.options.traceStore.getTrace(traceId, this.policy.validateTraceLevel(level, true)); }
  async cancelTask(taskId: string): Promise<ToolEnvelope<unknown>> { return this.envelope(await this.options.taskManager.cancel(taskId)); }
}
