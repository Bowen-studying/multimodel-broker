import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { toolMetadata } from "../../src/interfaces/mcp/tools.js";
import { toolsForProfile } from "../../src/interfaces/mcp/profiles.js";

/**
 * End-to-end stdio test against the REAL built CLI, spoken to over the official
 * MCP SDK client transport. It is skipped (not failed) when `dist/` has not been
 * built yet; run `npm run build` first.
 */
const cliPath = path.resolve("dist/cli/index.js");
const describeIfBuilt = existsSync(cliPath) ? describe : describe.skip;

const CONFIG = `providers:
  mock:
    enabled: true
    adapter: mock
    model: mock-model
    authMode: unknown
    maxConcurrency: 2
    defaultTimeoutMs: 5000
    mock:
      delayMs: 5
      behavior: success
      answer: 'Mock answer: {{task}}'
      usage: { inputTokens: 7, outputTokens: 3, cost: 0 }
      rules:
        - { match: 'SLOW', delayMs: 2500, answer: 'slow answer' }
        - { match: 'FAIL', behavior: fail, errorCode: PROVIDER_ERROR }
routing:
  general: { primary: mock, fallback: [] }
concurrency: { global: 2, mock: 2 }
limits:
  defaultWaitMs: 15000
  maxWaitMs: 45000
workspaces: {}
trace: { storePrompts: false, retentionDays: 1 }
storage: { driver: memory, sqlitePath: data/broker.test.sqlite }
server: { defaultProfile: local-full }
`;

let tempDir: string;
let client: Client;
let transport: StdioClientTransport;

function payloadOf(result: { structuredContent?: unknown; content?: unknown }): Record<string, unknown> {
  if (result.structuredContent) return result.structuredContent as Record<string, unknown>;
  const content = result.content as Array<{ type: string; text: string }>;
  return JSON.parse(content[0]!.text) as Record<string, unknown>;
}

async function call(name: string, args: Record<string, unknown> = {}) {
  const result = (await client.callTool({ name, arguments: args })) as { content?: unknown; structuredContent?: unknown; isError?: boolean };
  return { result, envelope: payloadOf(result) };
}

async function waitForCompletion(taskId: string, attempts = 40) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const { envelope } = await call("get_task", { taskId });
    const status = envelope.status as string;
    if (status !== "running" && status !== "queued") return envelope;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("task did not reach a terminal state in time");
}

describeIfBuilt("mcp stdio server (real child process)", () => {
  beforeAll(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "broker-mcp-"));
    const configPath = path.join(tempDir, "broker.yaml");
    await writeFile(configPath, CONFIG, "utf8");
    const env = Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)) as Record<string, string>;
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [cliPath, "mcp-stdio", "--profile", "local-full", "--config", configPath],
      cwd: process.cwd(),
      env: { ...env, BROKER_LOG_LEVEL: "silent" },
      stderr: "pipe",
    });
    client = new Client({ name: "broker-test-client", version: "0.0.1" }, { capabilities: {} });
    await client.connect(transport);
  }, 30_000);

  afterAll(async () => {
    await client?.close().catch(() => {});
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  it("lists exactly the profile's tools with the documented annotations", async () => {
    const { tools } = await client.listTools();
    const listed = tools.map((tool) => tool.name).sort();
    expect(listed).toEqual([...toolsForProfile("local-full")].sort());
    const expected = new Map(toolMetadata("local-full").map((meta) => [meta.name, meta]));
    for (const tool of tools) {
      const meta = expected.get(tool.name as never)!;
      expect(tool.title).toBe(meta.title);
      expect(tool.description?.length ?? 0).toBeGreaterThan(30);
      expect(tool.annotations).toMatchObject(meta.annotations);
      expect(tool.inputSchema.type).toBe("object");
    }
  });

  it("answers ping and lists the mock worker", async () => {
    const ping = await call("ping");
    expect(ping.envelope).toMatchObject({ ok: true, status: "completed", data: { service: "multimodel-broker" } });

    const workers = await call("list_workers");
    const list = (workers.envelope.data as { workers: Array<Record<string, unknown>> }).workers;
    expect(list.map((worker) => worker.id)).toEqual(["mock"]);
    expect(list[0]).toMatchObject({ enabled: true, healthy: true, provider: "mock", model: "mock-model", authMode: "unknown", maxConcurrency: 2 });
  });

  it("runs a worker and returns an answer with a trace", async () => {
    const { envelope } = await call("run_worker", { worker: "mock", task: "HELLO" });
    expect(envelope).toMatchObject({ ok: true, status: "completed", data: { selectedWorker: "mock", result: { provider: "mock", status: "completed" } } });
    expect((envelope.data as { result: { answer: string } }).result.answer).toContain("Mock answer: HELLO");
    expect(envelope.taskId).toBeTypeOf("string");
    expect(envelope.traceId).toBeTypeOf("string");
    const runs = (envelope.data as { result: { usage?: { inputTokens?: number } } }).result.usage;
    expect(runs).toMatchObject({ inputTokens: 7, outputTokens: 3 });
  });

  it("delegates with deterministic routing and reports the route reason", async () => {
    const { envelope } = await call("delegate", { task: "route me" });
    expect(envelope).toMatchObject({ ok: true, status: "completed", data: { selectedWorker: "mock" } });
    expect((envelope.data as { routeReason: string }).routeReason.length).toBeGreaterThan(5);
  });

  it("returns a taskId for a long task instead of blocking, then completes via get_task", async () => {
    const started = await call("run_worker", { worker: "mock", task: "SLOW work", waitMs: 400 });
    expect(started.envelope).toMatchObject({ ok: true, status: "running" });
    const taskId = started.envelope.taskId as string;
    expect(taskId).toBeTypeOf("string");

    const finished = await waitForCompletion(taskId);
    expect(finished).toMatchObject({ ok: true, status: "completed" });
    const data = finished.data as { task: { id: string; status: string }; results: Array<{ answer: string }> };
    expect(data.task.id).toBe(taskId);
    expect(data.results[0]?.answer).toBe("slow answer");

    const again = await call("get_task", { taskId });
    expect(again.envelope.taskId).toBe(taskId);
  });

  it("keeps partial results when one batch child fails", async () => {
    const { envelope } = await call("delegate_batch", {
      mode: "parallel",
      tasks: [
        { id: "one", task: "BATCH one" },
        { id: "two", task: "FAIL two", worker: "mock" },
        { id: "three", task: "BATCH three" },
      ],
    });
    expect(envelope.status).toBe("partial_success");
    const data = envelope.data as { children: Array<Record<string, unknown>>; labels?: string[] };
    expect(data.children.map((child) => child.status)).toEqual(["completed", "failed", "completed"]);
    expect(data.labels).toEqual(["one", "two", "three"]);
    expect(data.children[2]).toMatchObject({ data: { result: { answer: "Mock answer: BATCH three" } } });
  });

  it("serves a trace with route/provider facts and no secret-shaped values", async () => {
    const run = await call("run_worker", { worker: "mock", task: "TRACE me" });
    const traceId = run.envelope.traceId as string;
    const { envelope } = await call("get_trace", { traceId, level: "verbose" });
    const serialized = JSON.stringify(envelope);
    expect(serialized).toContain("route.selected");
    expect(serialized).toContain("run.finished");
    expect(serialized).toContain("mock");

    // storePrompts defaults to false: the prompt body is recorded as a digest,
    // not as text. (The provider's own answer may legitimately echo the task.)
    const events = (envelope.data as { events: Array<{ type: string; payload: Record<string, unknown> }> }).events;
    const prompt = events.find((event) => event.type === "prompt.sent");
    expect(prompt?.payload.task).toMatchObject({ chars: expect.any(Number), sha256: expect.any(String) });
    expect(JSON.stringify(prompt)).not.toContain("TRACE me");

    expect(serialized).not.toMatch(/sk-[A-Za-z0-9]{10,}|Authorization: |Bearer [A-Za-z0-9]/i);
  });

  it("rejects invalid input without crashing the server", async () => {
    const bad = (await client.callTool({ name: "delegate", arguments: { task: "" } })) as { isError?: boolean; content?: Array<{ type: string; text?: string }> };
    // The SDK's own schema validation rejects the call before the handler runs.
    expect(bad.isError).toBe(true);
    expect(JSON.stringify(bad.content)).toMatch(/task|invalid|expected/i);

    const unknownTool = (await client.callTool({ name: "delete_everything", arguments: {} })) as { isError?: boolean };
    expect(unknownTool.isError).toBe(true);

    const stillAlive = await call("ping");
    expect(stillAlive.envelope.ok).toBe(true);
  });
});
