import { access } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { BrokerError, isBrokerError, toBrokerError } from "../../core/errors.js";
import type { ProviderConfig, ProviderHealth, WorkerProvider, WorkerRequest, WorkerResult } from "../../core/types.js";

/**
 * Codex worker, built on the official `@openai/codex-sdk`.
 *
 * Hard rules
 * ----------
 * - Authentication is the user's existing official Codex login. This provider
 *   NEVER reads, copies, prints or exports `~/.codex/auth.json` (or any token);
 *   doctor only reports whether the file exists, as a boolean.
 * - Default sandbox is `read-only`, so the agent can read the allowlisted
 *   workspace but cannot modify the user's real repositories. The provider never
 *   runs `git push`, `git commit` or a deploy.
 * - `approvalPolicy` defaults to `never` (a non-interactive MCP server cannot
 *   answer approval prompts) and `"on-request"` is rejected outright.
 * - Trace content is limited to what the SDK actually returns (prompt,
 *   workspace, thread id, timings, final response, usage, errors, and - in
 *   verbose mode - the real tool events it emits). `reasoning` items are dropped
 *   entirely: hidden chain-of-thought is never stored or returned.
 * - The SDK is imported lazily: a machine without it must still start the broker.
 */

/* ------------------------------------------------------------------ */
/* Minimal structural seam over the SDK (a fake can be injected in tests)       */
/* ------------------------------------------------------------------ */

export interface CodexUsageLike {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
}

export interface CodexItemLike {
  type: string;
  [key: string]: unknown;
}

export type CodexEventLike =
  | { type: "thread.started"; thread_id?: string }
  | { type: "turn.started" }
  | { type: "turn.completed"; usage?: CodexUsageLike | null }
  | { type: "turn.failed"; error?: { message?: string } }
  | { type: "item.started" | "item.updated" | "item.completed"; item?: CodexItemLike }
  | { type: "error"; message?: string };

export interface CodexThreadLike {
  readonly id: string | null;
  run(input: string, options?: { signal?: AbortSignal }): Promise<{ items?: CodexItemLike[]; finalResponse?: string; usage?: CodexUsageLike | null }>;
  runStreamed?(input: string, options?: { signal?: AbortSignal }): Promise<{ events: AsyncIterable<CodexEventLike> }>;
}

export interface CodexThreadOptionsLike {
  model?: string;
  sandboxMode?: "read-only" | "workspace-write" | "danger-full-access";
  workingDirectory?: string;
  skipGitRepoCheck?: boolean;
  approvalPolicy?: "never" | "on-request" | "on-failure" | "untrusted";
  modelReasoningEffort?: string;
  additionalDirectories?: string[];
  /** Egress switch. Set explicitly, never left to an SDK default. */
  networkAccessEnabled?: boolean;
  /** `disabled` keeps web search off; `cached`/`live` must be opted into. */
  webSearchMode?: "disabled" | "cached" | "live";
}

export interface CodexInstanceLike {
  startThread(options?: CodexThreadOptionsLike): CodexThreadLike;
  resumeThread(id: string, options?: CodexThreadOptionsLike): CodexThreadLike;
}

/**
 * The options `@openai/codex-sdk` actually reads. Declared explicitly - and as a type alias, so an
 * unknown key becomes a compile error - because the SDK ignores unrecognised keys silently: passing
 * `executablePath` instead of `codexPathOverride` ran the bundled binary and looked fine.
 */
export type CodexSdkOptions = {
  codexPathOverride?: string;
  baseUrl?: string;
  apiKey?: string;
  envOverride?: Record<string, string>;
  config?: Record<string, unknown>;
};

export interface CodexSdkModule {
  Codex: new (options?: CodexSdkOptions) => CodexInstanceLike;
}

export type CodexSdkLoader = () => Promise<CodexSdkModule | undefined>;

const defaultLoader: CodexSdkLoader = async () => {
  try {
    const module = (await import("@openai/codex-sdk")) as unknown as CodexSdkModule;
    return typeof module?.Codex === "function" ? module : undefined;
  } catch {
    return undefined;
  }
};

export interface CodexProviderDeps {
  /** Test seam: replaces the real SDK import. */
  loadSdk?: CodexSdkLoader;
  /** Test seam: replaces the `~/.codex/auth.json` existence probe. */
  authFileExists?: () => Promise<boolean>;
  env?: NodeJS.ProcessEnv;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export class CodexProvider implements WorkerProvider {
  readonly id: string;
  readonly capabilities = ["text", "coding", "repository", "tests"] as const;
  readonly authMode = "codex-local" as const;
  private readonly config: ProviderConfig;
  private readonly deps: CodexProviderDeps;
  private sdk?: CodexSdkModule;
  private sdkLoadAttempted = false;

  constructor(id: string, config: ProviderConfig, deps: CodexProviderDeps = {}) {
    this.id = id;
    this.config = config;
    this.deps = deps;
  }

  private option<T>(key: string): T | undefined {
    return this.config.options?.[key] as T | undefined;
  }

  private get sandbox(): "read-only" | "workspace-write" | "danger-full-access" {
    return this.config.sandbox ?? "read-only";
  }

  private get requireWorkspace(): boolean {
    return this.option<boolean>("requireWorkspace") ?? true;
  }

  /**
   * `options.inheritCodexSettings: true` means "use whatever the operator configured in Codex":
   * no sandbox, approval, egress or web-search field is sent to the SDK, so the run follows
   * ~/.codex/config.toml (or Codex's own defaults) instead of this broker's opinion. Off by
   * default - the explicit policy is what the read-only/agent annotations are documented against.
   */
  private get inheritCodexSettings(): boolean {
    return this.option<boolean>("inheritCodexSettings") ?? false;
  }

  private get skipGitRepoCheck(): boolean {
    return this.option<boolean>("skipGitRepoCheck") ?? false;
  }

  private get approvalPolicy(): "never" | "on-failure" | "untrusted" {
    const configured = this.option<string>("approvalPolicy") ?? "never";
    if (configured === "on-request") {
      // A non-interactive MCP server cannot answer approval prompts, so this
      // would simply hang until the timeout.
      throw new BrokerError("CONFIG_ERROR", `${this.id}: approvalPolicy "on-request" is not supported by a non-interactive broker`);
    }
    if (configured !== "never" && configured !== "on-failure" && configured !== "untrusted") {
      throw new BrokerError("CONFIG_ERROR", `${this.id}: unknown approvalPolicy`);
    }
    return configured;
  }

  /** `model: "auto"` means "let Codex choose"; a model id is never hardcoded. */
  private get model(): string | undefined {
    const model = this.config.model?.trim();
    return !model || model === "auto" ? undefined : model;
  }

  /**
   * Egress is OFF and web search is DISABLED unless the operator asks for them
   * explicitly, because the MCP tools advertise `readOnlyHint: true` on the
   * promise that a worker only spends compute and returns text. A filesystem
   * sandbox does not imply "no network", so this is locked down here rather than
   * inherited from an SDK default.
   */
  private get networkAccessEnabled(): boolean {
    const requested = this.option<boolean>("networkAccessEnabled") ?? false;
    if (requested && this.option<boolean>("allowNetworkAccess") !== true) {
      throw new BrokerError(
        "CONFIG_ERROR",
        `${this.id}: options.networkAccessEnabled=true requires options.allowNetworkAccess=true, because the tools are advertised as read-only`,
      );
    }
    return requested;
  }

  private get webSearchMode(): "disabled" | "cached" | "live" {
    const requested = this.option<string>("webSearchMode") ?? "disabled";
    if (requested !== "disabled" && requested !== "cached" && requested !== "live") {
      throw new BrokerError("CONFIG_ERROR", `${this.id}: unknown webSearchMode "${requested}"`);
    }
    if (requested !== "disabled" && this.option<boolean>("allowWebSearch") !== true) {
      throw new BrokerError(
        "CONFIG_ERROR",
        `${this.id}: options.webSearchMode="${requested}" requires options.allowWebSearch=true, because the tools are advertised as read-only`,
      );
    }
    return requested;
  }

  private authFile(): string {
    const home = this.deps.env?.["CODEX_HOME"] ?? this.config.options?.["codexHome"] as string | undefined;
    return path.join(home ?? path.join(os.homedir(), ".codex"), "auth.json");
  }

  private async hasAuth(): Promise<boolean> {
    if (this.deps.authFileExists) return this.deps.authFileExists();
    try {
      await access(this.authFile());
      return true;
    } catch {
      return false;
    }
  }

  private async sdkModule(): Promise<CodexSdkModule | undefined> {
    if (this.sdkLoadAttempted) return this.sdk;
    this.sdkLoadAttempted = true;
    this.sdk = await (this.deps.loadSdk ?? defaultLoader)();
    return this.sdk;
  }

  /**
   * When `options.windowsPaths` is on, a WSL mount path becomes the Windows path the Windows Codex
   * build can actually use as its working directory (`/mnt/c/x` -> `C:\x`). Other paths are
   * returned unchanged, so the same code path keeps working for the Linux build.
   */
  private toHostPath(target: string): string {
    if (!this.option<boolean>("windowsPaths")) return target;
    const match = /^\/mnt\/([a-z])\/(.*)$/.exec(target);
    if (!match) return target;
    return `${match[1]!.toUpperCase()}:\\${match[2]!.replace(/\//g, "\\")}`;
  }

  /**
   * Which Codex build to run: the SDK default, or an explicit binary (e.g. the Windows app's).
   * The SDK reads `codexPathOverride`; any other name is silently ignored and the bundled binary
   * runs instead, which looks like a working run until you notice where the session was written.
   */
  private sdkOptions(): CodexSdkOptions {
    const codexPath = this.option<string>("codexPath");
    return codexPath ? { codexPathOverride: codexPath } : {};
  }

  private threadOptions(request?: WorkerRequest): CodexThreadOptionsLike {
    // Inheritance mode: send no permission-related field at all, so Codex applies its own settings.
    const options: CodexThreadOptionsLike = this.inheritCodexSettings
      ? { skipGitRepoCheck: this.skipGitRepoCheck }
      : {
        sandboxMode: this.sandbox,
        approvalPolicy: this.approvalPolicy,
        skipGitRepoCheck: this.skipGitRepoCheck,
        // Locked explicitly: read-only file access does not imply "no network".
        networkAccessEnabled: this.networkAccessEnabled,
        webSearchMode: this.webSearchMode,
      };
    // A caller-supplied model wins over the configured default; `auto` means "ask Codex".
    const requestedModel = request?.model?.trim();
    const model = requestedModel && requestedModel !== "auto" ? requestedModel : this.model;
    if (model) options.model = model;
    const effort = this.option<string>("modelReasoningEffort");
    if (effort) options.modelReasoningEffort = effort;
    const workspace = request?.workspace;
    if (workspace) options.workingDirectory = this.toHostPath(workspace);
    const additional = this.option<string[]>("additionalDirectories");
    if (additional?.length) options.additionalDirectories = additional.map((dir) => this.toHostPath(dir));
    return options;
  }

  private assertWorkspace(request: WorkerRequest): void {
    if (!request.workspace && this.requireWorkspace) {
      throw new BrokerError("INVALID_INPUT", `${this.id}: this worker requires an allowlisted workspace (set providers.${this.id}.options.requireWorkspace=false only if that is intended)`);
    }
    if (!this.inheritCodexSettings && this.sandbox !== "read-only" && !this.option<boolean>("allowWritableSandbox")) {
      throw new BrokerError("CONFIG_ERROR", `${this.id}: sandbox "${this.sandbox}" requires options.allowWritableSandbox=true`);
    }
  }

  async healthCheck(): Promise<ProviderHealth> {
    const checkedAt = new Date().toISOString();
    const sdk = await this.sdkModule();
    if (!sdk) return { healthy: false, checkedAt, reason: "codex sdk not installed" };
    // A misconfigured egress switch is a configuration error, not a crash: report
    // it the same way a missing login is reported.
    let egress: { networkAccessEnabled: boolean | "from-codex-config"; webSearchMode: string | "from-codex-config" };
    try {
      egress = this.inheritCodexSettings
        ? { networkAccessEnabled: "from-codex-config", webSearchMode: "from-codex-config" }
        : { networkAccessEnabled: this.networkAccessEnabled, webSearchMode: this.webSearchMode };
    } catch (error) {
      return { healthy: false, checkedAt, reason: toBrokerError(error, "CONFIG_ERROR").message };
    }
    const auth = await this.hasAuth();
    return {
      healthy: auth,
      checkedAt,
      reason: auth ? undefined : `codex login not found (auth file missing at ${this.authFile()})`,
      details: {
        sdk: true,
        authFilePresent: auth,
        sandbox: this.inheritCodexSettings ? "from-codex-config" : this.sandbox,
        model: this.model ?? "auto",
        inheritCodexSettings: this.inheritCodexSettings,
        codexPath: this.option<string>("codexPath") ?? "sdk-default",
        windowsPaths: this.option<boolean>("windowsPaths") ?? false,
        ...egress,
      },
    };
  }

  async run(request: WorkerRequest, signal: AbortSignal): Promise<WorkerResult> {
    this.assertWorkspace(request);
    const sdk = await this.sdkModule();
    if (!sdk) throw new BrokerError("PROVIDER_NOT_IMPLEMENTED", `${this.id}: @openai/codex-sdk is not installed`);
    const instance = new sdk.Codex(this.sdkOptions());
    const thread = instance.startThread(this.threadOptions(request));
    return this.execute(thread, this.threadPrompt(request), request, signal);
  }

  async resume(sessionId: string, request: WorkerRequest, signal: AbortSignal): Promise<WorkerResult> {
    this.assertWorkspace(request);
    const sdk = await this.sdkModule();
    if (!sdk) throw new BrokerError("PROVIDER_NOT_IMPLEMENTED", `${this.id}: @openai/codex-sdk is not installed`);
    const thread = new sdk.Codex(this.sdkOptions()).resumeThread(sessionId, this.threadOptions(request));
    return this.execute(thread, this.threadPrompt(request), request, signal);
  }

  private threadPrompt(request: WorkerRequest): string {
    return request.context ? `${request.task}\n\nContext provided by the caller:\n${request.context}` : request.task;
  }

  /** Emits the facts the SDK actually provides; never invents command/tool events. */
  private async execute(thread: CodexThreadLike, prompt: string, request: WorkerRequest, signal: AbortSignal): Promise<WorkerResult> {
    const startedAt = new Date().toISOString();
    request.emit?.("provider.request", {
      provider: this.id,
      workspace: request.workspace,
      sandbox: this.sandbox,
      approvalPolicy: this.approvalPolicy,
      skipGitRepoCheck: this.skipGitRepoCheck,
      networkAccessEnabled: this.networkAccessEnabled,
      webSearchMode: this.webSearchMode,
      model: this.model ?? "auto",
      startedAt,
    });
    try {
      // Always stream when the SDK offers it. `runBuffered` records no tool events, and for a
      // write-capable agent "which command changed which file" is audit data, not a debug
      // nicety - losing it because a caller omitted `traceLevel` is not acceptable.
      // (Measured 2026-09-17: the first ChatGPT run_agent call edited a file and ran a test
      // with zero tool events in the trace for exactly that reason.)
      const outcome = await this.runStreamed(thread, prompt, request, signal);
      request.emit?.("note", { provider: this.id, threadId: thread.id ?? undefined, timedOut: false });
      return {
        taskId: request.taskId,
        runId: request.runId,
        provider: this.id,
        model: this.model,
        status: "completed",
        answer: outcome.finalResponse,
        sessionId: thread.id ?? undefined,
        usage: outcome.usage,
        traceId: "",
      };
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      throw toBrokerError(error, "PROVIDER_ERROR");
    }
  }

  /**
   * Post-send classification. The Codex SDK retries transport hiccups internally ("Reconnecting... N/5")
   * and only surfaces them once they are exhausted; by then the prompt has been delivered, so an
   * automatic retry here would re-run a task that may already have edited files. Rate limits stay
   * retryable - they are refused before any work happens.
   */
  private classifyPostSendFailure(message: string): BrokerError {
    const text = message.toLowerCase();
    if (/rate limit|429|too many requests/.test(text)) return new BrokerError("PROVIDER_RATE_LIMITED", `${this.id}: ${message}`);
    if (/reconnect|timed out|timeout|disconnect|stream|connection|os error|econnreset|econnrefused|broken pipe/.test(text)) {
      return new BrokerError("CONNECTION_LOST_AFTER_SEND", `${this.id}: ${message}`, { retryable: false });
    }
    return new BrokerError("PROVIDER_ERROR", `${this.id}: ${message}`);
  }

  private async runBuffered(thread: CodexThreadLike, prompt: string, signal: AbortSignal) {
    const turn = await thread.run(prompt, { signal });
    const finalResponse = turn.finalResponse ?? "";
    if (!finalResponse.trim()) throw new BrokerError("PROVIDER_BAD_RESPONSE", `${this.id}: Codex returned no final response`, { retryable: false });
    return { finalResponse, usage: this.mapUsage(turn.usage) };
  }

  /**
   * Streaming records real tool events, whatever the requested trace level: file_change and
   * command_execution are the audit trail of a write. `reasoning` items are deliberately dropped -
   * they are hidden chain-of-thought and must never be traced.
   */
  private async runStreamed(thread: CodexThreadLike, prompt: string, request: WorkerRequest, signal: AbortSignal) {
    if (!thread.runStreamed) return this.runBuffered(thread, prompt, signal);
    let finalResponse = "";
    let usage: WorkerResult["usage"];
    try {
      const { events } = await thread.runStreamed(prompt, { signal });
      for await (const event of events) {
        if (signal.aborted) throw signal.reason ?? new BrokerError("CANCELLED", "Codex run cancelled", { retryable: false });
        if (event.type === "turn.completed") {
          usage = this.mapUsage(event.usage);
          continue;
        }
        // Both of these arrive AFTER the agent has been handed the prompt, so the run may already
        // have touched files: classify them as post-send failures rather than retryable ones.
        if (event.type === "turn.failed") throw this.classifyPostSendFailure("turn failed");
        if (event.type === "error") throw this.classifyPostSendFailure(event.message ?? "stream error");
        if (event.type !== "item.completed" || !event.item) continue;
        const item = event.item;
        if (item.type === "agent_message" && typeof item["text"] === "string") finalResponse = item["text"];
        if (item.type === "reasoning") continue; // never traced
        if (item.type === "command_execution" || item.type === "file_change" || item.type === "mcp_tool_call" || item.type === "web_search") {
          request.emit?.("tool.event", { provider: this.id, itemType: item.type, id: item["id"], status: item["status"], command: item["command"], tool: item["tool"] });
        }
      }
    } catch (error) {
      // Cancellation and our own deadline keep their meaning; anything else raised here happened after
      // the prompt was delivered (the SDK had already started a thread), so it must not be retried -
      // a retried write-capable run can duplicate work, which is exactly what
      // CONNECTION_LOST_AFTER_SEND exists for (see src/core/errors.ts).
      if (error instanceof BrokerError && (error.code === "CANCELLED" || error.code === "TIMEOUT")) throw error;
      throw this.classifyPostSendFailure(error instanceof Error ? error.message : String(error));
    }
    if (!finalResponse.trim()) throw new BrokerError("PROVIDER_BAD_RESPONSE", `${this.id}: Codex returned no final response`, { retryable: false });
    return { finalResponse, usage };
  }

  private mapUsage(usage: CodexUsageLike | null | undefined): WorkerResult["usage"] {
    if (!usage) return undefined;
    return {
      inputTokens: numberOrUndefined(usage.input_tokens),
      outputTokens: numberOrUndefined(usage.output_tokens),
      cacheHitTokens: numberOrUndefined(usage.cached_input_tokens),
    };
  }
}
