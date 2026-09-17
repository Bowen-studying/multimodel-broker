import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Scripted local HTTP server for provider tests. No test in this suite ever
 * talks to a real provider endpoint: everything is 127.0.0.1 and ephemeral.
 */
export interface ScriptedResponse {
  status?: number;
  body?: unknown;
  raw?: string;
  headers?: Record<string, string>;
  delayMs?: number;
  /** Destroy the socket after the request was received (post-send failure). */
  destroy?: boolean;
  /** Accept the request and never answer (timeout test). */
  hang?: boolean;
}

export interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export class FakeHttpServer {
  private server?: Server;
  private script: ScriptedResponse[];
  readonly requests: RecordedRequest[] = [];
  /** Connections the client closed (proves an abort actually hit the socket). */
  closedConnections = 0;
  /**
   * Dedicated answer for GET /models health probes. When set it does NOT consume
   * the scripted chat responses, so tests can assert exact chat request counts.
   */
  modelsResponse?: ScriptedResponse;

  constructor(script: ScriptedResponse[] = []) {
    this.script = [...script];
  }

  setScript(script: ScriptedResponse[]): void {
    this.script = [...script];
  }

  get count(): number {
    return this.requests.length;
  }

  /** Requests that are not health probes. */
  get chatRequests(): RecordedRequest[] {
    return this.requests.filter((request) => !request.url.includes("/models"));
  }

  get chatCount(): number {
    return this.chatRequests.length;
  }

  get lastRequest(): RecordedRequest | undefined {
    return this.requests.at(-1);
  }

  private next(): ScriptedResponse {
    if (this.script.length > 1) return this.script.shift()!;
    return this.script[0] ?? { status: 200, body: { choices: [{ message: { content: "ok" } }] } };
  }

  async start(): Promise<string> {
    this.server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        this.requests.push({
          method: request.method ?? "",
          url: request.url ?? "",
          headers: request.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
        const step = this.modelsResponse && (request.url ?? "").includes("/models") ? this.modelsResponse : this.next();
        if (step.destroy) {
          request.socket.destroy();
          return;
        }
        if (step.hang) {
          request.socket.on("close", () => {
            this.closedConnections++;
          });
          return;
        }
        const send = () => {
          if (response.writableEnded || response.destroyed) return;
          const status = step.status ?? 200;
          response.writeHead(status, { "Content-Type": "application/json", ...(step.headers ?? {}) });
          response.end(step.raw ?? JSON.stringify(step.body ?? {}));
        };
        if (step.delayMs) setTimeout(send, step.delayMs);
        else send();
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    const { port } = this.server!.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** A URL that nothing is listening on (used for the connection-refused path). */
export async function reservedClosedPortUrl(): Promise<string> {
  const probe = new FakeHttpServer();
  const url = await probe.start();
  await probe.stop();
  return url;
}
