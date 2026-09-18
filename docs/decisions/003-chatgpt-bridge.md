# 003 – ChatGPT Pro bridge: LocalMCP now, direct remote endpoint preferred later

Status: accepted (2026-09-16) - **the ChatGPT Pro path is NOT verified yet**

> Partly superseded by **010**: the `chatgpt-pro-readonly` profile name used below no longer exists;
> a read-only remote entry point is now a config choice (that instance enables no write-capable
> worker) and the remaining profiles are `chatgpt-agent` (default) and `local-full`.

## Context

ChatGPT Pro (developer mode) currently guarantees read/fetch MCP capability. Whether
it will call a model-delegation tool through LocalMCP's generic `call_mcp_tool`
proxy - which is annotated as possibly writing, executing commands and accessing the
network - is an empirical question (see `docs/remote-mcp.md`).

## Decision

1. The broker runs as a **plain stdio MCP server** with a `chatgpt-pro-readonly`
   profile that exposes only read/compute tools and no `cancel_task`.
2. LocalMCP is used as a **replaceable bridge**, configured with
   `features.files/shell/processes = false`, pointing at
   `dist/cli/index.js mcp-stdio --profile chatgpt-pro-readonly`
   (`config/localmcp.example.json`).
3. **No annotation is ever changed to get past a client filter.** If the parent
   proxy tool is refused, the answer is a different route, not a faked hint.
4. Fallback routes, in priority order:
   - **Route 1**: expose the broker over a direct remote MCP endpoint (official Secure
     MCP Tunnel or a self-hosted Cloudflare Worker) so ChatGPT sees the broker's real
     tools and annotations. No broker code change.
   - **Route 2**: a separate, minimal LocalMCP fork adding a restricted read-only
     proxy (`call_readonly_mcp_tool`): allowlisted child servers only, only child
     tools whose current definition has `readOnlyHint === true` (re-checked before
     every call), no shell, no file writes, MIT license and upstream notices kept,
     maintained outside this repository. Provider logic must never move into it.
5. Core development continues regardless of the M0 outcome: the broker is verified
   through local harnesses (MCP Inspector, the stdio tests, the CLI, the acceptance
   scripts) while the ChatGPT Pro entry point is marked `blocked/unverified`.

## Status

- Broker side: implemented and locally verified over stdio.
- ChatGPT Pro side: **unverified**. The result table in
  the M0 record is kept outside this repository; only a human running the protocol can
  fill it in. Until then, no claim is made that the ChatGPT Pro entry point works.
