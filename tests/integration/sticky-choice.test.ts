/**
 * Sticky choice: naming a worker (or a model) is not just a per-call argument - it becomes the
 * remembered choice for that tool, so a follow-up call may omit it. Explicit arguments always win
 * and switch it. Nothing is ever defaulted by the broker itself, and a refused worker is never
 * remembered (otherwise the next call would inherit something unusable).
 */
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { ProviderConfig } from "../../src/core/types.js";
import { loadConfig } from "../../src/core/config.js";
import { CodexProvider, type CodexSdkModule, type CodexSdkOptions, type CodexThreadOptionsLike } from "../../src/providers/codex/index.js";
import { createProviders } from "../../src/providers/index.js";
import { createHarness } from "../fixtures/harness.js";

function fakeSdk() {
  const calls = { sdkOptions: [] as CodexSdkOptions[], threadOptions: [] as CodexThreadOptionsLike[] };
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
        if (threadOptions) calls.threadOptions.push(threadOptions);
        return makeThread("thread-1");
      }
      resumeThread(id: string, threadOptions?: CodexThreadOptionsLike) {
        // A follow-up turn resumes the thread, so the model override travels here, not through the SDK.
        if (threadOptions) calls.threadOptions.push(threadOptions);
        return makeThread(id);
      }
    },
  } as unknown as CodexSdkModule;
  return { module, calls };
}

const codexProvider = (over: Partial<ProviderConfig> = {}): ProviderConfig =>
  ({
    enabled: true,
    adapter: "codex-sdk",
    model: "auto",
    authMode: "codex-local",
    maxConcurrency: 1,
    defaultTimeoutMs: 5000,
    sandbox: "read-only",
    options: { requireWorkspace: true },
    ...over,
  }) as ProviderConfig;

async function harness() {
  const { module, calls } = fakeSdk();
  const codexConfig = codexProvider();
  const winConfig = codexProvider({ enabled: false, options: { requireWorkspace: true, codexPath: "C:\\Users\\x\\codex.exe" } });
  const apiProvider = (over: Partial<ProviderConfig> = {}): ProviderConfig =>
    ({
      enabled: true,
      adapter: "openai-compatible",
      model: "any-model",
      baseUrl: "http://127.0.0.1:1",
      apiKeyEnv: "NOPE",
      maxConcurrency: 2,
      defaultTimeoutMs: 5000,
      ...over,
    }) as ProviderConfig;

  // The real registry builds every provider that has an implementation in this build - including
  // mock and the OpenAI-compatible API workers - and only the local agents get a fake SDK injected.
  const baseConfig = await loadConfig();
  const mockProvider = (over: Partial<ProviderConfig> = {}): ProviderConfig =>
    ({ enabled: true, adapter: "mock", model: "mock-model", maxConcurrency: 4, defaultTimeoutMs: 5000, ...over }) as ProviderConfig;
  baseConfig.providers = {
    // Two offline mock workers, so "switch to another worker" is exercised without real HTTP.
    mock: mockProvider(),
    mock2: mockProvider({ model: "mock-model-2" }),
    // Present only so run_agent can be shown to refuse it; never actually called.
    deepseek: apiProvider(),
  };
  const registry = createProviders(baseConfig);
  registry.register("codex", new CodexProvider("codex", codexConfig, { loadSdk: async () => module, authFileExists: async () => true }), codexConfig);
  registry.register("codex-win", new CodexProvider("codex-win", winConfig, { loadSdk: async () => module, authFileExists: async () => true }), winConfig);

  const h = await createHarness({
    providers: { ...baseConfig.providers, codex: codexConfig, "codex-win": winConfig },
    registry,
    workspaces: { scratch: tmpdir() },
  });
  return { broker: h.broker, store: h.store, calls };
}

describe("sticky choice: 选定即记住，显式即切换", () => {
  it("remembered nothing: both tools ask the caller to name a worker", async () => {
    const h = await harness();
    await expect(h.broker.runWorker({ task: "hello" })).rejects.toThrowError(/explicit worker/);
    await expect(h.broker.runAgent({ task: "edit", workspace: "scratch" })).rejects.toThrowError(/requires a worker/);
  });

  it("remembers the worker named for run_worker, then reuses it when omitted", async () => {
    const h = await harness();
    const first = await h.broker.runWorker({ worker: "mock", task: "hello" });
    expect(first.data?.selectedWorker).toBe("mock");
    const second = await h.broker.runWorker({ task: "hello again" });
    expect(second.data?.selectedWorker).toBe("mock");
    // The audit text must not claim the caller named a worker in this request.
    expect(second.data?.routeReason).toMatch(/remembered/i);
    expect(second.data?.route.matchedRules).toEqual(["remembered"]);
    // ...while an actually explicit call keeps saying so.
    const explicitAgain = await h.broker.runWorker({ worker: "mock", task: "hello once more" });
    expect(explicitAgain.data?.routeReason).toBe("Explicit worker requested by caller");
    expect(explicitAgain.data?.route.matchedRules).toEqual(["explicit"]);
    // Not silent: the trace records that the run reused a remembered choice.
    const trace = (await h.broker.getTrace(second.traceId!, "debug")) as { events: Array<{ type: string }> };
    expect(trace.events.some((event) => event.type === "choice.remembered")).toBe(true);
  });

  it("switches when another worker is named, and remembers that instead", async () => {
    const h = await harness();
    await h.broker.runWorker({ worker: "mock", task: "hello" });
    const switched = await h.broker.runWorker({ worker: "mock2", task: "hello" });
    expect(switched.data?.selectedWorker).toBe("mock2");
    const after = await h.broker.runWorker({ task: "hello" });
    expect(after.data?.selectedWorker).toBe("mock2");
  });

  it("keeps run_worker and run_agent choices separate", async () => {
    const h = await harness();
    await h.broker.runWorker({ worker: "mock", task: "hello" });
    await h.broker.runAgent({ worker: "codex", task: "edit", workspace: "scratch" });
    const workers = await h.broker.listWorkers();
    const byId = new Map(workers.map((worker) => [worker.id, worker.defaultFor ?? []]));
    expect(byId.get("mock")).toEqual(["run_worker"]);
    expect(byId.get("codex")).toEqual(["run_agent"]);
  });

  it("never remembers a refused worker", async () => {
    const h = await harness();
    // An API worker cannot be reached through run_agent, and that refusal must not stick...
    await expect(h.broker.runAgent({ worker: "deepseek", task: "edit", workspace: "scratch" })).rejects.toThrowError(/write-capable/);
    // ...nor may a disabled local agent.
    await expect(h.broker.runAgent({ worker: "codex-win", task: "edit", workspace: "scratch" })).rejects.toThrowError(/write-capable/);
    // So an omitted worker still has nothing to fall back on, rather than an unusable remembered one.
    await expect(h.broker.runAgent({ task: "edit", workspace: "scratch" })).rejects.toThrowError(/requires a worker/);
    const workers = await h.broker.listWorkers();
    expect(workers.some((worker) => (worker.defaultFor ?? []).includes("run_agent"))).toBe(false);
    expect(await h.store.getSetting("default.worker.run_agent")).toBeUndefined();
  });

  it("remembers a model override for one worker, reapplies it, and forgets it with 'auto'", async () => {
    const h = await harness();
    await h.broker.runAgent({ worker: "codex", model: "gpt-5.6-luna", task: "edit", workspace: "scratch" });
    expect(await h.store.getSetting("default.model.codex")).toBe("gpt-5.6-luna");

    h.calls.threadOptions.length = 0;
    await h.broker.runAgent({ task: "edit again", workspace: "scratch" });
    expect(h.calls.threadOptions.at(-1)?.model).toBe("gpt-5.6-luna");

    await h.broker.runAgent({ worker: "codex", model: "auto", task: "edit", workspace: "scratch" });
    expect(await h.store.getSetting("default.model.codex")).toBeUndefined();
  });

  it("keeps the preference inside the instance: another instance starts fresh", async () => {
    const a = await harness();
    await a.broker.runWorker({ worker: "mock", task: "hello" });
    const b = await harness();
    await expect(b.broker.runWorker({ task: "hello" })).rejects.toThrowError(/explicit worker/);
  });
});
