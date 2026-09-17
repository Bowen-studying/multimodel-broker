#!/usr/bin/env node
/**
 * Cross-platform MCP round trip: spawns the BUILT broker as a child process and
 * drives it through the official MCP client over stdio.
 *
 * Unlike the vitest integration test, this does not need vitest, so the same
 * check can be run with a different Node installation (e.g. Windows Node against
 * a WSL checkout) to prove `dist/` really is portable.
 *
 *   node scripts/mcp-roundtrip.mjs [--config <path>] [--profile local-full]
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};
const configPath = flag("--config", process.env.BROKER_CONFIG ?? path.join(repoRoot, "config", "providers.yaml"));
const profile = flag("--profile", "local-full");
const cli = path.join(repoRoot, "dist", "cli", "index.js");

if (!existsSync(cli)) {
  console.error(`mcp-roundtrip: ${cli} is missing - run "npm run build" first`);
  process.exit(1);
}

const results = [];
const check = (label, ok, detail) => {
  results.push({ label, ok });
  console.log(`[${ok ? "PASS" : "FAIL"}] ${label}${detail ? ` - ${detail}` : ""}`);
};

const env = Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [cli, "mcp-stdio", "--profile", profile, "--config", configPath],
  cwd: repoRoot,
  env: { ...env, BROKER_LOG_LEVEL: "silent" },
  stderr: "pipe",
});
const client = new Client({ name: "roundtrip", version: "0.0.1" }, { capabilities: {} });

const payload = (result) => result.structuredContent ?? JSON.parse(result.content[0].text);

try {
  await client.connect(transport);
  console.log(`node       : ${process.version} (${process.platform})`);
  console.log(`cli        : ${cli}`);
  console.log(`config     : ${configPath}\n`);

  const { tools } = await client.listTools();
  check(`tools/list returns ${tools.length} tools`, tools.length >= 7, tools.map((tool) => tool.name).join(","));
  check(
    "read-only annotations preserved over the wire",
    tools.filter((tool) => ["ping", "list_workers", "get_task", "get_trace"].includes(tool.name)).every((tool) => tool.annotations?.readOnlyHint === true && tool.annotations?.openWorldHint === false),
  );

  const ping = payload(await client.callTool({ name: "ping", arguments: {} }));
  check("ping completes", ping.ok === true && ping.status === "completed");

  const workers = payload(await client.callTool({ name: "list_workers", arguments: {} }));
  const ids = (workers.data?.workers ?? []).map((worker) => worker.id);
  check("list_workers returns the configured workers", ids.length > 0, ids.join(","));

  if (ids.includes("mock")) {
    const run = payload(await client.callTool({ name: "run_worker", arguments: { worker: "mock", task: "round trip" } }));
    check("run_worker(mock) completes", run.ok === true && run.status === "completed", run.data?.result?.answer?.slice(0, 60));

    const slow = payload(await client.callTool({ name: "run_worker", arguments: { worker: "mock", task: "slow: round trip", waitMs: 300 } }));
    check("a long task returns running + taskId", slow.status === "running" && typeof slow.taskId === "string", `status=${slow.status}`);
    let final = slow;
    for (let attempt = 0; attempt < 30 && ["running", "queued"].includes(final.status); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      final = payload(await client.callTool({ name: "get_task", arguments: { taskId: slow.taskId } }));
    }
    check("get_task later returns the completed task", final.status === "completed" && final.taskId === slow.taskId);

    const trace = payload(await client.callTool({ name: "get_trace", arguments: { traceId: run.traceId, level: "verbose" } }));
    check("trace is served and contains no secret-shaped value", JSON.stringify(trace).includes("route.selected") && !/sk-[A-Za-z0-9]{10,}|Authorization:/.test(JSON.stringify(trace)));
  } else {
    check("mock worker present", false, "no mock worker in this config");
  }
} catch (error) {
  check("round trip", false, error?.message ?? String(error));
} finally {
  await client.close().catch(() => {});
}

const failed = results.filter((result) => !result.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
