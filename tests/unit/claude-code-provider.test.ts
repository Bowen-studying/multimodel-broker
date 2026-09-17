import { describe, expect, it } from "vitest";
import { ClaudeCodeProvider, parseSummary } from "../../src/providers/claude-code/index.js";
import type { ProviderConfig, WorkerRequest } from "../../src/core/types.js";
import type { ClaudeCodeExecResult } from "../../src/providers/claude-code/index.js";

const SIGNAL = new AbortController().signal;

function config(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    enabled: true,
    adapter: "claude-code",
    model: "deepseek-flash",
    maxConcurrency: 2,
    defaultTimeoutMs: 60_000,
    options: { runnerPath: "/fake/claude_code_run.mjs", permissionMode: "auto", defaultCwd: "/tmp/scratch" },
    ...overrides,
  } as ProviderConfig;
}

function summary(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    status: "ok",
    exit_code: 0,
    model_requested: "deepseek-flash",
    models: ["deepseek-flash"],
    permission_mode: "auto",
    cwd: "/tmp/scratch",
    result: "done",
    usage: { input_tokens: 24330, cache_read_input_tokens: 24000, cache_creation_input_tokens: 0, output_tokens: 2 },
    cost_estimate_usd: 0.003,
    cost_reported_usd: 0.12,
    duration_ms: 9000,
    num_turns: 4,
    files_touched: [{ path: "/tmp/scratch/a.txt", tool: "Write" }],
    commands: ["npm test"],
    permission_denials: [],
    session_id: "sess-1",
    ...over,
  });
}

function request(over: Partial<WorkerRequest> = {}): WorkerRequest {
  return { taskId: "t1", runId: "r1", task: "do the thing", timeoutMs: 30_000, traceLevel: "summary", ...over };
}

function execReturning(lines: string[], code = 0): ClaudeCodeExecResult {
  return { code, stdout: `${lines.join("\n")}\n`, stderr: "progress noise" };
}

describe("claude-code provider: result mapping", () => {
  it("maps the runner summary into a WorkerResult with the DeepSeek-priced cost", async () => {
    const provider = new ClaudeCodeProvider("claude-code", config(), { exec: async () => execReturning([summary()]) });
    const result = await provider.run(request({ workspace: "/tmp/scratch" }), SIGNAL);

    expect(result).toMatchObject({ status: "completed", provider: "claude-code", model: "deepseek-flash", answer: "done", sessionId: "sess-1" });
    // The bill is the token-based DeepSeek estimate, NOT Claude Code's Anthropic-priced self-report.
    expect(result.usage).toMatchObject({ inputTokens: 24330, outputTokens: 2, cacheHitTokens: 24000, cost: 0.003 });
    expect(result.summary).toContain("cost_est=$0.00300");
    expect(result.evidence).toEqual([
      { type: "file_touched", content: "/tmp/scratch/a.txt", source: "Write" },
      { type: "command", content: "npm test" },
    ]);
    expect(result.artifacts).toEqual([{ name: "a.txt", path: "/tmp/scratch/a.txt" }]);
  });

  it("passes task + context as one prompt and honours per-run model and timeout", async () => {
    const seen: Array<{ args: string[] }> = [];
    const provider = new ClaudeCodeProvider("claude-code", config(), {
      exec: async (args) => {
        seen.push({ args });
        return execReturning([summary()]);
      },
    });
    await provider.run(request({ workspace: "/tmp/scratch", context: "extra detail", model: "deepseek-v4-pro", timeoutMs: 120_000 }), SIGNAL);

    const args = seen[0]!.args;
    expect(args).toContain("/fake/claude_code_run.mjs");
    expect(args[args.indexOf("--model") + 1]).toBe("deepseek-v4-pro");
    expect(args[args.indexOf("--timeout-ms") + 1]).toBe("120000");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("auto");
    expect(args[args.indexOf("--cwd") + 1]).toBe("/tmp/scratch");
    expect(args[args.indexOf("--prompt") + 1]).toContain("extra detail");
  });

  it("passes the pinned CLI path and surfaces the runner's own startup error", async () => {
    const seen: string[][] = [];
    const withBin = new ClaudeCodeProvider("claude-code", config({ options: { runnerPath: "/fake/run.mjs", claudeBinary: "/opt/claude/bin/claude" } }), {
      exec: async (args) => {
        seen.push(args);
        return execReturning([summary()]);
      },
    });
    await withBin.run(request({ workspace: "/tmp/scratch" }), SIGNAL);
    expect(seen[0]![seen[0]!.indexOf("--claude-bin") + 1]).toBe("/opt/claude/bin/claude");

    // When the CLI itself cannot start, the runner says why - that reason must reach the caller.
    const broken = new ClaudeCodeProvider("claude-code", config(), {
      exec: async () => execReturning([JSON.stringify({ status: "error", error: "cannot run /opt/nope/claude: ENOENT", exit_code: null })], 3),
    });
    await expect(broken.run(request({ workspace: "/tmp/scratch" }), SIGNAL)).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
      message: expect.stringContaining("cannot run /opt/nope/claude"),
    });
  });

  it("falls back to the configured model when the caller says 'auto'", async () => {
    const provider = new ClaudeCodeProvider("claude-code", config(), { exec: async () => execReturning([summary()]) });
    const result = await provider.run(request({ workspace: "/tmp/scratch", model: "auto" }), SIGNAL);
    expect(result.model).toBe("deepseek-flash");
  });

  it("emits trace events for files and commands", async () => {
    const events: string[] = [];
    const provider = new ClaudeCodeProvider("claude-code", config(), { exec: async () => execReturning([summary()]) });
    await provider.run(request({ workspace: "/tmp/scratch", emit: (type) => events.push(type) }), SIGNAL);
    expect(events).toEqual(["provider.request", "tool.event", "tool.event"]);
  });
});

describe("claude-code provider: failures", () => {
  it("turns a runner timeout into a TIMEOUT BrokerError", async () => {
    const provider = new ClaudeCodeProvider("claude-code", config(), { exec: async () => execReturning([summary({ status: "timeout" })]) });
    await expect(provider.run(request({ workspace: "/tmp/scratch" }), SIGNAL)).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  it("turns a non-zero exit into PROVIDER_ERROR and never fakes success", async () => {
    const provider = new ClaudeCodeProvider("claude-code", config(), {
      exec: async () => execReturning([summary({ status: "error", exit_code: 1, stderr_tail: "boom" })], 1),
    });
    await expect(provider.run(request({ workspace: "/tmp/scratch" }), SIGNAL)).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
  });

  it("refuses to report success when the runner printed no parseable summary", async () => {
    const provider = new ClaudeCodeProvider("claude-code", config(), { exec: async () => execReturning(["just noise"], 0) });
    await expect(provider.run(request({ workspace: "/tmp/scratch" }), SIGNAL)).rejects.toMatchObject({ code: "PROVIDER_BAD_RESPONSE" });
  });

  it("requires a working directory when no default is configured", async () => {
    const provider = new ClaudeCodeProvider("claude-code", config({ options: { runnerPath: "/fake/run.mjs" } }), { exec: async () => execReturning([summary()]) });
    await expect(provider.run(request(), SIGNAL)).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("runs the runner with the broker's own node, so a minimal PATH cannot break it", async () => {
    const provider = new ClaudeCodeProvider("claude-code", config(), { fileExists: async () => true });
    const health = await provider.healthCheck();
    // "node" is not on PATH under systemd; process.execPath always is.
    expect(health.details?.node).toBe(process.execPath);
    const pinned = new ClaudeCodeProvider("claude-code", config({ options: { runnerPath: "/fake/run.mjs", nodeBinary: "/opt/node/bin/node" } }), {});
    expect((await pinned.healthCheck()).details?.node).toBe("/opt/node/bin/node");

    // A configured env script is passed to the runner explicitly, so the child never has to guess.
    const seen: string[][] = [];
    const withScript = new ClaudeCodeProvider("claude-code", config({ options: { runnerPath: "/fake/run.mjs", envScript: "/etc/backend.env" } }), {
      exec: async (args) => {
        seen.push(args);
        return execReturning([summary()]);
      },
    });
    await withScript.run(request({ workspace: "/tmp/scratch" }), SIGNAL);
    expect(seen[0]![seen[0]!.indexOf("--env-script") + 1]).toBe("/etc/backend.env");
  });

  it("reports itself unhealthy when the runner is missing or no backend is configured", async () => {
    const provider = new ClaudeCodeProvider(
      "claude-code",
      config({ options: { runnerPath: "/fake/claude_code_run.mjs", envScript: "/fake/missing_env.sh" } }),
      { fileExists: async (target: string) => target.includes("claude_code_run"), env: {} },
    );
    const health = await provider.healthCheck();
    expect(health.healthy).toBe(false);
    expect(health.reason).toContain("no backend credentials");
    expect(health.details).toMatchObject({ model: "deepseek-flash", permissionMode: "auto", backend: "missing" });
  });

  it("needs no personal env script: exported variables are a complete setup", async () => {
    // The public build must not assume any particular dotfile layout: a plain export has to work.
    const provider = new ClaudeCodeProvider("claude-code", config({ options: { runnerPath: "/fake/runner.mjs" } }), {
      fileExists: async (target: string) => target.endsWith("runner.mjs"),
      env: { ANTHROPIC_BASE_URL: "https://example.invalid/anthropic", ANTHROPIC_AUTH_TOKEN: "irrelevant-for-this-check" },
    });
    const health = await provider.healthCheck();
    expect(health.healthy).toBe(true);
    expect(health.details?.backend).toBe("process environment");
    expect(health.details?.envScript).toContain("auto:");

    // ... and an explicitly configured script still wins over both fallbacks.
    const scripted = new ClaudeCodeProvider(
      "claude-code",
      config({ options: { runnerPath: "/fake/runner.mjs", envScript: "/etc/my-backend.env" } }),
      { fileExists: async () => true, env: {} },
    );
    expect((await scripted.healthCheck()).details?.backend).toBe("/etc/my-backend.env");
  });

  it("refuses bypassPermissions unless the operator opted in", async () => {
    const provider = new ClaudeCodeProvider("claude-code", config({ options: { runnerPath: "/fake/run.mjs", permissionMode: "bypassPermissions" } }));
    await expect(provider.run(request({ workspace: "/tmp/scratch" }), SIGNAL)).rejects.toMatchObject({ code: "CONFIG_ERROR" });
    const allowed = new ClaudeCodeProvider("claude-code", config({ options: { runnerPath: "/fake/run.mjs", permissionMode: "bypassPermissions", allowBypassPermissions: true } }), {
      exec: async () => execReturning([summary({ permission_mode: "bypassPermissions" })]),
    });
    await expect(allowed.run(request({ workspace: "/tmp/scratch" }), SIGNAL)).resolves.toMatchObject({ status: "completed" });
  });
});

describe("claude-code provider: concurrency", () => {
  it("serializes runs that share a working directory but overlaps different ones", async () => {
    const log: string[] = [];
    const provider = new ClaudeCodeProvider("claude-code", config({ options: { runnerPath: "/fake/run.mjs", defaultCwd: "/tmp/a" } }), {
      exec: async (_args, options) => {
        const dir = options.cwd;
        log.push(`start:${dir}`);
        await new Promise((resolve) => setTimeout(resolve, dir === "/tmp/a" ? 40 : 10));
        log.push(`end:${dir}`);
        return execReturning([summary()]);
      },
    });
    await Promise.all([
      provider.run(request({ taskId: "a1", runId: "a1", workspace: "/tmp/a" }), SIGNAL),
      provider.run(request({ taskId: "a2", runId: "a2", workspace: "/tmp/a" }), SIGNAL),
      provider.run(request({ taskId: "b1", runId: "b1", workspace: "/tmp/b" }), SIGNAL),
    ]);

    // Same directory: strictly sequential, no interleaving.
    expect(log.filter((entry) => entry.includes("/tmp/a"))).toEqual(["start:/tmp/a", "end:/tmp/a", "start:/tmp/a", "end:/tmp/a"]);
    // A different directory is not blocked by the queue in front of it.
    expect(log.indexOf("start:/tmp/b")).toBeLessThan(log.lastIndexOf("end:/tmp/a"));
  });
});

describe("parseSummary", () => {
  it("takes the last JSON line and ignores noise around it", () => {
    const text = ['{"status":"ok","result":"first"}', "warning: something", '{"status":"ok","result":"second"}', ""].join("\n");
    expect(parseSummary(text)?.result).toBe("second");
  });

  it("returns undefined rather than throwing on unparseable output", () => {
    expect(parseSummary("not json at all")).toBeUndefined();
    expect(parseSummary('{"nope":1}')).toBeUndefined();
  });
});
