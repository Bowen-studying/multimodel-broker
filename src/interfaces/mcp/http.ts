import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Broker } from "../../core/broker.js";
import type { Logger } from "../../core/types.js";
import { resolveProfile, toolsForProfile, type ProfileName } from "./profiles.js";
import { createMcpServer } from "./server.js";

/** Bodies are small JSON-RPC frames; anything larger is a client bug or an attack. */
const MAX_BODY_BYTES = 1024 * 1024;
/** A cloud client re-initializes constantly; this keeps abandoned sessions from piling up. */
const SESSION_IDLE_MS = 30 * 60_000;
const MAX_SESSIONS = 32;
/** Idle pre-initialize streams (client availability probes) kept open at most. */
const MAX_ANONYMOUS_STREAMS = 8;

export interface McpHttpOptions {
  broker: Broker;
  logger: Logger;
  /** Tool profile. Defaults to the read-only profile meant for cloud clients. */
  profile?: string | ProfileName;
  /** Bind address. Defaults to loopback: the tunnel/relay runs on the same host. */
  host?: string;
  /** TCP port; 0 picks a free port (used by tests). */
  port?: number;
  /** Path of the MCP endpoint. Defaults to `/mcp`. */
  path?: string;
  /**
   * Shared secret. Requests must present it either as `Authorization: Bearer`,
   * as an `x-broker-token` header, or as the `token` query parameter (cloud
   * clients can only be given a URL, so the URL has to carry the secret).
   * When omitted the server refuses to start unless `allowAnonymous` is set.
   */
  token?: string;
  /** Explicit opt-in for an unauthenticated endpoint. Dangerous - spends money. */
  allowAnonymous?: boolean;
  /** Sliding-window request budget for tool calls. Defaults to 60/min. */
  maxRequestsPerMinute?: number;
  /** Tool calls processed at the same time. Defaults to 4. */
  maxConcurrentRequests?: number;
  /** Reply to POSTs with plain JSON instead of an SSE stream. Defaults to true. */
  jsonResponses?: boolean;
  version?: string;
}

export interface McpHttpHandle {
  readonly host: string;
  readonly port: number;
  readonly path: string;
  /** Local URL without the token - safe to log. */
  readonly url: string;
  /** Stable per-token fingerprint so an operator can match a leaked-token alert. */
  readonly tokenFingerprint?: string;
  readonly tools: readonly string[];
  /** Live MCP sessions (one per client connection). */
  sessionCount(): number;
  close(): Promise<void>;
}

interface AnonymousStream {
  close(): void;
}

interface Session {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  lastSeen: number;
  userAgent?: string;
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

function secretEquals(expected: string, provided: string): boolean {
  // Compare digests: equal length regardless of input, so timingSafeEqual is safe.
  return timingSafeEqual(
    createHash("sha256").update(expected).digest(),
    createHash("sha256").update(provided).digest(),
  );
}

function presentedToken(request: IncomingMessage, url: URL): string | undefined {
  const authorization = request.headers.authorization;
  if (typeof authorization === "string" && /^bearer /i.test(authorization)) {
    return authorization.slice(7).trim();
  }
  const header = request.headers["x-broker-token"];
  if (typeof header === "string" && header.length > 0) return header;
  const fromQuery = url.searchParams.get("token");
  return fromQuery && fromQuery.length > 0 ? fromQuery : undefined;
}

function sendJson(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = `${JSON.stringify(body)}\n`;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    ...headers,
  });
  response.end(payload);
}

async function readBody(request: IncomingMessage): Promise<{ ok: true; value: unknown } | { ok: false; status: number; message: string }> {
  const declared = Number(request.headers["content-length"] ?? Number.NaN);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return { ok: false, status: 413, message: "request body too large" };
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    total += buffer.byteLength;
    if (total > MAX_BODY_BYTES) {
      request.destroy();
      return { ok: false, status: 413, message: "request body too large" };
    }
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (raw.length === 0) return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(raw) as unknown };
  } catch {
    return { ok: false, status: 400, message: "request body is not valid JSON" };
  }
}

/**
 * Serve the broker over the MCP Streamable HTTP transport.
 *
 * Sessions are the standard, stateful kind: `initialize` opens a session (the
 * transport returns `mcp-session-id`), later POSTs carry that header, `GET` opens
 * the server-to-client SSE stream and `DELETE` ends it. A stateless variant was
 * tried first, but real cloud clients (ChatGPT's `openai-mcp`) do send the
 * follow-up stream request, so a server that answers 405 there looks broken to them.
 *
 * Only transport, authentication and guard rails live here: the tools come from
 * the same profile registry as the stdio interface, and all task state lives in
 * the store, so a lost session loses nothing but the stream.
 */
export async function runMcpHttpServer(options: McpHttpOptions): Promise<McpHttpHandle> {
  const { broker, logger } = options;
  const profile = resolveProfile(options.profile ?? "chatgpt-pro-readonly");
  const tools = toolsForProfile(profile);
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 8789;
  const mcpPath = options.path ?? "/mcp";
  const token = options.token;
  if (!token && options.allowAnonymous !== true) {
    throw new Error("refusing to serve MCP over HTTP without a token (set --token-env or BROKER_HTTP_TOKEN, or pass --allow-anonymous)");
  }
  const maxRequestsPerMinute = options.maxRequestsPerMinute ?? 60;
  const maxConcurrentRequests = options.maxConcurrentRequests ?? 4;
  const jsonResponses = options.jsonResponses ?? true;
  const tokenFingerprint = token ? fingerprint(token) : undefined;

  const windowMs = 60_000;
  const recent: number[] = [];
  const sessions = new Map<string, Session>();
  const anonymousStreams = new Set<AnonymousStream>();
  let inFlight = 0;
  let closed = false;

  const sweep = (): void => {
    const cutoff = Date.now() - SESSION_IDLE_MS;
    for (const [id, session] of sessions) {
      if (session.lastSeen < cutoff) {
        logger.info("Closing idle MCP session", { sessionId: id, userAgent: session.userAgent });
        sessions.delete(id);
        void session.transport.close().catch(() => {});
        void session.server.close().catch(() => {});
      }
    }
  };
  const sweeper = setInterval(sweep, 60_000);
  sweeper.unref?.();

  const server: Server = createServer((request, response) => {
    void serveRequest(request, response);
  });
  // A cloud client keeps the socket open between calls; without these bounds one
  // stuck keep-alive socket would hold the process (and the tunnel) hostage.
  server.headersTimeout = 10_000;
  server.requestTimeout = 0; // SSE streams are long-lived by design.
  server.keepAliveTimeout = 65_000;

  function logRequest(fields: Record<string, unknown>): void {
    logger.info("MCP HTTP request", fields);
  }

  async function serveRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const started = Date.now();
    let url: URL;
    try {
      url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    } catch {
      sendJson(response, 400, { error: "malformed request url" });
      return;
    }
    const method = request.method ?? "GET";
    const userAgent = String(request.headers["user-agent"] ?? "").slice(0, 80) || undefined;
    const remote = request.socket.remoteAddress ?? "unknown";

    if (url.pathname === "/healthz") {
      // Deliberately unauthenticated: it is what a tunnel/daemon readiness probe
      // hits, and it exposes no secret and no task data.
      sendJson(response, 200, { status: "ok", profile, tools, sessions: sessions.size, uptimeMs: Date.now() - bootedAt });
      return;
    }

    if (url.pathname !== mcpPath) {
      sendJson(response, 404, { error: "not found" });
      logRequest({ method, path: url.pathname, status: 404, remote, userAgent });
      return;
    }

    if (token) {
      const provided = presentedToken(request, url);
      if (!provided || !secretEquals(token, provided)) {
        logger.warn("Rejected unauthenticated MCP HTTP request", { method, path: mcpPath, remote, userAgent });
        sendJson(response, 401, { error: "unauthorized" });
        return;
      }
    } else {
      logger.warn("Serving MCP HTTP anonymously - the endpoint spends provider budget for anyone who reaches it", { path: mcpPath });
    }

    // Session routing: POST creates or continues a session, GET opens the
    // server->client stream, DELETE ends the session (MCP Streamable HTTP spec).
    const requestedSession = typeof request.headers["mcp-session-id"] === "string" ? (request.headers["mcp-session-id"] as string) : undefined;

    if (method === "GET" && !requestedSession) {
      // A cloud client's availability probe GETs the endpoint before it initializes.
      // Per spec a missing session is a 400, but an error at this point is what makes
      // ChatGPT mark the whole app as unavailable (observed 2026-09-17: 1x406 + 9x404
      // from `Python/3.14 aiohttp` right before "Multimodel Broker is unavailable").
      // Answering with an idle SSE stream keeps that probe happy and costs one socket.
      if (anonymousStreams.size >= MAX_ANONYMOUS_STREAMS) {
        const oldest = anonymousStreams.values().next().value as AnonymousStream | undefined;
        if (oldest) oldest.close();
      }
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      response.write(": multimodel-broker ready\n\n");
      const timer = setInterval(() => {
        try {
          response.write(": keep-alive\n\n");
        } catch {
          /* the socket is gone; the close handler cleans up */
        }
      }, 15_000);
      timer.unref?.();
      const entry: AnonymousStream = {
        close: () => {
          clearInterval(timer);
          anonymousStreams.delete(entry);
          if (!response.writableEnded) response.end();
        },
      };
      anonymousStreams.add(entry);
      request.on("close", () => entry.close());
      logRequest({ method, path: mcpPath, status: 200, remote, userAgent, note: "unbound SSE stream" });
      return;
    }

    if (method === "GET" || method === "DELETE") {
      const session = requestedSession ? sessions.get(requestedSession) : undefined;
      if (!session) {
        // Spec: a missing session header is 400, an unknown one is 404. Cloud clients
        // probe this endpoint with a bare GET before they initialize, so keeping the
        // two apart is what makes that probe readable in the logs.
        const status = requestedSession ? 404 : 400;
        sendJson(response, status, {
          jsonrpc: "2.0",
          error: {
            code: requestedSession ? -32001 : -32000,
            message: requestedSession ? "Session not found" : "Bad Request: missing session",
          },
          id: null,
        });
        logRequest({
          method,
          path: mcpPath,
          status,
          remote,
          userAgent,
          sessionId: requestedSession,
          accept: String(request.headers.accept ?? "").slice(0, 60),
        });
        return;
      }
      session.lastSeen = Date.now();
      try {
        await session.transport.handleRequest(request, response);
        logRequest({ method, path: mcpPath, status: response.statusCode, durationMs: Date.now() - started, remote, userAgent, sessionId: requestedSession });
      } catch (error) {
        logRequest({ method, path: mcpPath, status: 500, remote, userAgent, sessionId: requestedSession, error: (error as Error).message });
        if (!response.headersSent) sendJson(response, 500, { error: "internal error" });
      }
      return;
    }

    if (method !== "POST") {
      sendJson(response, 405, { error: "method not allowed", allow: "GET, POST, DELETE" }, { allow: "GET, POST, DELETE" });
      logRequest({ method, path: mcpPath, status: 405, remote, userAgent });
      return;
    }

    const now = Date.now();
    while (recent.length > 0 && now - recent[0]! > windowMs) recent.shift();
    if (recent.length >= maxRequestsPerMinute) {
      const retryAfterMs = windowMs - (now - recent[0]!);
      logger.warn("MCP HTTP request budget exhausted", { maxRequestsPerMinute, retryAfterMs, userAgent });
      sendJson(response, 429, { error: "request budget exhausted", retryAfterMs }, { "retry-after": String(Math.max(1, Math.ceil(retryAfterMs / 1000))) });
      return;
    }
    if (inFlight >= maxConcurrentRequests) {
      logger.warn("MCP HTTP concurrency limit reached", { maxConcurrentRequests, userAgent });
      sendJson(response, 429, { error: "busy", maxConcurrentRequests }, { "retry-after": "1" });
      return;
    }

    // Some clients (notably OpenAI's aiohttp probe) send `Accept: */*` or only one of
    // the two types; the transport answers 406 in that case, which reads as "this app is
    // broken". We only ever emit JSON or SSE, so accept whatever they asked for.
    const accept = String(request.headers.accept ?? "");
    const acceptNormalized = !accept.includes("application/json") || !accept.includes("text/event-stream");
    if (acceptNormalized) request.headers.accept = "application/json, text/event-stream";

    const body = await readBody(request);
    if (!body.ok) {
      logger.warn("Rejected malformed MCP HTTP body", { status: body.status, reason: body.message, userAgent });
      sendJson(response, body.status, { error: body.message });
      return;
    }
    const rpc = body.value as { method?: string; params?: { name?: string } } | undefined;
    // Logged before execution: a call that hangs or kills the process still leaves a trace.
    logRequest({
      phase: "start",
      method: rpc?.method ?? "unknown",
      tool: rpc?.params?.name,
      remote,
      userAgent,
      sessionId: requestedSession,
      protocolHeader: String(request.headers["mcp-protocol-version"] ?? "") || undefined,
      modernMeta: Boolean((body.value as { params?: { _meta?: unknown } } | undefined)?.params?._meta),
      acceptNormalized: acceptNormalized || undefined,
    });

    if (rpc?.method === "server/discover") {
      // Revision 2026-07-28 replaced the `initialize` handshake with per-request metadata.
      // This server speaks the legacy era, so answer discovery per the spec's version
      // negotiation: a version we do not implement gets `UnsupportedProtocolVersionError`
      // (HTTP 400, `supported` list) so the client downgrades instead of receiving a bare
      // -32601. A legacy version we do support gets a real DiscoverResult.
      const requested =
        (body.value as { params?: { _meta?: Record<string, unknown> } } | undefined)?.params?._meta?.[
          "io.modelcontextprotocol/protocolVersion"
        ] ?? request.headers["mcp-protocol-version"];
      const requestedVersion = typeof requested === "string" ? requested : undefined;
      const supported = [...SUPPORTED_PROTOCOL_VERSIONS];
      logRequest({
        phase: "end",
        method: "server/discover",
        status: requestedVersion && supported.includes(requestedVersion) ? 200 : 400,
        durationMs: Date.now() - started,
        remote,
        userAgent,
        protocolHeader: requestedVersion,
      });
      if (requestedVersion && !supported.includes(requestedVersion)) {
        sendJson(response, 400, {
          jsonrpc: "2.0",
          id: (body.value as { id?: unknown }).id ?? null,
          error: {
            code: -32022,
            message: "Unsupported protocol version",
            data: { supported, requested: requestedVersion },
          },
        });
        return;
      }
      sendJson(response, 200, {
        jsonrpc: "2.0",
        id: (body.value as { id?: unknown }).id ?? null,
        result: {
          resultType: "complete",
          supportedVersions: supported,
          capabilities: { tools: {} },
          _meta: {
            "io.modelcontextprotocol/serverInfo": {
              name: "multimodel-broker",
              version: options.version ?? "0.1.0",
            },
          },
          instructions:
            "Multimodel Broker runs tasks on configured AI workers. list_workers shows them, run_worker targets one, delegate lets the broker pick, delegate_batch fans out.",
          ttlMs: 3_600_000,
          cacheScope: "public",
        },
      });
      return;
    }

    recent.push(now);
    inFlight += 1;

    const existing = requestedSession ? sessions.get(requestedSession) : undefined;
    if (requestedSession && !existing) {
      inFlight -= 1;
      sendJson(response, 404, { jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null });
      logRequest({ phase: "end", method: rpc?.method ?? "unknown", status: 404, remote, userAgent, sessionId: requestedSession });
      return;
    }

    let session = existing;
    let created = false;
    if (!session) {
      if (sessions.size >= MAX_SESSIONS) {
        inFlight -= 1;
        sendJson(response, 503, { error: "too many sessions" });
        logRequest({ phase: "end", method: rpc?.method ?? "unknown", status: 503, remote, userAgent });
        return;
      }
      const mcpserver = createMcpServer({ broker, profile, logger, ...(options.version ? { version: options.version } : {}) });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: jsonResponses,
        onsessioninitialized: (sessionId) => {
          sessions.set(sessionId, { transport, server: mcpserver, lastSeen: Date.now(), userAgent });
          logger.info("MCP HTTP session opened", { sessionId, userAgent, remote, sessions: sessions.size });
        },
      });
      transport.onclose = () => {
        const id = transport.sessionId;
        if (id && sessions.has(id)) {
          sessions.delete(id);
          logger.info("MCP HTTP session closed", { sessionId: id, userAgent });
        }
      };
      await mcpserver.connect(transport);
      session = { transport, server: mcpserver, lastSeen: Date.now(), userAgent };
      created = true;
    }

    session.lastSeen = Date.now();
    try {
      await session.transport.handleRequest(request, response, body.value);
      // Only meaningful after the initialize request has been handled: that is when the caller's
      // declared capabilities exist. Elicitation (asking the user something mid-call) depends on
      // them, so record the real declaration instead of assuming platform support.
      if (created) {
        const clientCapabilities = session.server.server.getClientCapabilities() ?? null;
        const clientInfo = session.server.server.getClientVersion() ?? null;
        logger.info("MCP client capabilities", {
          sessionId: session.transport.sessionId,
          userAgent,
          remote,
          client: clientInfo,
          capabilities: clientCapabilities,
        });
      }
    } catch (error) {
      logger.error("MCP HTTP request failed", { method: rpc?.method ?? "unknown", tool: rpc?.params?.name, error: (error as Error).message });
      if (!response.headersSent) sendJson(response, 500, { error: "internal error" });
    } finally {
      inFlight -= 1;
      logRequest({
        phase: "end",
        method: rpc?.method ?? "unknown",
        tool: rpc?.params?.name,
        status: response.statusCode,
        durationMs: Date.now() - started,
        remote,
        userAgent,
        newSession: created ? session.transport.sessionId : undefined,
        sessionId: session.transport.sessionId ?? requestedSession,
      });
    }
  }

  const bootedAt = Date.now();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;

  const handle: McpHttpHandle = {
    host,
    port: actualPort,
    path: mcpPath,
    url: `http://${host}:${actualPort}${mcpPath}`,
    ...(tokenFingerprint ? { tokenFingerprint } : {}),
    tools,
    sessionCount: () => sessions.size,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      clearInterval(sweeper);
      for (const session of sessions.values()) {
        void session.transport.close().catch(() => {});
        void session.server.close().catch(() => {});
      }
      sessions.clear();
      for (const stream of anonymousStreams) stream.close();
      anonymousStreams.clear();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        // Keep-alive sockets and open SSE streams would otherwise delay shutdown.
        server.closeAllConnections();
      });
    },
  };
  return handle;
}
