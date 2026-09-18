#!/usr/bin/env node
import { createRuntime } from "../core/bootstrap.js";
import { BrokerError, toBrokerError } from "../core/errors.js";
import { redact } from "../security/redaction.js";
import type { TaskRecord, WorkerInfo } from "../core/types.js";
import { runRelay } from "./relay.js";
import { runDoctor } from "./doctor.js";
import { runMcpHttp } from "./mcp-http.js";
import { runMcpStdio } from "./mcp-stdio.js";

const USAGE = `multimodel-broker <command> [options]

Commands
  relay setup|start|status|stop|url  Manage the outbound relay
  doctor                     Check config, storage, workspaces and provider readiness
  mcp-stdio                  Serve MCP over stdio (stdout is the protocol channel)
  mcp-http                   Serve MCP over Streamable HTTP (loopback + shared secret)
  ping                       Ask the broker for its own status
  task [--worker <id>] <text> Run one task (delegates automatically when --worker is omitted)
  tasks                      List recent tasks
  trace <traceId>            Print a task's audit trace
  config --show              Print the resolved configuration (secrets redacted)
  prune --days <n> [--yes]   Delete tasks/traces older than <n> days

Global options
  --config <path>            Configuration file (default: $BROKER_CONFIG or built-in defaults)
  --json                     Machine-readable output
Command options
  --worker <id>              Explicit worker for "task"
  --workspace <name>         Allowlisted workspace name for "task"
  --wait-ms <n>              Block up to n ms before returning a taskId (default 15000, max 45000)
  --level <level>            Trace level for "trace": summary | verbose | debug
  --limit <n>                Number of rows for "tasks" (default 20)
  --profile <name>           MCP profile for "mcp-stdio"/"mcp-http": chatgpt-agent (default) | local-full
  --host <addr>              Bind address for "mcp-http" (default 127.0.0.1)
  --port <n>                 Port for "mcp-http" (default 8789, 0 picks a free one)
  --path <p>                 MCP path for "mcp-http" (default /mcp)
  --token-env <VAR>          Env var holding the "mcp-http" shared secret (default BROKER_HTTP_TOKEN)
  --max-rpm <n>              Request budget per minute for "mcp-http" (default 60)
  --max-concurrent <n>       Concurrent request cap for "mcp-http" (default 4)
  --sse                      Answer "mcp-http" with an SSE stream instead of JSON
  --allow-anonymous          Start "mcp-http" without a token (unsafe, local tests only)
  --show                     Required flag for "config"
`;

const BOOLEAN_FLAGS = new Set(["--json", "--show", "--yes", "-h", "--help", "--sse", "--allow-anonymous"]);
const VALUE_FLAGS = new Set([
  "--config",
  "--worker",
  "--wait-ms",
  "--level",
  "--limit",
  "--days",
  "--profile",
  "--workspace",
  "--host",
  "--port",
  "--path",
  "--token-env",
  "--max-rpm",
  "--max-concurrent",
]);
const KNOWN_COMMANDS = new Set(["doctor", "mcp-stdio", "mcp-http", "ping", "task", "tasks", "trace", "config", "prune"]);

export interface ParsedArgs {
  command?: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

export class UsageError extends Error {}

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  let command: string | undefined;
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!;
    if (token === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (token.startsWith("--")) {
      if (BOOLEAN_FLAGS.has(token)) {
        flags[token] = true;
        continue;
      }
      if (!VALUE_FLAGS.has(token)) throw new UsageError(`Unknown option: ${token}`);
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new UsageError(`Option ${token} requires a value`);
      flags[token] = value;
      index++;
      continue;
    }
    if (!command) command = token;
    else positionals.push(token);
  }
  return { command, positionals, flags };
}

function numericFlag(flags: ParsedArgs["flags"], name: string, fallback?: number): number | undefined {
  const raw = flags[name];
  if (raw === undefined) return fallback;
  if (raw === true) throw new UsageError(`Option ${name} requires a value`);
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new UsageError(`Option ${name} must be a nonnegative number`);
  return value;
}

function write(flags: ParsedArgs["flags"], json: unknown, human: () => string): void {
  const safe = redact(json);
  process.stdout.write(flags["--json"] ? `${JSON.stringify(safe, null, 2)}\n` : human());
}

function summariseWorker(worker: WorkerInfo): string {
  return [
    `  - ${worker.id} [${worker.enabled ? "enabled" : "disabled"}] provider=${worker.provider} auth=${worker.authMode} model=${worker.model ?? "-"} concurrency=${worker.maxConcurrency}`,
    `      healthy=${worker.healthy} capabilities=${worker.capabilities.join(",") || "-"}${worker.reasonUnavailable ? ` reason=${worker.reasonUnavailable}` : ""}`,
  ].join("\n");
}

function summariseTask(task: TaskRecord): string {
  return `  - ${task.id} ${task.status} kind=${task.kind} created=${task.createdAt}${task.parentId ? ` parent=${task.parentId}` : ""}`;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  if (argv[0] === "relay") return runRelay(argv.slice(1));
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }

  const { command, flags, positionals } = parsed;
  if (!command || flags["-h"] || flags["--help"]) {
    process.stdout.write(USAGE);
    return command ? 0 : 2;
  }
  if (!KNOWN_COMMANDS.has(command)) {
    process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
    return 2;
  }

  const configPath = typeof flags["--config"] === "string" ? (flags["--config"] as string) : undefined;

  try {
    if (command === "doctor") return await runDoctor({ configPath, json: flags["--json"] === true });

    if (command === "mcp-stdio") {
      const profile = typeof flags["--profile"] === "string" ? (flags["--profile"] as string) : undefined;
      // Never returns while the transport is open.
      await runMcpStdio({ configPath, profile });
      return 0;
    }

    if (command === "mcp-http") {
      const stringFlag = (name: string): string | undefined => (typeof flags[name] === "string" ? (flags[name] as string) : undefined);
      const port = numericFlag(flags, "--port");
      const maxRpm = numericFlag(flags, "--max-rpm");
      const maxConcurrent = numericFlag(flags, "--max-concurrent");
      // Never returns while the listener is open.
      return await runMcpHttp({
        configPath,
        ...(stringFlag("--profile") === undefined ? {} : { profile: stringFlag("--profile")! }),
        ...(stringFlag("--host") === undefined ? {} : { host: stringFlag("--host")! }),
        ...(port === undefined ? {} : { port }),
        ...(stringFlag("--path") === undefined ? {} : { path: stringFlag("--path")! }),
        ...(stringFlag("--token-env") === undefined ? {} : { tokenEnv: stringFlag("--token-env")! }),
        ...(maxRpm === undefined ? {} : { maxRequestsPerMinute: maxRpm }),
        ...(maxConcurrent === undefined ? {} : { maxConcurrentRequests: maxConcurrent }),
        allowAnonymous: flags["--allow-anonymous"] === true,
        sse: flags["--sse"] === true,
      });
    }

    const runtime = await createRuntime({ configPath });

    if (command === "ping") {
      write(flags, runtime.broker.ping(), () => "broker: ok\n");
      return 0;
    }

    if (command === "config") {
      if (flags["--show"] !== true) throw new UsageError("config requires --show");
      write(flags, runtime.config, () => `${JSON.stringify(redact(runtime.config), null, 2)}\n`);
      return 0;
    }

    if (command === "task") {
      const text = positionals.join(" ").trim();
      if (!text) throw new UsageError("task requires the task text");
      const worker = typeof flags["--worker"] === "string" ? (flags["--worker"] as string) : undefined;
      const workspace = typeof flags["--workspace"] === "string" ? (flags["--workspace"] as string) : undefined;
      const waitMs = numericFlag(flags, "--wait-ms");
      const submission = { task: text, ...(worker ? { worker } : {}), ...(workspace ? { workspace } : {}), ...(waitMs === undefined ? {} : { waitMs }) };
      const envelope = worker ? await runtime.broker.runWorker(submission) : await runtime.broker.delegate(submission);
      write(flags, envelope, () => {
        const data = envelope.data as { selectedWorker?: string; result?: { answer?: string } } | undefined;
        return [
          `status : ${envelope.status}`,
          `ok     : ${envelope.ok}`,
          `worker : ${data?.selectedWorker ?? worker ?? "-"}`,
          `taskId : ${envelope.taskId ?? "-"}`,
          `traceId: ${envelope.traceId ?? "-"}`,
          envelope.error ? `error  : ${envelope.error.code}: ${envelope.error.message}` : "",
          data?.result?.answer ? `answer :\n${data.result.answer}` : "",
          "",
        ]
          .filter((line) => line !== "")
          .join("\n")
          .concat("\n");
      });
      return envelope.ok ? 0 : 1;
    }

    if (command === "tasks") {
      const limit = numericFlag(flags, "--limit", 20)!;
      const tasks = await runtime.store.listRecentTasks(limit);
      write(flags, tasks, () => (tasks.length ? `${tasks.map(summariseTask).join("\n")}\n` : "no tasks\n"));
      return 0;
    }

    if (command === "trace") {
      const traceId = positionals[0];
      if (!traceId) throw new UsageError("trace requires a traceId");
      const level = typeof flags["--level"] === "string" ? (flags["--level"] as string) : "summary";
      const trace = await runtime.broker.getTrace(traceId, level as "summary" | "verbose" | "debug");
      write(flags, trace, () =>
        trace.events
          .map((event) => `#${event.seq} ${event.timestamp} ${event.type} ${JSON.stringify(event.payload)}`)
          .join("\n")
          .concat(trace.events.length ? "\n" : "trace has no events\n"),
      );
      return 0;
    }

    if (command === "prune") {
      const days = numericFlag(flags, "--days");
      if (days === undefined) throw new UsageError("prune requires --days <n>");
      const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
      const removed = await runtime.store.deleteOlderThan(cutoff);
      write(flags, { removed, cutoff }, () => `removed ${removed} task(s) older than ${cutoff}\n`);
      return 0;
    }

    throw new UsageError(`Unknown command: ${command}`);
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n\n${USAGE}`);
      return 2;
    }
    const failure = toBrokerError(error, "INTERNAL");
    process.stderr.write(`error[${failure.code}]: ${redact(failure.message)}\n`);
    if (!(error instanceof BrokerError)) {
      // Unexpected failures keep going to stderr, without leaking a stack to a
      // client-facing channel. The JSON logger still records the full shape.
      process.stderr.write(`${JSON.stringify({ level: "debug", detail: String((error as Error)?.name ?? "Error") })}\n`);
    }
    return 1;
  }
}

import { pathToFileURL } from "node:url";
const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
const invokedDirectly = entry !== undefined && import.meta.url === entry;
if (invokedDirectly || process.env.BROKER_CLI_FORCE_RUN === "1") {
  main().then((code) => {
    process.exitCode = code;
  });
}
