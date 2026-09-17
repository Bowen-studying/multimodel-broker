# 001 – Broker Core is transport-agnostic and ChatGPT-agnostic

Status: accepted (2026-09-16)

## Context

The primary entry point is ChatGPT Pro through an MCP bridge (LocalMCP). That bridge
has real constraints: child MCP calls time out after roughly 60 s, overlapping
requests can be answered with busy/429, its generic `call_mcp_tool` entry point is
annotated as possibly writing/executing, and the public relay is a third-party
Cloudflare Worker.

The task book (§4) requires that these constraints never leak into the Core: "Core
不依赖 ChatGPT", "LocalMCP 只是可替换的 ChatGPT Bridge", "MCP Tool 只调用 Core".

## Decision

The repository is layered strictly:

- `src/core/*` - routing, policy, scheduling, tasks, traces. No MCP import, no
  ChatGPT knowledge, no transport.
- `src/providers/*` - `WorkerProvider` implementations. No MCP, no task bookkeeping.
- `src/interfaces/mcp/*` - tool schemas, annotations, profiles, handlers. Handlers
  call the Broker facade only; they never touch a provider, a store or the router.
- Entry points (`src/cli/*`) assemble the pieces through `src/core/bootstrap.ts`.

Consequences that follow from the bridge's limits are handled inside the Core rather
than by special-casing ChatGPT:

- long work returns `taskId` after `waitMs` (the bridge must never be blocked),
- parallelism happens inside one `delegate_batch` call,
- the ChatGPT profile simply omits `cancel_task`.

## Consequences

- A second entry point (an HTTP/A2A endpoint, a native Codex/Claude Code/Hermes
  plugin, MCP Inspector) needs no Core change.
- Replacing LocalMCP with a self-hosted Worker or an official tunnel is a
  configuration change, not a code change.
- `codex mcp-server` (or `codex app-server`) cannot be used as the broker's transport
  shortcut without violating this decision.

## Verified locally

- `tests/integration/mcp-stdio.test.ts` spawns the real CLI over stdio and drives it
  through the official MCP client; the same Core also runs behind the CLI commands
  and behind the acceptance scripts in `scripts/`.
