import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { BrokerError, toBrokerError } from "../../core/errors.js";
import type { ProviderConfig, ProviderHealth, WorkerProvider, WorkerRequest, WorkerResult } from "../../core/types.js";

/**
 * `claude-code` worker: runs the LOCAL Claude Code CLI non-interactively, on the DeepSeek backend,
 * in full-auto mode, so a remote caller (ChatGPT through the relay) can delegate real file edits.
 *
 * Why a separate worker instead of folding it into `run_worker`
 * ------------------------------------------------------------
 * The delegation tools are advertised as `readOnlyHint: true`. This worker writes files, so it is
 * exposed through `run_agent(worker="claude-code")` with honest annotations - see
 * src/interfaces/mcp/annotations.ts.
 *
 * Measured facts this provider is built on (2026-09-17, this machine)
 * ------------------------------------------------------------------
 * - `--permission-mode auto` allows file edits AND shell commands; each run is ~24k input tokens of
 *   fixed harness overhead, served mostly from DeepSeek's automatic prefix cache.
 * - Claude Code's own `total_cost_usd` is priced with Anthropic's table and is ~500x the real
 *   DeepSeek charge, so it is reported as `cost_reported_usd` and never used as the bill. The real
 *   figure comes from the runner's token-based `cost_estimate_usd`.
 * - `~/.claude/settings.json` points ANTHROPIC_BASE_URL at a local router that is usually not
 *   running; the runner overrides it with `--settings` and keeps secrets in a 0600 temp file.
 *
 * Safety posture (deliberate, and configurable)
 * --------------------------------------------
 * - The working directory comes from the caller's `workspace` (any absolute path when the instance
 *   sets `allowAnyWorkspace`), or from `options.defaultCwd`. Runs in the same directory are
 *   SERIALIZED in-process, because two agents editing one tree would clobber each other.
 * - `options.permissionMode` defaults to `auto` (edits + commands). `acceptEdits` and `plan` are
 *   accepted; `bypassPermissions` must be opted into explicitly by the operator.
 * - Nothing here reads or copies credentials: the runner sources the operator's own env script.
 */

/** One parsed line of the runner's stdout contract. */
export interface ClaudeCodeSummary {
  status: "ok" | "error" | "timeout";
  exit_code?: number;
  model_requested?: string;
  models?: string[];
  permission_mode?: string;
  cwd?: string;
  result?: string;
  usage?: {
    input_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    output_tokens?: number;
  };
  cost_estimate_usd?: number;
  cost_reported_usd?: number;
  duration_ms?: number;
  num_turns?: number;
  files_touched?: Array<{ path: string; tool: string }>;
  commands?: string[];
  web_fetches?: string[];
  permission_denials?: unknown[];
  session_id?: string;
  stderr_tail?: string;
  /** Set by the runner when it could not even start the CLI (missing binary, bad path). */
  error?: string;
  claude_bin?: string;
}

export interface ClaudeCodeExecResult { code: number | null; stdout: string; stderr: string }

export interface ClaudeCodeProviderDeps {
  /** Test seam: replaces the real process spawn. */
  exec?: (args: string[], options: { cwd: string; signal: AbortSignal; env: NodeJS.ProcessEnv }) => Promise<ClaudeCodeExecResult>;
  env?: NodeJS.ProcessEnv;
  /** Test seam: file existence probe. */
  fileExists?: (target: string) => Promise<boolean>;
}

const CLIENT_SAFE_MODES = ["auto", "acceptEdits", "plan", "manual", "dontAsk"] as const;

export class ClaudeCodeProvider implements WorkerProvider {
  readonly id: string;
  readonly capabilities = ["text", "coding", "repository", "files", "commands", "local-agent"] as const;
  readonly authMode = "api-key" as const;
  private readonly config: ProviderConfig;
  private readonly deps: ClaudeCodeProviderDeps;
  /** One promise chain per absolute working directory: same-dir runs never overlap. */
  private readonly dirQueue = new Map<string, Promise<unknown>>();

  constructor(id: string, config: ProviderConfig, deps: ClaudeCodeProviderDeps = {}) {
    this.id = id;
    this.config = config;
    this.deps = deps;
  }

  private option<T>(key: string): T | undefined {
    return this.config.options?.[key] as T | undefined;
  }

  private get runnerPath(): string {
    const configured = this.option<string>("runnerPath");
    if (!configured) throw new BrokerError("CONFIG_ERROR", `${this.id}: options.runnerPath is required (path to claude_code_run.mjs)`);
    return configured;
  }

  private get permissionMode(): string {
    const configured = this.option<string>("permissionMode") ?? "auto";
    if (!CLIENT_SAFE_MODES.includes(configured as (typeof CLIENT_SAFE_MODES)[number])) {
      if (configured === "bypassPermissions" && this.option<boolean>("allowBypassPermissions") === true) return configured;
      throw new BrokerError(
        "CONFIG_ERROR",
        `${this.id}: permissionMode "${configured}" is not allowed (use auto | acceptEdits | plan; bypassPermissions needs options.allowBypassPermissions=true)`,
      );
    }
    return configured;
  }

  private get defaultCwd(): string | undefined {
    return this.option<string>("defaultCwd");
  }

  private get model(): string {
    // The worker's model is a config value, and a caller may override it per run (the user asked to
    // keep that door open). `auto` is not meaningful here: the CLI needs a concrete backend model.
    const configured = this.config.model?.trim();
    if (!configured || configured === "auto") {
      throw new BrokerError("CONFIG_ERROR", `${this.id}: set a concrete model id for this worker - the model is configuration, and this project ships no default`);
    }
    return configured;
  }

  /**
   * The interpreter that runs the runner script. Defaults to the Node that is running the broker
   * itself: under systemd (or any launcher with a minimal PATH) a bare "node" is not resolvable, and
   * that failure only shows up as `spawn node ENOENT` at run time. An operator can still pin a
   * different binary with options.nodeBinary.
   */
  private get nodeBinary(): string {
    return this.option<string>("nodeBinary") ?? process.execPath;
  }

  /**
   * Optional file that exports the backend endpoint/token. Nothing here assumes a personal layout:
   * an explicit `options.envScript` or `$CLAUDE_ENV_SCRIPT` wins, and when neither is set the runner
   * falls back to `~/.config/multimodel-broker/claude-code.env` if it exists, or to the environment it
   * was started with - so `export ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN` is a complete setup.
   */
  private get envScript(): string | undefined {
    const configured = this.option<string>("envScript") ?? this.spawnEnv().CLAUDE_ENV_SCRIPT;
    return configured?.trim() ? configured : undefined;
  }

  /** `options.backendEnv` first (bundled credentials from the operator's environment), then the process env. */
  private spawnEnv(): NodeJS.ProcessEnv {
    return this.deps.env ?? process.env;
  }

  /** Where the runner will look for the backend when no script is configured. */
  private get neutralEnvPath(): string {
    return path.join(os.homedir(), ".config/multimodel-broker/claude-code.env");
  }

  /**
   * Absolute path to the Claude Code CLI. Optional: without it the runner asks the user's login shell
   * where `claude` is. Pinning it in config is the reliable choice, because a service manager's PATH
   * usually does not contain the directory the CLI was installed into.
   */
  private get claudeBinary(): string | undefined {
    return this.option<string>("claudeBinary");
  }

  async healthCheck(): Promise<ProviderHealth> {
    const checkedAt = new Date().toISOString();
    let runner: string;
    let mode: string;
    let model: string;
    try {
      runner = this.runnerPath;
      mode = this.permissionMode;
      model = this.model;
    } catch (error) {
      return { healthy: false, checkedAt, reason: toBrokerError(error, "CONFIG_ERROR").message };
    }
    const exists = this.deps.fileExists ?? (async (target: string) => { try { await access(target); return true; } catch { return false; } });
    const env = this.spawnEnv();
    const script = this.envScript;
    const [runnerPresent, scriptPresent, neutralPresent] = await Promise.all([
      exists(runner),
      script ? exists(script) : Promise.resolve(false),
      exists(this.neutralEnvPath),
    ]);
    const fromEnv = Boolean(env.ANTHROPIC_BASE_URL && env.ANTHROPIC_AUTH_TOKEN);
    const backend = scriptPresent ? script : fromEnv ? "process environment" : neutralPresent ? this.neutralEnvPath : undefined;
    const reason = !runnerPresent
      ? `runner not found at ${runner}`
      : !backend
        ? `no backend credentials: set options.envScript or $CLAUDE_ENV_SCRIPT, create ${this.neutralEnvPath}, or export ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN`
        : undefined;
    return {
      healthy: runnerPresent && Boolean(backend),
      checkedAt,
      reason,
      details: {
        runner,
        envScript: script ?? "(auto: " + this.neutralEnvPath + " or the process environment)",
        backend: backend ?? "missing",
        model,
        permissionMode: mode,
        defaultCwd: this.defaultCwd ?? "(caller must pass a workspace)",
        node: this.nodeBinary,
        claudeBinary: this.claudeBinary ?? "(resolved by the runner from the user's login shell)",
      },
    };
  }

  /** Serialize runs that share a working directory; different directories still run in parallel. */
  private enqueue<T>(dir: string, task: () => Promise<T>): Promise<T> {
    const previous = this.dirQueue.get(dir) ?? Promise.resolve();
    const next = previous.then(task, task);
    this.dirQueue.set(dir, next.catch(() => undefined));
    return next;
  }

  private async executeRunner(cwd: string, prompt: string, model: string, timeoutMs: number, signal: AbortSignal): Promise<ClaudeCodeSummary> {
    const args = [
      this.runnerPath,
      "--prompt", prompt,
      "--cwd", cwd,
      "--model", model,
      "--permission-mode", this.permissionMode,
      "--timeout-ms", String(timeoutMs),
    ];
    if (this.claudeBinary) args.push("--claude-bin", this.claudeBinary);
    const envScript = this.envScript;
    if (envScript) args.push("--env-script", envScript);
    const exec = this.deps.exec ?? ((argv: string[], options: { cwd: string; signal: AbortSignal; env: NodeJS.ProcessEnv }) =>
      new Promise<ClaudeCodeExecResult>((resolve, reject) => {
        const child = spawn(this.nodeBinary, argv, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
        child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
        const onAbort = () => child.kill("SIGKILL");
        options.signal.addEventListener("abort", onAbort, { once: true });
        child.on("error", (error) => reject(error));
        child.on("close", (code) => {
          options.signal.removeEventListener("abort", onAbort);
          resolve({ code, stdout, stderr });
        });
      }));

    const outcome = await exec(args, { cwd, signal, env: this.spawnEnv() });
    if (signal.aborted) throw signal.reason ?? new BrokerError("CANCELLED", "Claude Code run cancelled", { retryable: false });
    const summary = parseSummary(outcome.stdout);
    if (!summary) {
      throw new BrokerError("PROVIDER_BAD_RESPONSE", `${this.id}: runner produced no parseable summary (exit ${outcome.code}): ${outcome.stderr.slice(-300)}`, { retryable: false });
    }
    return summary;
  }

  async run(request: WorkerRequest, signal: AbortSignal): Promise<WorkerResult> {
    const cwd = request.workspace ?? this.defaultCwd;
    if (!cwd) {
      throw new BrokerError("INVALID_INPUT", `${this.id}: a workspace (working directory) is required; set providers.${this.id}.options.defaultCwd to give it a fallback`);
    }
    const model = request.model?.trim() && request.model !== "auto" ? request.model : this.model;
    const startedAt = new Date().toISOString();
    request.emit?.("provider.request", {
      provider: this.id,
      cwd,
      model,
      permissionMode: this.permissionMode,
      runner: this.runnerPath,
      startedAt,
    });

    const summary = await this.enqueue(cwd, () => this.executeRunner(cwd, this.prompt(request), model, request.timeoutMs, signal));

    for (const file of summary.files_touched ?? []) {
      request.emit?.("tool.event", { provider: this.id, itemType: "file_change", path: file.path, tool: file.tool });
    }
    for (const command of summary.commands ?? []) {
      request.emit?.("tool.event", { provider: this.id, itemType: "command_execution", command });
    }

    // An impossible usage pair is recorded rather than swallowed: see the runner's usage_note.
    const usageNote = (summary as { usage_note?: string }).usage_note;

    const usage: WorkerResult["usage"] = {
      inputTokens: summary.usage?.input_tokens,
      outputTokens: summary.usage?.output_tokens,
      cacheHitTokens: summary.usage?.cache_read_input_tokens,
      // Real (DeepSeek-priced) estimate; the Anthropic-priced self-report travels in the summary only.
      cost: summary.cost_estimate_usd,
    };

    if (summary.status === "timeout") {
      throw new BrokerError("TIMEOUT", `${this.id}: Claude Code run exceeded its deadline`, { retryable: false });
    }
    if (summary.status !== "ok") {
      // The runner reports its own startup failures (e.g. the CLI binary is not where the service's
      // PATH says it should be); surface that reason instead of a generic exit code.
      const detail = summary.error ?? summary.stderr_tail;
      throw new BrokerError(
        "PROVIDER_ERROR",
        `${this.id}: Claude Code run failed (exit ${summary.exit_code ?? "?"})${detail ? `: ${detail}` : ""}`,
      );
    }

    const files = summary.files_touched ?? [];
    const audit = [
      `model=${(summary.models ?? []).join(",") || model}`,
      `mode=${summary.permission_mode ?? this.permissionMode}`,
      `turns=${summary.num_turns ?? "?"}`,
      `cost_est=$${(summary.cost_estimate_usd ?? 0).toFixed(5)}`,
      `files=${files.length}`,
      `commands=${(summary.commands ?? []).length}`,
      `denied=${(summary.permission_denials ?? []).length}`,
      // Recorded, not swallowed: an inconsistent usage pair from the harness (see the runner).
      ...(usageNote ? [`usage_note="${usageNote}"`] : []),
    ].join(" ");

    return {
      taskId: request.taskId,
      runId: request.runId,
      provider: this.id,
      model,
      status: "completed",
      answer: summary.result ?? "",
      summary: audit,
      sessionId: summary.session_id,
      usage,
      evidence: [
        ...files.map((file) => ({ type: "file_touched", content: file.path, source: file.tool })),
        ...(summary.commands ?? []).map((command) => ({ type: "command", content: command })),
      ],
      artifacts: files.map((file) => ({ name: path.basename(file.path), path: file.path })),
      traceId: "",
    };
  }

  private prompt(request: WorkerRequest): string {
    return request.context ? `${request.task}\n\nContext provided by the caller:\n${request.context}` : request.task;
  }
}

/**
 * The runner prints human-readable progress on stderr and exactly one JSON summary on stdout.
 * Parse the LAST parseable line so any stray output cannot turn a good run into a failure.
 */
export function parseSummary(stdout: string): ClaudeCodeSummary | undefined {
  const lines = stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    if (!line.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line) as ClaudeCodeSummary;
      if (parsed && typeof parsed === "object" && typeof parsed.status === "string") return parsed;
    } catch {
      // not the summary line; keep looking
    }
  }
  return undefined;
}
