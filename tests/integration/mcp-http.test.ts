import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { existsSync } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ProviderConfig } from "../../src/core/types.js";
import { createLogger } from "../../src/core/logger.js";
import { runMcpHttpServer, type McpHttpHandle } from "../../src/interfaces/mcp/http.js";
import { toolMetadata } from "../../src/interfaces/mcp/tools.js";
import { toolsForProfile } from "../../src/interfaces/mcp/profiles.js";
import { createHarness } from "../fixtures/harness.js";

const execFileAsync = promisify(execFile);
const TOKEN = "test-token-0123456789abcdef";
const ACCEPT = "application/json, text/event-stream";

const providers: Record<string, ProviderConfig> = {
  mock: {
    enabled: true,
    adapter: "mock",
    model: "mock-model",
    authMode: "unknown",
    maxConcurrency: 2,
    defaultTimeoutMs: 5000,
    mock: {
      delayMs: 5,
      behavior: "success",
      answer: "Mock answer: {{task}}",
      usage: { inputTokens: 7, outputTokens: 3, cost: 0 },
      rules: [{ match: "SLOW", delayMs: 2000, answer: "slow answer" }],
    },
  },
};

const handles: McpHttpHandle[] = [];
const clients: Client[] = [];

async function startServer(overrides: Record<string, unknown> = {}): Promise<McpHttpHandle> {
  const harness = await createHarness({ providers, routing: { general: { primary: "mock", fallback: [] } } });
  const handle = await runMcpHttpServer({
    broker: harness.broker,
    logger: createLogger({ level: "silent" }),
    profile: "local-full",
    token: TOKEN,
    port: 0,
    ...overrides,
  });
  handles.push(handle);
  return handle;
}

async function connect(handle: McpHttpHandle, token?: string): Promise<Client> {
  const url = token ? `${handle.url}?token=${encodeURIComponent(token)}` : handle.url;
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    ...(token ? {} : { requestInit: { headers: { authorization: `Bearer ${TOKEN}` } } }),
  });
  const client = new Client({ name: "http-test-client", version: "0.0.1" }, { capabilities: {} });
  await client.connect(transport);
  clients.push(client);
  return client;
}

function payloadOf(result: { structuredContent?: unknown; content?: unknown }): Record<string, unknown> {
  if (result.structuredContent) return result.structuredContent as Record<string, unknown>;
  const content = result.content as Array<{ type: string; text: string }>;
  return JSON.parse(content[0]!.text) as Record<string, unknown>;
}

async function post(
  handle: McpHttpHandle,
  body: unknown,
  options: { token?: string; contentType?: string; accept?: string; headers?: Record<string, string> } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": options.contentType ?? "application/json",
    accept: options.accept ?? ACCEPT,
    ...options.headers,
  };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  return fetch(handle.url, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const handle of handles.splice(0)) await handle.close().catch(() => {});
});

describe("mcp http server", () => {
  it("serves the profile's tools with the documented annotations", async () => {
    const handle = await startServer({ profile: "local-full" });
    const client = await connect(handle, TOKEN);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([...toolsForProfile("local-full")].sort());
    const expected = new Map(toolMetadata("local-full").map((meta) => [meta.name, meta]));
    for (const tool of tools) {
      const meta = expected.get(tool.name as never)!;
      expect(tool.annotations).toMatchObject(meta.annotations);
    }
  });

  it("runs a worker end to end and returns the envelope", async () => {
    const handle = await startServer();
    const client = await connect(handle, TOKEN);
    const result = (await client.callTool({ name: "run_worker", arguments: { worker: "mock", task: "HELLO" } })) as {
      structuredContent?: unknown;
      content?: unknown;
    };
    const envelope = payloadOf(result);
    expect(envelope).toMatchObject({ ok: true, status: "completed", data: { selectedWorker: "mock" } });
    expect((envelope.data as { result: { answer: string } }).result.answer).toContain("Mock answer: HELLO");
  });

  it("exposes the local profile's tool set when that profile is selected", async () => {
    const handle = await startServer({ profile: "local-full" });
    const client = await connect(handle, TOKEN);
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    expect(names).toContain("delegate_batch");
    expect(names).toContain("cancel_task");
    // The write tool belongs to the agent profile only.
    expect(names).not.toContain("run_agent");
  });

  it("accepts the shared secret from a header or from the query string", async () => {
    const handle = await startServer();
    const withHeader = await connect(handle);
    expect((await withHeader.listTools()).tools.length).toBeGreaterThan(0);

    const withQuery = await connect(handle, TOKEN);
    expect((await withQuery.listTools()).tools.length).toBeGreaterThan(0);
  });

  it("rejects a missing or wrong shared secret with 401", async () => {
    const handle = await startServer();
    const anonymous = await post(handle, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    expect(anonymous.status).toBe(401);
    const wrong = await post(handle, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, { token: "not-the-token" });
    expect(wrong.status).toBe(401);
    expect(await anonymous.json()).toMatchObject({ error: "unauthorized" });
  });

  it("enforces the per-minute request budget with 429 and Retry-After", async () => {
    const handle = await startServer({ maxRequestsPerMinute: 3 });
    const call = () => post(handle, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, { token: TOKEN });
    for (let index = 0; index < 3; index++) {
      const response = await call();
      expect(response.status).not.toBe(429);
    }
    const limited = await call();
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
  });

  it("refuses to start without a token, and can be forced with allowAnonymous", async () => {
    const harness = await createHarness({ providers, routing: { general: { primary: "mock", fallback: [] } } });
    const logger = createLogger({ level: "silent" });
    await expect(runMcpHttpServer({ broker: harness.broker, logger, port: 0 })).rejects.toThrow(/token/i);

    const anonymous = await runMcpHttpServer({ broker: harness.broker, logger, port: 0, allowAnonymous: true });
    handles.push(anonymous);
    const health = await fetch(`http://${anonymous.host}:${anonymous.port}/healthz`);
    expect(health.status).toBe(200);
  });

  it("serves /healthz without a token and never echoes the secret", async () => {
    const handle = await startServer();
    const response = await fetch(`http://${handle.host}:${handle.port}/healthz`);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("\"status\":\"ok\"");
    expect(text).not.toContain(TOKEN);
    expect(handle.tokenFingerprint).toHaveLength(8);
    expect(text).not.toContain(handle.tokenFingerprint!);
  });

  it("rejects a malformed body with 400 and keeps serving", async () => {
    const handle = await startServer();
    const bad = await post(handle, "{not json", { token: TOKEN });
    expect(bad.status).toBe(400);
    const client = await connect(handle, TOKEN);
    const ping = (await client.callTool({ name: "ping", arguments: {} })) as { structuredContent?: unknown };
    expect(payloadOf(ping)).toMatchObject({ ok: true, status: "completed" });
  });

  it("opens a session on initialize, streams over GET and closes it on DELETE", async () => {
    const handle = await startServer();
    const init = await post(
      handle,
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "raw-test", version: "0" } } },
      { token: TOKEN },
    );
    expect(init.status).toBe(200);
    const sessionId = init.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();
    await init.text();
    expect(handle.sessionCount()).toBe(1);

    // An unknown session is rejected the way the spec says, not silently reused.
    const unknown = await post(handle, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, { token: TOKEN, headers: { "mcp-session-id": "00000000-0000-4000-8000-000000000000" } });
    expect(unknown.status).toBe(404);

    // GET opens the server-to-client SSE stream. ChatGPT's MCP client sends this;
    // answering 405 here is what makes a server look broken to it.
    const controller = new AbortController();
    const stream = await fetch(handle.url, {
      headers: { accept: "text/event-stream", "mcp-session-id": sessionId!, ...bearer(TOKEN) },
      signal: controller.signal,
    });
    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type") ?? "").toContain("text/event-stream");
    controller.abort();

    const closed = await fetch(handle.url, { method: "DELETE", headers: { "mcp-session-id": sessionId!, ...bearer(TOKEN) } });
    expect(closed.status).toBe(200);
    await closed.text();

    const afterDelete = await post(handle, { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }, { token: TOKEN, headers: { "mcp-session-id": sessionId! } });
    expect(afterDelete.status).toBe(404);
  });

  it("rejects a stream request that carries no session, and 404s unknown paths", async () => {
    const handle = await startServer();
    // A session-less GET is the availability probe: answer it with a live SSE stream so a
    // cloud client does not mark the app unavailable, and keep an unknown session a 404.
    const stream = await fetch(handle.url, { headers: { accept: "text/event-stream", ...bearer(TOKEN) } });
    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type") ?? "").toContain("text/event-stream");
    const reader = stream.body?.getReader();
    const first = await reader?.read();
    expect(new TextDecoder().decode(first?.value).startsWith(": multimodel-broker ready")).toBe(true);
    await reader?.cancel();

    const unknownSession = await fetch(handle.url, { headers: { accept: "text/event-stream", "mcp-session-id": "00000000-0000-4000-8000-000000000000", ...bearer(TOKEN) } });
    expect(unknownSession.status).toBe(404);

    const missing = await fetch(`${handle.url}/nope`, { headers: bearer(TOKEN) });
    expect(missing.status).toBe(404);
  });

  it("accepts a POST whose Accept header is not the strict pair", async () => {
    // OpenAI's probe sends `Accept: */*`; the transport would answer 406.
    const handle = await startServer();
    const response = await post(
      handle,
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "probe", version: "0" } } },
      { token: TOKEN, accept: "*/*" },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("mcp-session-id")).toBeTruthy();
    await response.text();
  });

  it("exposes the single write tool only in the agent profile, with mutating annotations", async () => {
    // C4 gate: the cloud client must SEE the writing tool as mutating, not slip past a
    // read-only label. This asserts the wire-level tool list, not the source constants.
    const local = await connect(await startServer({ profile: "local-full" }));
    const localTools = await local.listTools();
    expect(localTools.tools.map((tool) => tool.name)).not.toContain("run_agent");

    const agent = await connect(await startServer({ profile: "chatgpt-agent" }));
    const agentTools = await agent.listTools();
    const names = agentTools.tools.map((tool) => tool.name);
    expect(names).toContain("run_agent");
    expect(names).toContain("run_worker");
    // One write tool, and it names every worker it can drive.
    expect(names).not.toContain("run_claude_code");

    const runAgent = agentTools.tools.find((tool) => tool.name === "run_agent")!;
    expect(runAgent.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
      idempotentHint: false,
    });
    // The text has to say what it does and which workers it reaches, because that is what a calling
    // model reads - including that a claude-code workspace is a starting directory, not a sandbox.
    expect(runAgent.description ?? "").toMatch(/WRITE|side effects/i);
    const workerField = JSON.stringify(runAgent.inputSchema ?? {});
    for (const worker of ["codex", "codex-win", "claude-code"]) {
      expect(workerField).toContain(worker);
    }

    // Everything else in the agent profile stays read-only: exactly one tool may mutate.
    for (const tool of agentTools.tools.filter((entry) => entry.name !== "run_agent")) {
      expect(tool.annotations?.readOnlyHint).toBe(true);
    }
  });

  it("tells a modern client its version is unsupported, and answers a legacy one", async () => {
    const handle = await startServer();

    // 2026-07-28 replaced the handshake with per-request metadata; this server speaks the
    // legacy era. The spec's version negotiation is a 400 + UnsupportedProtocolVersionError
    // with the versions we do support, so the client can downgrade to `initialize` (a bare
    // 200 with only legacy versions in `supportedVersions` made ChatGPT's connector creation
    // fail outright - see docs/poc/chatgpt-pro-localmcp.md).
    const modern = await post(
      handle,
      {
        jsonrpc: "2.0",
        id: "discover-1",
        method: "server/discover",
        params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } },
      },
      { token: TOKEN, headers: { "mcp-protocol-version": "2026-07-28" } },
    );
    expect(modern.status).toBe(400);
    const payload = (await modern.json()) as {
      id: string;
      error: { code: number; data: { supported: string[]; requested: string } };
    };
    expect(payload.id).toBe("discover-1");
    expect(payload.error.code).toBe(-32022);
    expect(payload.error.data.requested).toBe("2026-07-28");
    expect(payload.error.data.supported).toContain("2025-11-25");

    const legacy = await post(
      handle,
      { jsonrpc: "2.0", id: "discover-2", method: "server/discover", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2025-11-25" } } },
      { token: TOKEN, headers: { "mcp-protocol-version": "2025-11-25" } },
    );
    expect(legacy.status).toBe(200);
    const result = (await legacy.json()) as { result: { capabilities: Record<string, unknown>; _meta: Record<string, { name: string }> } };
    expect(result.result.capabilities.tools).toBeDefined();
    expect(result.result._meta["io.modelcontextprotocol/serverInfo"]?.name).toBe("multimodel-broker");

    // Discovery is metadata: no session opened, no tool-call budget spent.
    expect(handle.sessionCount()).toBe(0);
  });

  it("keeps the localhost-only default and reports the tools on the handle", async () => {
    const handle = await startServer();
    expect(handle.host).toBe("127.0.0.1");
    expect(handle.port).toBeGreaterThan(0);
    expect(handle.tools).toEqual([...toolsForProfile("local-full")]);
    expect(handle.url).not.toContain(TOKEN);
  });
});

const cliPath = path.resolve("dist/cli/index.js");
const describeIfBuilt = existsSync(cliPath) ? describe : describe.skip;

describeIfBuilt("mcp-http CLI guard", () => {
  it("exits 2 with instructions when the token variable is empty", async () => {
    const env: Record<string, string | undefined> = { ...process.env, BROKER_LOG_LEVEL: "silent" };
    delete env.BROKER_HTTP_TOKEN;
    const failure = await execFileAsync(process.execPath, [cliPath, "mcp-http"], { env, cwd: process.cwd() }).then(
      () => undefined,
      (error: { code?: number; stderr?: string }) => error,
    );
    expect(failure?.code).toBe(2);
    expect(failure?.stderr ?? "").toContain("BROKER_HTTP_TOKEN");
  });
});
