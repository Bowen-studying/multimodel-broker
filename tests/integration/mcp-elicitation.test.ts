import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ELICITATION_PROBE_TOOL } from "../../src/interfaces/mcp/server.js";

/**
 * Proves the A-path (server asks the caller's user a question from inside a tool call) works with a
 * REAL MCP client, before depending on any platform's support for it. Two clients are used: one that
 * declares the elicitation capability and answers, and one that does not declare it at all.
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
      answer: 'Mock answer'
      usage: { inputTokens: 1, outputTokens: 1, cost: 0 }
routing:
  general: { primary: mock, fallback: [] }
concurrency: { global: 2, mock: 2 }
limits:
  defaultWaitMs: 5000
  maxWaitMs: 10000
workspaces: {}
trace: { storePrompts: false, retentionDays: 1 }
storage: { driver: memory, sqlitePath: data/broker.elicit.sqlite }
server: { defaultProfile: chatgpt-pro-readonly }
`;

let tempDir: string;
const clients: Client[] = [];

async function connectClient(capabilities: Record<string, unknown>, register?: (client: Client) => void): Promise<Client> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)) as Record<string, string>;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliPath, "mcp-stdio", "--profile", "chatgpt-pro-readonly", "--config", path.join(tempDir, "broker.yaml")],
    cwd: process.cwd(),
    env: { ...env, BROKER_LOG_LEVEL: "silent", BROKER_ELICITATION_PROBE: "1" },
    stderr: "pipe",
  });
  const client = new Client({ name: "elicit-test-client", version: "0.0.1" }, { capabilities });
  // Handlers must exist before connect: the SDK declares capabilities during initialize.
  register?.(client);
  await client.connect(transport);
  clients.push(client);
  return client;
}

type Envelope = Record<string, unknown>;

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<Envelope> {
  const result = (await client.callTool({ name, arguments: args })) as { content: Array<{ type: string; text: string }> };
  return JSON.parse(result.content[0]!.text) as Envelope;
}

describeIfBuilt("MCP elicitation (server asks the caller's user)", () => {
  beforeAll(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "broker-elicit-"));
    await writeFile(path.join(tempDir, "broker.yaml"), CONFIG, "utf8");
  }, 30_000);

  afterAll(async () => {
    for (const client of clients) await client.close().catch(() => {});
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  it("is absent from the tool list unless the probe flag is on", async () => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)) as Record<string, string>;
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cliPath, "mcp-stdio", "--profile", "chatgpt-pro-readonly", "--config", path.join(tempDir, "broker.yaml")],
      cwd: process.cwd(),
      env: { ...env, BROKER_LOG_LEVEL: "silent" },
      stderr: "pipe",
    });
    const client = new Client({ name: "no-probe-client", version: "0.0.1" }, { capabilities: {} });
    await client.connect(transport);
    clients.push(client);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).not.toContain(ELICITATION_PROBE_TOOL);
  }, 30_000);

  it("carries a question to the client and returns the user's answer", async () => {
    let seen: { message?: string; requestedSchema?: { properties?: { answer?: { enum?: string[] } } } } | undefined;
    const client = await connectClient({ elicitation: {} }, (c) =>
      c.setRequestHandler(ElicitRequestSchema, async (request) => {
        seen = request.params as typeof seen;
        // Answer within the offered choices when there are any, otherwise free text: the server
        // validates the response against the requested schema either way.
        const allowed = seen?.requestedSchema?.properties?.answer?.enum;
        return { action: "accept" as const, content: { answer: allowed?.[0] ?? "OK_FROM_USER" } };
      }),
    );

    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toContain(ELICITATION_PROBE_TOOL);

    const withChoices = await call(client, ELICITATION_PROBE_TOOL, { question: "是否允许执行 rm -rf？", options: ["允许", "拒绝"] });
    expect(withChoices.error).toBeUndefined();
    expect(withChoices).toMatchObject({ supported: true, action: "accept", answer: "允许" });
    // The probe must report what the caller declared, so a failing round trip is diagnosable.
    expect(withChoices.modes).toMatchObject({ any: true, form: true });
    expect(seen?.message).toBe("是否允许执行 rm -rf？");

    const freeText = await call(client, ELICITATION_PROBE_TOOL, { question: "还有什么要补充的？" });
    expect(freeText).toMatchObject({ supported: true, action: "accept", answer: "OK_FROM_USER" });
  }, 30_000);

  it("reports supported=false instead of crashing when the client cannot be elicited", async () => {
    const client = await connectClient({});
    const envelope = await call(client, ELICITATION_PROBE_TOOL, { question: "在吗？" });
    expect(envelope.supported).toBe(false);
    expect(String(envelope.error ?? "").length).toBeGreaterThan(0);
    expect(envelope.modes).toMatchObject({ any: false, form: false, url: false });
    expect(envelope.declaredElicitation).toBeNull();
  }, 30_000);
});
