import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { UI_PROBE_TOOL, UI_PROBE_URI } from "../../src/interfaces/mcp/server.js";

/**
 * The MCP Apps path: a tool that carries `_meta.ui.resourceUri` plus a `text/html;profile=mcp-app`
 * resource. ChatGPT declares the `io.modelcontextprotocol/ui` extension, so this is the route for
 * in-conversation interaction (a card the user can click) now that elicitation is unavailable.
 * Verified here with a real SDK client; whether the platform *renders* it is the live probe.
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
storage: { driver: memory, sqlitePath: data/broker.ui.sqlite }
server: { defaultProfile: chatgpt-pro-readonly }
`;

let tempDir: string;
const clients: Client[] = [];

async function connect(extraEnv: Record<string, string> = {}): Promise<Client> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)) as Record<string, string>;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliPath, "mcp-stdio", "--profile", "chatgpt-pro-readonly", "--config", path.join(tempDir, "broker.yaml")],
    cwd: process.cwd(),
    env: { ...env, BROKER_LOG_LEVEL: "silent", ...extraEnv },
    stderr: "pipe",
  });
  const client = new Client({ name: "ui-probe-client", version: "0.0.1" }, { capabilities: {} });
  await client.connect(transport);
  clients.push(client);
  return client;
}

describeIfBuilt("MCP Apps UI probe", () => {
  beforeAll(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "broker-ui-"));
    await writeFile(path.join(tempDir, "broker.yaml"), CONFIG, "utf8");
  }, 30_000);

  afterAll(async () => {
    for (const client of clients) await client.close().catch(() => {});
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  it("stays out of the tool list when the flag is off", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).not.toContain(UI_PROBE_TOOL);
  }, 30_000);

  it("links a tool to a hostable UI resource and serves that resource", async () => {
    const client = await connect({ BROKER_UI_PROBE: "1" });

    const { tools } = await client.listTools();
    const probe = tools.find((tool) => tool.name === UI_PROBE_TOOL);
    expect(probe).toBeDefined();
    // This is what tells the client to render the card next to the tool output.
    expect((probe?._meta as { ui?: { resourceUri?: string } } | undefined)?.ui?.resourceUri).toBe(UI_PROBE_URI);

    const { resources } = await client.listResources();
    expect(resources.map((resource) => resource.uri)).toContain(UI_PROBE_URI);

    const read = await client.readResource({ uri: UI_PROBE_URI });
    const first = read.contents[0] as { mimeType?: string; text?: string };
    expect(first.mimeType).toBe("text/html;profile=mcp-app");
    expect(first.text ?? "").toContain("UI_PROBE_RENDERED");
    // The documented MCP Apps bridge, not the host-specific window.openai convenience.
    expect(first.text ?? "").toContain("postMessage");
    expect(first.text ?? "").toContain("ui/notifications/tool-result");
  }, 30_000);

  it("answers the probe tool locally without touching any worker", async () => {
    const client = await connect({ BROKER_UI_PROBE: "1" });
    const result = (await client.callTool({ name: UI_PROBE_TOOL, arguments: {} })) as {
      structuredContent?: { rendered?: boolean; uri?: string };
    };
    expect(result.structuredContent).toMatchObject({ rendered: true, uri: UI_PROBE_URI });
  }, 30_000);
});
