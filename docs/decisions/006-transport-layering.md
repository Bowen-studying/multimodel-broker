# 006 - Two transports, one core, and LocalMCP as an optional adapter

Status: accepted (2026-09-17). Supersedes nothing; extends 001 (broker core separation).

## Context

The broker was built as a stdio MCP server, which is enough for local harnesses
(Codex, Claude Code, Hermes, OpenClaw, MCP Inspector) but not for ChatGPT, which can
only speak to a remote HTTPS MCP endpoint. The first plan borrowed LocalMCP - an
external bridge with its own hosted Cloudflare Worker - for that hop.

Two things changed:

1. The project goal moved from "prove that GPT Pro can orchestrate other models" to
   "own a multi-harness model broker". The hop is part of the product, not a rental.
2. The installed `@modelcontextprotocol/sdk` already ships
   `StreamableHTTPServerTransport`, so the transport is not something that has to be
   invented, borrowed or vendored.

## Decision

1. The broker serves MCP over **two transports**: `mcp-stdio` (local, process-spawned)
   and `mcp-http` (Streamable HTTP, loopback + shared secret).
2. Both transports build the **same** `McpServer` from the same profile registry
   (`src/interfaces/mcp/{profiles,tools,annotations}.ts`). Transport files contain
   transport, authentication and guard rails only - never routing, provider or storage
   logic. The stateless HTTP mode is safe precisely because all task state lives in the
   store, not in the transport.
3. LocalMCP is downgraded from "the ChatGPT entry point" to an **optional compatibility
   adapter**. Nothing in the critical path imports or requires it.
4. Reuse policy for third-party bridge code (task book 14.1):
   - Prefer the MCP SDK's own primitives over copied code - the SDK is already a
     dependency and is maintained upstream.
   - If LocalMCP (or another MIT bridge) code is genuinely needed for the future relay,
     copy only the necessary bridge component, preserve its MIT `LICENSE` and copyright
     headers, record the upstream version/commit, extend `THIRD_PARTY_NOTICES.md`, and
     keep it out of `src/core`.
   - Never move provider logic into a bridge or a fork.

## Consequences

- Adding `mcp-http` touched no file in `src/core`, `src/providers` or `src/storage`.
- The remaining problem is reachability, not protocol: a loopback listener still needs a
  tunnel or a relay to be reachable from ChatGPT. The official Secure MCP Tunnel solves
  that plus authentication, but it requires a Platform account with tunnel permissions -
  a ChatGPT subscription alone is not one. So the project's own relay remains a
  candidate, and until one path is proven the ChatGPT entry point stays **unverified**.
- Anyone who can reach the HTTP endpoint can spend provider quota, so the endpoint is
  loopback-bound by default, token-guarded, request-budgeted, and limited to the
  read-only profile.
