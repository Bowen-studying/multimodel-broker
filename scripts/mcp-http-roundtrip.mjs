#!/usr/bin/env node
/**
 * Streamable-HTTP round trip: spawns the BUILT broker's `mcp-http` interface on an
 * ephemeral loopback port and drives it with the official MCP client, exactly the
 * way a tunnelled cloud client would.
 *
 *   node scripts/mcp-http-roundtrip.mjs [--config <path>] [--profile chatgpt-pro-readonly]
 *
 * The token is generated here and only ever printed as a fingerprint; the endpoint
 * URL is printed without it.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};
const configPath = flag("--config", process.env.BROKER_CONFIG ?? path.join(repoRoot, "config", "providers.yaml"));
const profile = flag("--profile", "chatgpt-pro-readonly");
const cli = path.join(repoRoot, "dist", "cli", "index.js");
const ACCEPT = "application/json, text/event-stream";
const token = randomBytes(24).toString("hex");

if (!existsSync(cli)) {
  console.error(`mcp-http-roundtrip: ${cli} is missing - run "npm run build" first`);
  process.exit(1);
}

const results = [];
const check = (label, ok, detail) => {
  results.push({ label, ok });
  console.log(`[${ok ? "PASS" : "FAIL"}] ${label}${detail ? ` - ${detail}` : ""}`);
};
const payload = (result) => result.structuredContent ?? JSON.parse(result.content[0].text);

const child = spawn(process.execPath, [cli, "mcp-http", "--port", "0", "--profile", profile, "--config", configPath], {
  cwd: repoRoot,
  env: { ...process.env, BROKER_HTTP_TOKEN: token, BROKER_LOG_LEVEL: "silent" },
  stdio: ["ignore", "pipe", "pipe"],
});

let endpoint;
let stderrBuffer = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  stderrBuffer += chunk;
  const match = /endpoint\s*:\s*(http:\/\/\S+)/.exec(stderrBuffer);
  if (match && !endpoint) endpoint = match[1];
});

async function waitForEndpoint(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (endpoint) return endpoint;
    if (child.exitCode !== null) throw new Error(`mcp-http exited early (code ${child.exitCode})`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("timed out waiting for the mcp-http listener");
}

/** POST an MCP frame; returns the raw Response so status codes can be asserted. */
function post(url, body, { tokenValue, accept = ACCEPT } = {}) {
  const headers = { "content-type": "application/json", accept };
  if (tokenValue) headers.authorization = `Bearer ${tokenValue}`;
  return fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
}

async function httpClient(url) {
  const transport = new StreamableHTTPClientTransport(new URL(url));
  const client = new Client({ name: "http-roundtrip", version: "0.0.1" }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

let client;
try {
  const url = await waitForEndpoint();
  console.log(`node       : ${process.version} (${process.platform})`);
  console.log(`cli        : ${cli}`);
  console.log(`config     : ${configPath}`);
  console.log(`endpoint   : ${url}  (token fingerprint ${token.slice(0, 8)})\n`);

  const health = await fetch(url.replace(/\/mcp$/, "/healthz"));
  const healthText = await health.text();
  check("healthz answers without a token", health.status === 200 && healthText.includes("\"status\":\"ok\""));
  check("healthz never echoes the secret", !healthText.includes(token));

  const anonymous = await post(url, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  check("a request without the secret is rejected", anonymous.status === 401, `status=${anonymous.status}`);

  const wrong = await post(url, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, { tokenValue: "wrong-token" });
  check("a request with a wrong secret is rejected", wrong.status === 401, `status=${wrong.status}`);

  const stream = await fetch(url, { headers: { accept: "text/event-stream", authorization: `Bearer ${token}` } });
  check("stateless mode answers 405 for a stream request", stream.status === 405, `status=${stream.status}`);

  client = await httpClient(`${url}?token=${encodeURIComponent(token)}`);
  const { tools } = await client.listTools();
  check(`tools/list returns the "${profile}" tools`, tools.length >= 6, tools.map((tool) => tool.name).join(","));
  check("the read-only profile hides cancel_task", !tools.map((tool) => tool.name).includes("cancel_task"));
  check(
    "read-only annotations survive the HTTP hop",
    tools.filter((tool) => ["ping", "list_workers", "get_task"].includes(tool.name)).every((tool) => tool.annotations?.readOnlyHint === true),
  );

  const ping = payload(await client.callTool({ name: "ping", arguments: {} }));
  check("ping completes over HTTP", ping.ok === true && ping.status === "completed");

  const workers = payload(await client.callTool({ name: "list_workers", arguments: {} }));
  const ids = (workers.data?.workers ?? []).map((worker) => worker.id);
  check("list_workers returns the configured workers", ids.length > 0, ids.join(","));

  if (ids.includes("mock")) {
    const run = payload(await client.callTool({ name: "run_worker", arguments: { worker: "mock", task: "http round trip" } }));
    check("run_worker(mock) completes over HTTP", run.ok === true && run.status === "completed", run.data?.result?.answer?.slice(0, 60));
  } else {
    check("mock worker present", false, "no mock worker in this config");
  }
} catch (error) {
  check("http round trip", false, error?.message ?? String(error));
} finally {
  await client?.close().catch(() => {});
  child.kill("SIGTERM");
}

const failed = results.filter((result) => !result.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
