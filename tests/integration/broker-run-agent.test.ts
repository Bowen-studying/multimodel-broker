/**
 * `run_agent` is the only tool that drives a real local agent, so its worker gate is what decides
 * which local runtimes a caller may reach. It is config-driven: any enabled `codex-sdk` provider
 * qualifies (the bundled `codex`, plus `codex-win` when configured), and nothing else does - in
 * particular the API workers (`deepseek`/`glm`) must never be reachable through it.
 *
 * A fake SDK is injected here so no real Codex build is ever spawned.
 */
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { ProviderConfig } from "../../src/core/types.js";
import { RunAgentSchema } from "../../src/interfaces/mcp/schemas.js";
import { CodexProvider, type CodexSdkModule, type CodexSdkOptions, type CodexThreadOptionsLike } from "../../src/providers/codex/index.js";
import { ClaudeCodeProvider } from "../../src/providers/claude-code/index.js";
import { ProviderRegistry } from "../../src/providers/provider.js";
import { createHarness } from "../fixtures/harness.js";

function fakeSdk() {
  const calls = { sdkOptions: [] as CodexSdkOptions[], workingDirectories: [] as string[] };
  const makeThread = (id: string) => ({
    id,
    async run() {
      return { items: [], finalResponse: "done", usage: null };
    },
    async runStreamed() {
      return {
        events: (async function* () {
          yield { type: "item.completed", item: { type: "agent_message", id: "m1", text: "done" } };
          yield { type: "turn.completed", usage: { input_tokens: 3, output_tokens: 1, cached_input_tokens: 0 } };
        })(),
      };
    },
  });
  const module = {
    Codex: class {
      constructor(options?: CodexSdkOptions) {
        if (options) calls.sdkOptions.push(options);
      }
      startThread(threadOptions?: CodexThreadOptionsLike) {
        if (threadOptions?.workingDirectory) calls.workingDirectories.push(threadOptions.workingDirectory);
        return makeThread("thread-1");
      }
      resumeThread(id: string) {
        return makeThread(id);
      }
    },
  } as unknown as CodexSdkModule;
  return { module, calls };
}

const providerConfig = (over: Partial<ProviderConfig> = {}): ProviderConfig => ({
  enabled: true,
  adapter: "codex-sdk",
  model: "auto",
  authMode: "codex-local",
  maxConcurrency: 1,
  defaultTimeoutMs: 5000,
  sandbox: "read-only",
  options: { requireWorkspace: true },
  ...over,
});

async function harnessWith(providers: Record<string, ProviderConfig>, registry?: ProviderRegistry) {
  return createHarness({ providers, registry, workspaces: { scratch: tmpdir() } });
}

describe("run_agent worker gate", () => {
  it("refuses an API worker: run_agent is not a way to reach deepseek/glm", async () => {
    const harness = await harnessWith({
      codex: providerConfig(),
      deepseek: { enabled: true, adapter: "openai-compatible", maxConcurrency: 1, defaultTimeoutMs: 5000, baseUrl: "http://127.0.0.1:1", apiKeyEnv: "NOPE" },
    });
    // The gate rejects before any work starts, so it throws synchronously - assert that shape,
    // otherwise a caller that forgets `await` would see an unhandled throw instead of an envelope.
    await expect(harness.broker.runAgent({ worker: "deepseek", workspace: "scratch", task: "hi" })).rejects.toThrowError(
      expect.objectContaining({ code: "INVALID_INPUT", message: expect.stringContaining("write-capable worker") }),
    );
  });

  it("refuses a local-agent worker that is configured but disabled", async () => {
    const harness = await harnessWith({ codex: providerConfig(), "codex-win": providerConfig({ enabled: false }) });
    await expect(harness.broker.runAgent({ worker: "codex-win", workspace: "scratch", task: "hi" })).rejects.toThrowError(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
  });

  it("accepts a second codex-sdk worker and runs it with the configured build", async () => {
    const { module, calls } = fakeSdk();
    const config = providerConfig({
      options: { requireWorkspace: true, codexPath: "C:\\Users\\x\\codex.exe", windowsPaths: true },
    });
    const registry = new ProviderRegistry();
    registry.register("codex-win", new CodexProvider("codex-win", config, { loadSdk: async () => module, authFileExists: async () => true }), config);

    const harness = await harnessWith({ codex: providerConfig(), "codex-win": config }, registry);
    const outcome = await harness.broker
      .runAgent({ worker: "codex-win", workspace: "scratch", task: "hi", waitMs: 1000 })
      .catch((error: { code?: string }) => error);

    expect((outcome as { code?: string }).code).not.toBe("INVALID_INPUT");
    expect(calls.sdkOptions[0]).toMatchObject({ codexPathOverride: "C:\\Users\\x\\codex.exe" });
    // Only a `/mnt/<drive>/...` workspace is rewritten; a plain path is passed through untouched.
    expect(calls.workingDirectories[0]).toBe(tmpdir());
  });

});

/**
 * `run_agent` is the only write-capable tool, and its worker gate is what decides which local
 * runtimes a caller may reach. It is config-driven: any enabled worker whose adapter is
 * write-capable qualifies - the bundled `codex`, `codex-win`, and `claude-code` (local Claude Code
 * on its own backend). Everything else is refused, in particular the API workers.
 */
describe("run_agent worker gate", () => {
  const claudeConfig = (over: Partial<ProviderConfig> = {}): ProviderConfig => ({
    enabled: true,
    adapter: "claude-code",
    model: "deepseek-flash",
    maxConcurrency: 2,
    defaultTimeoutMs: 60_000,
    options: { runnerPath: "/fake/claude_code_run.mjs", permissionMode: "auto" },
    ...over,
  }) as ProviderConfig;

  it("refuses an API worker: run_agent is not a way to reach deepseek", async () => {
    const harness = await harnessWith({ deepseek: { enabled: true, adapter: "openai-compatible", maxConcurrency: 1, defaultTimeoutMs: 5000, baseUrl: "http://127.0.0.1:1", apiKeyEnv: "NOPE" } });
    // The gate rejects before any work starts, so it throws synchronously - assert that shape,
    // otherwise a caller that forgets `await` would see an unhandled throw instead of an envelope.
    await expect(harness.broker.runAgent({ worker: "deepseek", workspace: "scratch", task: "hi" })).rejects.toThrowError(
      expect.objectContaining({ code: "INVALID_INPUT", message: expect.stringContaining("write-capable worker") }),
    );
    // An id that does not exist is refused the same way: a caller cannot invent a worker.
    await expect(harness.broker.runAgent({ worker: "claude-code-x", workspace: "scratch", task: "hi" })).rejects.toThrowError(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
  });

  it("requires a workspace: a write-capable agent has to start somewhere", async () => {
    const harness = await harnessWith({ "claude-code": claudeConfig() });
    await expect(harness.broker.runAgent({ worker: "claude-code", task: "hi" })).rejects.toThrowError(
      expect.objectContaining({ code: "INVALID_INPUT", message: expect.stringContaining("workspace") }),
    );
  });

  it("drives the local Claude Code worker and reports files, commands and the DeepSeek-priced cost", async () => {
    const cfg = claudeConfig();
    const registry = new ProviderRegistry();
    const stdout = JSON.stringify({
      status: "ok",
      exit_code: 0,
      models: ["deepseek-flash"],
      permission_mode: "auto",
      result: "edited the file",
      usage: { input_tokens: 24330, cache_read_input_tokens: 24000, output_tokens: 2 },
      cost_estimate_usd: 0.003,
      cost_reported_usd: 0.12,
      num_turns: 4,
      files_touched: [{ path: "/tmp/scratch/t.txt", tool: "Write" }],
      commands: ["echo hi"],
      session_id: "sess-gate",
    });
    registry.register("claude-code", new ClaudeCodeProvider("claude-code", cfg, { exec: async () => ({ code: 0, stdout: `${stdout}\n`, stderr: "" }) }), cfg);

    const harness = await harnessWith({ "claude-code": cfg }, registry);
    const envelope = await harness.broker.runAgent({ worker: "claude-code", workspace: "scratch", task: "add a file", waitMs: 5000 });
    expect(envelope.ok).toBe(true);
    expect(envelope.status).toBe("completed");
    const data = envelope.data as unknown as {
      selectedWorker: string;
      result?: { status?: string; answer?: string; usage?: { cost?: number }; evidence?: unknown[] };
    };
    expect(data.selectedWorker).toBe("claude-code");
    expect(data.result?.status).toBe("completed");
    expect(data.result?.answer).toBe("edited the file");
    expect(data.result?.usage?.cost).toBe(0.003);
    expect(data.result?.evidence).toHaveLength(2);
  });

  it("closes the read-only back door: run_worker cannot reach a writing worker", async () => {
    const harness = await harnessWith({ "claude-code": claudeConfig(), codex: providerConfig() });
    // The refusal happens when the task runs, so the caller sees a failed envelope - assert the
    // outcome, not a particular throw site. Both write-capable workers point at the same tool now.
    const viaWorker = await harness.broker.runWorker({ worker: "claude-code", workspace: "scratch", task: "hi", waitMs: 2000 });
    expect(viaWorker.ok).toBe(false);
    expect(JSON.stringify(viaWorker)).toMatch(/INVALID_INPUT/);
    expect(JSON.stringify(viaWorker)).toMatch(/run_agent/);

    const viaCodex = await harness.broker.runWorker({ worker: "codex", workspace: "scratch", task: "hi", waitMs: 2000 });
    expect(viaCodex.ok).toBe(false);
    expect(JSON.stringify(viaCodex)).toMatch(/run_agent/);

    // delegate() may not route to one either, even when a caller names it explicitly.
    const delegated = await harness.broker.delegate({ task: "hi", worker: "claude-code", waitMs: 2000 });
    expect(delegated.ok).toBe(false);
    expect(JSON.stringify(delegated)).toMatch(/INVALID_INPUT/);

    // The honest door still works: run_agent is not blocked by this guard.
    const registry = new ProviderRegistry();
    const cfg = claudeConfig();
    registry.register(
      "claude-code",
      new ClaudeCodeProvider("claude-code", cfg, { exec: async () => ({ code: 0, stdout: `${JSON.stringify({ status: "ok", result: "ok" })}\n`, stderr: "" }) }),
      cfg,
    );
    const honest = await harnessWith({ "claude-code": cfg, codex: providerConfig() }, registry);
    const allowed = await honest.broker.runAgent({ worker: "claude-code", workspace: "scratch", task: "hi", waitMs: 2000 });
    expect(allowed.ok).toBe(true);
  });

  it("keeps the tool schema honest: three workers, plain model ids, nothing else", () => {
    for (const worker of ["codex", "codex-win", "claude-code"]) {
      expect(RunAgentSchema.parse({ task: "x", worker }).worker).toBe(worker);
    }
    // No default worker is injected: omitting it just means "reuse what I chose before", and the
    // broker refuses the call when nothing was ever chosen.
    expect(RunAgentSchema.parse({ task: "x" }).worker).toBeUndefined();
    expect(RunAgentSchema.safeParse({ task: "x", worker: "deepseek" }).success).toBe(false);
    expect(RunAgentSchema.safeParse({ task: "x", worker: "claude-code-x" }).success).toBe(false);
    // A model id is a plain identifier; anything option-like or shell-ish is refused up front.
    expect(RunAgentSchema.parse({ task: "x", worker: "codex", model: " gpt-5.6-luna " }).model).toBe("gpt-5.6-luna");
    // A caller may name any model its own backend serves; the broker does not validate vendor lists.
    expect(RunAgentSchema.parse({ task: "x", worker: "claude-code", model: " some-backend-model " }).model).toBe("some-backend-model");
    for (const bad of ["--sandbox danger-full-access", "a;rm -rf /", "x".repeat(65)]) {
      expect(RunAgentSchema.safeParse({ task: "x", model: bad }).success).toBe(false);
    }
  });
});
