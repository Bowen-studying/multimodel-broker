import { createRuntime } from "../core/bootstrap.js";
import { toBrokerError } from "../core/errors.js";
import { runMcpHttpServer, type McpHttpHandle } from "../interfaces/mcp/http.js";

export interface McpHttpCliOptions {
  configPath?: string;
  profile?: string;
  host?: string;
  port?: number;
  path?: string;
  /** Name of the environment variable that holds the shared secret. */
  tokenEnv?: string;
  allowAnonymous?: boolean;
  maxRequestsPerMinute?: number;
  maxConcurrentRequests?: number;
  /** Use an SSE stream instead of plain JSON responses. */
  sse?: boolean;
  logLevel?: string;
}

const DEFAULT_TOKEN_ENV = "BROKER_HTTP_TOKEN";

/**
 * Serve the broker over MCP Streamable HTTP.
 *
 * The endpoint is bound to loopback by default and expects a shared secret, so
 * the usual deployment is: this process on 127.0.0.1, and a tunnel or the
 * project's own relay in front of it carrying the public HTTPS URL.
 */
export async function runMcpHttp(options: McpHttpCliOptions = {}): Promise<number> {
  const tokenEnv = options.tokenEnv ?? DEFAULT_TOKEN_ENV;
  const token = process.env[tokenEnv];
  if (!token && options.allowAnonymous !== true) {
    process.stderr.write(
      [
        `Refusing to start: $${tokenEnv} is empty.`,
        "",
        "Generate a secret and export it, for example:",
        `  export ${tokenEnv}="$(openssl rand -hex 24)"`,
        "",
        "Then start the server again. Only use --allow-anonymous for a throwaway",
        "local test: an unauthenticated endpoint spends provider budget for anyone",
        "who can reach it.",
        "",
      ].join("\n"),
    );
    return 2;
  }

  const runtime = await createRuntime({ configPath: options.configPath, logLevel: options.logLevel ?? process.env.BROKER_LOG_LEVEL });
  const { logger } = runtime;
  const handle: McpHttpHandle = await runMcpHttpServer({
    broker: runtime.broker,
    logger,
    ...(options.profile === undefined ? {} : { profile: options.profile }),
    ...(options.host === undefined ? {} : { host: options.host }),
    ...(options.port === undefined ? {} : { port: options.port }),
    ...(options.path === undefined ? {} : { path: options.path }),
    ...(token === undefined ? {} : { token }),
    allowAnonymous: options.allowAnonymous === true,
    ...(options.maxRequestsPerMinute === undefined ? {} : { maxRequestsPerMinute: options.maxRequestsPerMinute }),
    ...(options.maxConcurrentRequests === undefined ? {} : { maxConcurrentRequests: options.maxConcurrentRequests }),
    jsonResponses: options.sse !== true,
  });

  const loopback = handle.host === "127.0.0.1" || handle.host === "::1" || handle.host === "localhost";
  process.stderr.write(
    [
      "multimodel-broker - MCP over HTTP",
      `  endpoint : ${handle.url}`,
      `  health   : http://${handle.host}:${handle.port}/healthz`,
      `  profile  : ${options.profile ?? "chatgpt-pro-readonly"} (${handle.tools.length} tools)`,
      `  responses: ${options.sse === true ? "SSE stream" : "JSON"}`,
      `  guards   : ${options.maxRequestsPerMinute ?? 60} req/min, ${options.maxConcurrentRequests ?? 4} concurrent`,
      `  auth     : ${token ? `token from $${tokenEnv} (fingerprint ${handle.tokenFingerprint})` : "DISABLED (--allow-anonymous)"}`,
      `  reachable: ${loopback ? "this machine only" : "THIS NETWORK - the token is the only boundary"}`,
      "",
      "The endpoint URL becomes the client configuration, and the token travels in it:",
      "  treat the URL as a secret, never commit it, and rotate it if it leaks.",
      "",
    ].join("\n"),
  );

  await new Promise<void>((resolve) => {
    let stopping = false;
    const stop = (signal: string): void => {
      if (stopping) return;
      stopping = true;
      logger.info("Shutting down MCP HTTP server", { signal });
      void (async () => {
        try {
          await handle.close();
        } catch {
          /* socket already gone */
        }
        try {
          await runtime.close();
        } catch {
          /* store already closed */
        }
        resolve();
      })();
    };
    process.on("SIGINT", () => stop("SIGINT"));
    process.on("SIGTERM", () => stop("SIGTERM"));
  });
  return 0;
}

export async function main(options: McpHttpCliOptions = {}): Promise<number> {
  try {
    return await runMcpHttp(options);
  } catch (error) {
    const failure = toBrokerError(error, "INTERNAL");
    process.stderr.write(`${JSON.stringify({ level: "error", message: "Unable to start MCP HTTP server", code: failure.code, error: failure.message })}\n`);
    return 1;
  }
}
