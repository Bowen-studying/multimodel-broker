import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { CodexProvider, type CodexEventLike, type CodexSdkModule, type CodexSdkOptions, type CodexThreadOptionsLike } from "../../src/providers/codex/index.js";
import type { ProviderConfig, WorkerRequest } from "../../src/core/types.js";
import { createHarness } from "../fixtures/harness.js";
import { ProviderRegistry } from "../../src/providers/provider.js";

/**
 * Codex adapter tests against a FAKE SDK module. The real codex binary and the
 * network are never touched here; the orchestrator exercises the real thing with
 * `node scripts/smoke.mjs` when a Codex login is available.
 */
interface FakeRun {
  finalResponse: string;
  usage?: Record<string, number> | null;
  events?: CodexEventLike[];
  fail?: string;
}

function makeFakeSdk(options: { runs: FakeRun[]; hang?: boolean }) {
  const calls = { start: 0, resume: 0, resumeIds: [] as string[], threadOptions: [] as CodexThreadOptionsLike[], inputs: [] as string[], sdkOptions: [] as Record<string, unknown>[] };
  let index = 0;

  const makeThread = (id: string) => ({
    id,
    async run(input: string, runOptions?: { signal?: AbortSignal }) {
      calls.inputs.push(input);
      if (options.hang) {
        await new Promise((_resolve, reject) => {
          runOptions?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
        });
      }
      const run = options.runs[index++] ?? { finalResponse: "" };
      if (run.fail) throw new Error(run.fail);
      return { items: [], finalResponse: run.finalResponse, usage: run.usage ?? null };
    },
    async runStreamed(input: string, runOptions?: { signal?: AbortSignal }) {
      calls.inputs.push(input);
      if (options.hang) {
        await new Promise((_resolve, reject) => {
          runOptions?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
        });
      }
      const run = options.runs[index++] ?? { finalResponse: "" };
      const events = (async function* () {
        // A scenario that only scripts `finalResponse` still produces a realistic stream:
        // the adapter now always streams, because tool events are the audit trail of a write.
        const scripted: CodexEventLike[] =
          run.events ??
          [
            { type: "item.completed", item: { type: "agent_message", id: "m1", text: run.finalResponse } },
            { type: "turn.completed", usage: run.usage ?? null },
          ];
        for (const event of scripted) {
          if (runOptions?.signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
          yield event;
        }
        if (run.fail) throw new Error(run.fail);
      })();
      return { events };
    },
  });

  const module = {
    Codex: class {
      constructor(sdkOptions?: CodexSdkOptions) {
        if (sdkOptions) calls.sdkOptions.push(sdkOptions);
      }
      startThread(threadOptions?: CodexThreadOptionsLike) {
        calls.start++;
        if (threadOptions) calls.threadOptions.push(threadOptions);
        return makeThread("thread-123");
      }
      resumeThread(id: string, threadOptions?: CodexThreadOptionsLike) {
        calls.resume++;
        calls.resumeIds.push(id);
        if (threadOptions) calls.threadOptions.push(threadOptions);
        return makeThread(id);
      }
    },
  } as unknown as CodexSdkModule;

  return { module, calls };
}

const config: ProviderConfig = { enabled: true, adapter: "codex-sdk", model: "auto", authMode: "codex-local", maxConcurrency: 1, defaultTimeoutMs: 5000, sandbox: "read-only" };
const request = (overrides: Partial<WorkerRequest> = {}): WorkerRequest => ({ taskId: "t1", runId: "r1", task: "explain the failure", timeoutMs: 5000, traceLevel: "summary", workspace: "/tmp/ws", ...overrides });

/** The structural seam lets a fake SDK be injected without importing the real one. */
function providerWith(sdk: CodexSdkModule | undefined, extraConfig: Partial<ProviderConfig> = {}) {
  return new CodexProvider("codex", { ...config, ...extraConfig }, { loadSdk: async () => sdk, authFileExists: async () => true });
}

describe("CodexProvider", () => {
  it("starts a read-only thread in the allowlisted workspace with approvals disabled", async () => {
    const { module, calls } = makeFakeSdk({ runs: [{ finalResponse: "done", usage: { input_tokens: 12, cached_input_tokens: 4, output_tokens: 7 } }] });
    const provider = providerWith(module);
    const result = await provider.run(request(), new AbortController().signal);

    expect(calls.threadOptions[0]).toMatchObject({ sandboxMode: "read-only", workingDirectory: "/tmp/ws", approvalPolicy: "never", skipGitRepoCheck: false });
    // `model: "auto"` means "let Codex choose", so no model id is sent.
    expect(calls.threadOptions[0]!.model).toBeUndefined();
    expect(result).toMatchObject({ provider: "codex", status: "completed", answer: "done", sessionId: "thread-123" });
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 7, cacheHitTokens: 4 });
  });

  it("requires an allowlisted workspace by default", async () => {
    const { module } = makeFakeSdk({ runs: [{ finalResponse: "done" }, { finalResponse: "done" }] });
    await expect(providerWith(module).run(request({ workspace: undefined }), new AbortController().signal)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    const relaxed = providerWith(module, { options: { requireWorkspace: false } });
    await expect(relaxed.run(request({ workspace: undefined }), new AbortController().signal)).resolves.toMatchObject({ status: "completed" });
  });

  it("refuses a writable sandbox unless it is explicitly allowed, and never accepts on-request approvals", async () => {
    const { module } = makeFakeSdk({ runs: [{ finalResponse: "done" }] });
    await expect(providerWith(module, { sandbox: "workspace-write" }).run(request(), new AbortController().signal)).rejects.toMatchObject({ code: "CONFIG_ERROR" });
    await expect(providerWith(module, { options: { approvalPolicy: "on-request" } }).run(request(), new AbortController().signal)).rejects.toMatchObject({ code: "CONFIG_ERROR" });
  });

  it("resumes an existing thread when given a session id", async () => {
    const { module, calls } = makeFakeSdk({ runs: [{ finalResponse: "resumed" }] });
    const provider = providerWith(module);
    const resumed = await provider.resume!("thread-abc", request(), new AbortController().signal);
    expect(calls.resume).toBe(1);
    expect(calls.resumeIds).toEqual(["thread-abc"]);
    expect(resumed.answer).toBe("resumed");
    expect(resumed.sessionId).toBe("thread-abc");
  });

  it("propagates an abort instead of hanging", async () => {
    const { module } = makeFakeSdk({ runs: [], hang: true });
    const provider = providerWith(module);
    const controller = new AbortController();
    const pending = provider.run(request(), controller.signal);
    setTimeout(() => controller.abort(Object.assign(new Error("deadline"), { name: "AbortError" })), 20);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("reports a missing SDK as unavailable instead of crashing, and reports auth as a boolean", async () => {
    const unavailable = providerWith(undefined);
    expect(await unavailable.healthCheck()).toMatchObject({ healthy: false, reason: "codex sdk not installed" });
    await expect(unavailable.run(request(), new AbortController().signal)).rejects.toMatchObject({ code: "PROVIDER_NOT_IMPLEMENTED" });

    const { module } = makeFakeSdk({ runs: [{ finalResponse: "done" }] });
    expect(await providerWith(module).healthCheck()).toMatchObject({
      healthy: true,
      details: { sdk: true, authFilePresent: true, sandbox: "read-only", model: "auto" },
    });
  });

  it("locks network egress and web search shut by default, and records it in the trace payload", async () => {
    const { module, calls } = makeFakeSdk({ runs: [{ finalResponse: "done" }] });
    const emitted: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const provider = providerWith(module);
    await provider.run(
      request({ emit: (type, payload) => emitted.push({ type, payload: payload as Record<string, unknown> }) }),
      new AbortController().signal,
    );

    // A read-only filesystem is not the same thing as "no network": both switches
    // are sent explicitly instead of relying on an SDK default.
    expect(calls.threadOptions[0]).toMatchObject({ networkAccessEnabled: false, webSearchMode: "disabled" });
    const event = emitted.find((entry) => entry.type === "provider.request");
    expect(event?.payload).toMatchObject({ networkAccessEnabled: false, webSearchMode: "disabled" });
    expect(await provider.healthCheck()).toMatchObject({ details: { networkAccessEnabled: false, webSearchMode: "disabled" } });
  });

  it("lets the caller pick the model, and treats \"auto\" as \"use the configured one\"", async () => {
    const { module, calls } = makeFakeSdk({ runs: [{ finalResponse: "done" }, { finalResponse: "done" }, { finalResponse: "done" }] });
    const configured = providerWith(module, { model: "gpt-6-astra" });
    await configured.run(request({ model: "gpt-5.6-sol" }), new AbortController().signal);
    expect(calls.threadOptions[0]?.model).toBe("gpt-5.6-sol");

    const auto = providerWith(module, { model: "gpt-6-astra" });
    await auto.run(request({ model: "auto" }), new AbortController().signal);
    expect(calls.threadOptions[1]?.model).toBe("gpt-6-astra");

    const none = providerWith(module, { model: "auto" });
    await none.run(request(), new AbortController().signal);
    expect(calls.threadOptions[2]?.model).toBeUndefined();
  });

  it("can be pointed at another Codex build (the Windows app's binary)", async () => {
    const { module, calls } = makeFakeSdk({ runs: [{ finalResponse: "done" }] });
    const provider = providerWith(module, {
      options: { codexPath: "C:\\Users\\x\\codex.exe", requireWorkspace: true },
    });
    await provider.run(request(), new AbortController().signal);
    expect(calls.sdkOptions[0]).toMatchObject({ codexPathOverride: "C:\\Users\\x\\codex.exe" });
    expect(await provider.healthCheck()).toMatchObject({ details: { codexPath: "C:\\Users\\x\\codex.exe", windowsPaths: false } });
  });

  it("translates a WSL mount workspace into the Windows path that build can use", async () => {
    const { module, calls } = makeFakeSdk({ runs: [{ finalResponse: "done" }] });
    const provider = providerWith(module, {
      options: { windowsPaths: true, requireWorkspace: true },
    });
    await provider.run({ ...request(), workspace: "/mnt/c/Users/example/win-scratch" }, new AbortController().signal);
    expect(calls.threadOptions[0]?.workingDirectory).toBe("C:\\Users\\example\\win-scratch");
  });

  it("sends no permission fields at all when it is told to follow Codex's own settings", async () => {
    const { module, calls } = makeFakeSdk({ runs: [{ finalResponse: "done" }] });
    const provider = providerWith(module, {
      sandbox: "workspace-write",
      options: { inheritCodexSettings: true, requireWorkspace: true },
    });
    await provider.run(request(), new AbortController().signal);
    const options = calls.threadOptions[0]!;
    // Nothing is overridden, so Codex applies ~/.codex/config.toml (or its own defaults).
    expect(options).not.toHaveProperty("sandboxMode");
    expect(options).not.toHaveProperty("approvalPolicy");
    expect(options).not.toHaveProperty("networkAccessEnabled");
    expect(options).not.toHaveProperty("webSearchMode");
    // The working directory is still passed: Codex needs to know where to run.
    expect(options.workingDirectory).toBe("/tmp/ws");
    expect(await provider.healthCheck()).toMatchObject({
      details: { sandbox: "from-codex-config", inheritCodexSettings: true, networkAccessEnabled: "from-codex-config" },
    });
  });

  it("requires an explicit opt-in before a worker may reach the network or search the web", async () => {
    const { module } = makeFakeSdk({ runs: [{ finalResponse: "done" }, { finalResponse: "done" }] });
    await expect(providerWith(module, { options: { networkAccessEnabled: true } }).run(request(), new AbortController().signal)).rejects.toMatchObject({
      code: "CONFIG_ERROR",
    });
    await expect(providerWith(module, { options: { webSearchMode: "live" } }).run(request(), new AbortController().signal)).rejects.toMatchObject({
      code: "CONFIG_ERROR",
    });

    // A misconfigured switch is reported, not thrown, so doctor can explain it.
    const misconfigured = providerWith(module, { options: { networkAccessEnabled: true } });
    const health = await misconfigured.healthCheck();
    expect(health).toMatchObject({ healthy: false });
    expect(health.reason ?? "").toContain("allowNetworkAccess");
  });

  it("passes the opted-in egress switches through when the operator allows them", async () => {
    const { module, calls } = makeFakeSdk({ runs: [{ finalResponse: "done" }] });
    const provider = providerWith(module, {
      options: { networkAccessEnabled: true, allowNetworkAccess: true, webSearchMode: "cached", allowWebSearch: true },
    });
    await provider.run(request(), new AbortController().signal);
    expect(calls.threadOptions[0]).toMatchObject({ networkAccessEnabled: true, webSearchMode: "cached" });
  });

  it("records real tool events at the default level too, but never reasoning items", async () => {
    const { module } = makeFakeSdk({
      runs: [
        {
          finalResponse: "",
          events: [
            { type: "thread.started", thread_id: "thread-verbose" },
            { type: "item.completed", item: { type: "reasoning", text: "SECRET CHAIN OF THOUGHT" } },
            { type: "item.completed", item: { type: "command_execution", id: "c1", command: "npm test", status: "completed" } },
            { type: "item.completed", item: { type: "agent_message", id: "m1", text: "verified" } },
            { type: "turn.completed", usage: { input_tokens: 5, output_tokens: 2, cached_input_tokens: 0 } },
          ],
        },
      ],
    });
    const provider = providerWith(module);
    const registry = new ProviderRegistry();
    registry.register("codex", provider, config);
    const harness = await createHarness({
      providers: { codex: config },
      routing: { general: { primary: "codex", fallback: [] } },
      registry,
      // The broker resolves the allowlisted workspace name before the provider
      // ever sees it; the provider only receives the canonicalised path.
      workspaces: { scratch: tmpdir() },
    });

    // No traceLevel on purpose: a cloud client does not send one, and the write audit
    // (file_change / command_execution) must not depend on the caller asking for verbose.
    const result = await harness.broker.runAgent({ worker: "codex", task: "verify", workspace: "scratch" });
    expect(result).toMatchObject({ status: "completed" });
    const trace = JSON.stringify(await harness.broker.getTrace(result.traceId!, "debug"));
    expect(trace).toContain("tool.event");
    expect(trace).toContain("npm test");
    expect(trace).not.toContain("SECRET CHAIN OF THOUGHT");
  });
});
