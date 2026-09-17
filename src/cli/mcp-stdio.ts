import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createRuntime } from "../core/bootstrap.js";
import { createMcpServer } from "../interfaces/mcp/server.js";
import { resolveProfile } from "../interfaces/mcp/profiles.js";
import { toBrokerError } from "../core/errors.js";

/**
 * Serve the broker over stdio.
 *
 * stdout is the MCP channel and carries protocol frames only - every log line
 * goes to stderr (the structured logger writes to stderr by design), so a
 * stray `console.log` here would corrupt the transport.
 */
export interface McpStdioOptions {
  configPath?: string;
  profile?: string;
  logLevel?: string;
}

export async function runMcpStdio(options: McpStdioOptions = {}): Promise<void> {
  const runtime = await createRuntime({ configPath: options.configPath, logLevel: options.logLevel ?? process.env.BROKER_LOG_LEVEL });
  const { logger } = runtime;
  const profile = resolveProfile(options.profile ?? runtime.config.server.defaultProfile);
  const server = createMcpServer({ broker: runtime.broker, profile, logger });
  const transport = new StdioServerTransport();

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    logger.info("Shutting down MCP stdio server", { signal });
    try {
      await server.close();
    } catch {
      /* transport already gone */
    }
    try {
      await runtime.close();
    } catch {
      /* store already closed */
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await server.connect(transport);
  logger.info("MCP stdio server ready", {
    profile,
    tools: (await import("../interfaces/mcp/profiles.js")).toolsForProfile(profile),
    storage: runtime.config.storage.driver,
  });
}

export async function main(options: McpStdioOptions = {}): Promise<number> {
  try {
    await runMcpStdio(options);
    return 0;
  } catch (error) {
    const failure = toBrokerError(error, "INTERNAL");
    process.stderr.write(`${JSON.stringify({ level: "error", message: "Unable to start MCP stdio server", code: failure.code, error: failure.message })}\n`);
    return 1;
  }
}
