#!/usr/bin/env node
/**
 * Acceptance for the MCP Apps (inline UI) path over the real HTTP entry — the same path the relay
 * and therefore ChatGPT uses. Read-only: lists tools/resources, reads the widget, calls the probe
 * tool (which touches no worker). Tokens are read from their 600 files and never printed.
 */
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const token = readFileSync(process.env.HOME + "/.broker-agent-token", "utf8").trim();
const base = "http://127.0.0.1:8790/mcp";
let pass = 0;
let fail = 0;
const ok = (m) => { pass++; console.log(`  PASS ${m}`); };
const bad = (m) => { fail++; console.log(`  FAIL ${m}`); };

const client = new Client({ name: "broker-ui-check", version: "1" }, { capabilities: {} });
const transport = new StreamableHTTPClientTransport(new URL(`${base}?token=${encodeURIComponent(token)}`));
await client.connect(transport);
ok("initialize over HTTP");

const { tools } = await client.listTools();
const names = tools.map((t) => t.name);
names.includes("ui_probe") ? ok(`tools/list = ${names.length} tools incl. ui_probe`) : bad(`ui_probe missing: ${names.join(", ")}`);
const probe = tools.find((t) => t.name === "ui_probe");
const uri = probe?._meta?.ui?.resourceUri;
uri ? ok(`ui_probe carries _meta.ui.resourceUri = ${uri}`) : bad("ui_probe has no _meta.ui.resourceUri");

const { resources } = await client.listResources();
const found = resources.map((r) => r.uri);
found.includes("ui://widget/probe.html") ? ok(`resources/list = ${found.length} incl. the widget`) : bad(`widget missing from resources/list: ${found.join(", ")}`);

const read = await client.readResource({ uri: "ui://widget/probe.html" });
const first = read.contents[0];
first?.mimeType === "text/html;profile=mcp-app" ? ok(`resources/read mimeType = ${first.mimeType}`) : bad(`unexpected mimeType: ${first?.mimeType}`);
String(first?.text ?? "").includes("UI_PROBE_RENDERED") ? ok("widget html carries the render marker") : bad("widget html missing the marker");

const result = await client.callTool({ name: "ui_probe", arguments: {} });
const rendered = result.structuredContent?.rendered === true;
rendered ? ok("ui_probe answered (no worker call)") : bad(`ui_probe returned ${JSON.stringify(result.structuredContent)}`);

await client.close().catch(() => {});
console.log(`\nresult: ${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
