import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Broker } from "../../core/broker.js";
import type { Logger } from "../../core/types.js";
import { resolveProfile, toolsForProfile, type ProfileName } from "./profiles.js";
import { registerTools, toolMetadata } from "./tools.js";

export const SERVER_INFO = { name: "multimodel-broker", version: "0.1.0" } as const;

/**
 * Name of the dev-only elicitation probe. It is registered only when
 * `BROKER_ELICITATION_PROBE=1`, so the production tool surface is unchanged by default.
 */
export const ELICITATION_PROBE_TOOL = "ask_user_probe";

export interface CreateMcpServerOptions {
  broker: Broker;
  /** Profile name (validated here) or an already-resolved profile. */
  profile: string | ProfileName;
  logger?: Logger;
  /** Overrides `SERVER_INFO.version` (used by CLI so the reported version matches). */
  version?: string;
}

/**
 * Ask the *caller's* user a question from inside a tool call. This is the mechanism behind the
 * "know when Codex is blocked and answer it from the chat" requirement: MCP elicitation is the only
 * documented way for a server to request structured input mid-call. Whether the caller supports it
 * is a platform property, so a missing capability returns an explicit payload instead of throwing.
 */
function registerElicitationProbe(server: McpServer, logger?: Logger): void {
  server.registerTool(
    ELICITATION_PROBE_TOOL,
    {
      description:
        "Dev probe (BROKER_ELICITATION_PROBE=1): ask the caller's user one question through MCP elicitation and return the answer. Reports supported=false when the caller cannot be elicited.",
      inputSchema: {
        question: z.string(),
        options: z.array(z.string()).optional(),
      } as never,
    },
    (async (args: { question: string; options?: string[] }) => {
      const options = args.options ?? [];
      // Report the caller's actual declaration: it decides whether this path is available at all.
      const declared = (server.server.getClientCapabilities() ?? null) as {
        elicitation?: { form?: unknown; url?: unknown } | undefined;
      } | null;
      const elicitation = declared?.elicitation;
      const modes = {
        any: Boolean(elicitation),
        form: elicitation ? elicitation.form !== undefined || (elicitation.form === undefined && elicitation.url === undefined) : false,
        url: elicitation?.url !== undefined,
      };
      try {
        const result = await server.server.elicitInput({
          message: args.question,
          requestedSchema: {
            type: "object" as const,
            properties: options.length
              ? { answer: { type: "string" as const, title: "Answer", enum: options } }
              : { answer: { type: "string" as const, title: "Answer" } },
            required: ["answer"],
          },
        });
        const answer = (result.content as { answer?: string } | undefined)?.answer ?? null;
        logger?.info("elicitation probe answered", { action: result.action, hasAnswer: answer !== null });
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ supported: true, action: result.action, answer, modes, declaredElicitation: elicitation ?? null }) },
          ],
        };
      } catch (error) {
        const message = (error as Error).message;
        logger?.warn("elicitation probe unsupported", { error: message });
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ supported: false, error: message, modes, declaredElicitation: elicitation ?? null }) },
          ],
        };
      }
    }) as never,
  );
}

/**
 * Dev-only probe for the MCP Apps path: does this client render a server-hosted inline UI?
 * Enabled with `BROKER_UI_PROBE=1`. The widget is deliberately tiny - its only job is to prove the
 * platform renders `text/html;profile=mcp-app` and lets the card call a tool back.
 */
export const UI_PROBE_TOOL = "ui_probe";
export const UI_PROBE_URI = "ui://widget/probe.html";

const UI_PROBE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Broker UI probe</title></head>
<body style="font-family:system-ui;padding:8px">
  <div style="font-size:16px">UI_PROBE_RENDERED</div>
  <div style="font-size:12px;color:#666">bridge: <span id="host">waiting</span></div>
  <button id="go" style="margin-top:6px;padding:4px 10px">调用 ping</button>
  <pre id="out" style="margin-top:6px;white-space:pre-wrap;font-size:12px"></pre>
  <script>
    // MCP Apps bridge as documented by the Apps SDK: talk to the host with postMessage JSON-RPC and
    // react to ui/notifications/*. window.openai is a host convenience, not a requirement.
    const out = document.getElementById('out');
    const hostEl = document.getElementById('host');
    const pending = new Map();
    let nextId = 1;
    function request(method, params) {
      const id = nextId++;
      try { window.parent.postMessage({ jsonrpc: '2.0', id, method, params }, '*'); }
      catch (error) { hostEl.textContent = 'postMessage failed: ' + error; }
      return new Promise((resolve) => pending.set(id, resolve));
    }
    window.addEventListener('message', (event) => {
      const message = event.data;
      if (!message || message.jsonrpc !== '2.0') return;
      if (message.id !== undefined && pending.has(message.id)) {
        pending.get(message.id)(message.result ?? message.error);
        pending.delete(message.id);
        return;
      }
      if (message.method === 'ui/notifications/tool-result') {
        hostEl.textContent = 'tool-result received';
        out.textContent = JSON.stringify(message.params?.structuredContent ?? message.params ?? {}).slice(0, 800);
      }
    }, { passive: true });
    document.getElementById('go').addEventListener('click', async () => {
      const result = await request('tools/call', { name: 'ping', arguments: {} });
      out.textContent = JSON.stringify(result, null, 2).slice(0, 1200);
    });
  </script>
</body></html>`;


function registerUiProbe(server: McpServer, logger?: Logger): void {
  server.registerResource(
    "broker-ui-probe",
    UI_PROBE_URI,
    { title: "Broker UI probe", mimeType: "text/html;profile=mcp-app" },
    (async () => ({
      contents: [
        {
          uri: UI_PROBE_URI,
          mimeType: "text/html;profile=mcp-app",
          text: UI_PROBE_HTML,
          _meta: { ui: { prefersBorder: true } },
        },
      ],
    })) as never,
  );
  server.registerTool(
    UI_PROBE_TOOL,
    {
      title: "UI probe",
      description:
        "Dev probe (BROKER_UI_PROBE=1): renders a server-hosted inline UI card and reports whether the client renders it. Runs no worker and costs nothing.",
      inputSchema: { note: z.string().optional() } as never,
      _meta: {
        ui: { resourceUri: UI_PROBE_URI },
        // ChatGPT's documented compatibility alias for the same link.
        "openai/outputTemplate": UI_PROBE_URI,
        "openai/toolInvocation/invoking": "Rendering…",
        "openai/toolInvocation/invoked": "Rendered.",
      },
    } as never,
    (async () => {
      logger?.info("ui probe rendered");
      return {
        structuredContent: { rendered: true, uri: UI_PROBE_URI },
        content: [{ type: "text" as const, text: "UI_PROBE_REQUESTED - if you can see a card, the MCP Apps path works." }],
      };
    }) as never,
  );
}

/**
 * Build the MCP server for one profile. The tool set is decided solely by the
 * profile; there is no per-provider logic in this layer.
 */
export function createMcpServer(options: CreateMcpServerOptions): McpServer {
  const profile = resolveProfile(typeof options.profile === "string" ? options.profile : String(options.profile));
  const server = new McpServer(
    { name: SERVER_INFO.name, version: options.version ?? SERVER_INFO.version },
    {
      // `resources` and the UI extension are only advertised when the probe is on: an unadvertised
      // capability is better than one the server cannot serve.
      capabilities:
        process.env.BROKER_UI_PROBE === "1"
          ? ({
              tools: {},
              resources: {},
              extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } },
            } as never)
          : { tools: {} },
      instructions: `Multi-Model Broker. Profile "${profile}": ${toolsForProfile(profile).join(", ")}. These tools delegate tasks to configured AI workers; they never write files, repositories or third-party objects.`,
    },
  );
  registerTools(server, options.broker, profile, options.logger);
  if (process.env.BROKER_ELICITATION_PROBE === "1") registerElicitationProbe(server, options.logger);
  if (process.env.BROKER_UI_PROBE === "1") registerUiProbe(server, options.logger);
  return server;
}

export { toolMetadata, toolsForProfile, resolveProfile };
export type { ProfileName };
