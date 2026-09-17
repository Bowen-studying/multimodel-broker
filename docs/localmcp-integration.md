# LocalMCP integration

Status: **optional adapter**. The broker serves MCP over stdio and Streamable HTTP itself
(`docs/remote-mcp.md`, `docs/decisions/006-transport-layering.md`), so LocalMCP is no
longer on the critical path - it remains a convenient bridge when a hosted relay with a
stable URL is wanted. ChatGPT Pro end-to-end is **not yet verified by a human** - see
`docs/remote-mcp.md`.

## What LocalMCP is (and is not)

LocalMCP is a **bridge**: it lets a ChatGPT cloud conversation reach an MCP server that
runs on this machine. It is not a scheduler, and it is not part of Broker Core.

- The broker is a plain stdio MCP server. Any MCP-capable harness can run it directly
  (MCP Inspector, Codex, Claude Code, Hermes, OpenClaw) without LocalMCP.
- LocalMCP is only needed for the ChatGPT Pro entry point, because ChatGPT cannot open a
  stdio process by itself.

That is why the provider logic, routing and storage live in `src/core` and never in an
MCP transport: replacing the bridge must not touch the Core (task book 4, 14.1).

## Configuration (POC profile)

`config/localmcp.example.json` is the reference. Copy it next to your LocalMCP install and
adjust the path to this checkout:

```json
{
  "features": { "files": false, "shell": false, "processes": false },
  "mcpServers": {
    "multimodel": {
      "enabled": true,
      "command": "node",
      "args": [
        "C:/projects/multimodel-broker/dist/cli/index.js",
        "mcp-stdio",
        "--profile",
        "chatgpt-pro-readonly"
      ]
    }
  }
}
```

Notes:

- `features.files/shell/processes` are switched **off**: the POC only needs the broker's
  own tools, and a bridge should not additionally expose the local filesystem to a cloud
  model.
- The profile decides the tool set. `chatgpt-pro-readonly` exposes
  `ping, list_workers, run_worker, delegate, delegate_batch, get_task, get_trace`.
  `cancel_task` exists only in `local-full`.
- The bridge spawns `dist/cli/index.js`, so run `npm run build` after every change.
- stdout carries MCP frames only; all logs go to stderr (structured JSON).

## Verify without ChatGPT (MCP Inspector)

```bash
npm run build
npx @modelcontextprotocol/inspector node dist/cli/index.js mcp-stdio --profile local-full
```

In the Inspector: **List Tools** must show exactly the profile's tools with the annotations
from `src/interfaces/mcp/annotations.ts`, and calling `run_worker` with
`{"worker":"mock","task":"hello"}` must return a `completed` envelope.

The same wire protocol is covered by an automated test that spawns the real CLI as a child
process (`tests/integration/mcp-stdio.test.ts`).

## Constraints imposed by the bridge

| Constraint | Consequence for the broker |
|---|---|
| Child MCP calls time out after roughly 60 s | Every tool returns within `waitMs` (default 15 s, max 45 s) |
| The relay answers overlapping requests with busy/429 | All internal parallelism happens inside ONE `delegate_batch` call |
| `call_mcp_tool` is a generic entry point, not read-only | The broker's own tools must still be truly read-only, otherwise ChatGPT may refuse them (see below) |
| Public relay traffic passes through a third-party Cloudflare Worker | Public relay: mock / non-sensitive POC only |

Long tasks therefore return `status: "running"` plus a `taskId`; the caller polls
`get_task`. Broker-internal concurrency is proven by
`tests/integration/batch.test.ts` (children run in parallel inside a single call).

## Annotations are never tuned to pass a client filter

Requesting a model call over MCP is declared:

- `readOnlyHint: true` – it only spends compute and returns text: no files, repositories,
  database rows or third-party objects are created, updated or deleted.
- `openWorldHint: true` – it does reach a third-party model API over the network.
- `destructiveHint: false`.
- `idempotentHint: false` – a repeated call runs the model again unless the caller passes
  an `idempotencyKey`.

If ChatGPT Pro refuses `call_mcp_tool` because the parent tool is not read-only, the fix is
a route change (below) – **not** relabelling the parent tool or faking annotations.

## Relay security rules

- The public relay is acceptable only for Mock / non-sensitive POC traffic.
- Never commit the MCP URL, never print it in full in logs (the redactor masks
  credential-bearing URLs).
- The MCP URL is a secret: rotate/re-register it if it leaks.
- Private papers, code and provider output must not travel through an uncontrolled public
  relay. Use a self-hosted Cloudflare Worker or a trusted official tunnel
  (task book 5.2 route 1).

## If the generic proxy is blocked: the two fallback routes

1. **Direct remote MCP endpoint.** Expose the broker's real tools over a remote MCP
   endpoint (official Secure MCP Tunnel, or a self-hosted Worker) so ChatGPT sees the
   broker's own tool definitions and annotations instead of a generic proxy tool. The
   broker needs no change: only the transport in front of it.
2. **Minimal LocalMCP bridge patch.** A separate, minimal fork of LocalMCP that adds a
   restricted read-only proxy (`call_readonly_mcp_tool`): allowlisted child MCPs only,
   only child tools whose current definition has `readOnlyHint === true`, re-checked before
   every call, no shell/file-write, MIT license and upstream notices preserved, and
   maintained outside this repository. Provider logic must never move into that fork.

Record the outcome of the M0 test in your deployment notes before claiming
that the ChatGPT Pro entry point works.
