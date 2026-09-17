# 009 - Stable relay as the network layer

- Status: accepted (2026-09-17)
- Supersedes: nothing (adds a layer); refines the "stable endpoint" decision in
  `docs/stable-endpoint.md`, which remains the fallback path.

## Context

The broker core, both provider paths, the task system and the write permissions are verified
(Gate 2 / C4, C5). The weak part is the public path: Cloudflare **quick tunnels** get revoked
server-side and hand out a new random hostname each time, so the ChatGPT connectors have to be
edited by hand.

Two stable options were considered:

1. **Cloudflare named tunnel** - fixed hostname, but it requires a **domain in a Cloudflare
   account** (plus `cloudflared tunnel login`). Rejected *for now*: the account has no domain, and
   buying/ migrating one is a detour that also drags in NS propagation.
2. **Own relay** - a Cloudflare Worker + Durable Object on `workers.dev` (free, **no domain**, fixed
   URL). The local side dials **outbound** over WebSocket, so nothing has to be exposed on the
   local machine. This is what LocalMCP does for its own bridge.

Decision: build the relay (R stage). The named tunnel stays documented as the cheaper variant once
a domain exists, and quick tunnels stay alive as a development fallback until the relay passes R3/R4.

## Decision

The relay is **transport only**. It replaces the quick-tunnel hop; it does not replace or extend the
broker.

```text
ChatGPT Pro -> https://<worker>.workers.dev -> Worker + Durable Object
                                                     | outbound WebSocket (dialled by the local client)
                                                     v
                                            Broker Relay Client (this repo)
                                              /                    \
                                   readonly channel            agent channel
                                         |                          |
                                  127.0.0.1:8789              127.0.0.1:8790
                                chatgpt-pro-readonly          chatgpt-agent
```

### Boundary rules (hard)

The relay, its Worker, its Durable Object and its storage may know only:

```text
deviceId · channel (readonly | agent) · MCP HTTP request/response frames · connection liveness
```

They must never learn or carry: worker/provider identity, routing rules or `requirements`,
`taskId`/`traceId` semantics, workspace names or paths, `run_agent` semantics, task status, usage or
cost. No routing, no retries of business calls, no queueing of anything it does not understand.
Consequence to preserve: the network layer can be swapped (named tunnel, another provider, self-hosted
relay) without touching `src/core`, `src/providers`, `src/storage` or the profiles.

### Two credentials, never one

| Credential | Lives | Purpose |
| --- | --- | --- |
| `agentConnectionToken` | local 600 file | authenticates the **local client**'s outbound WebSocket to its device |
| `readonlyMcpToken` | local 600 file + ChatGPT connector URL | public credential for the readonly channel |
| `agentMcpToken` | local 600 file + ChatGPT connector URL | public credential for the agent channel |
| `BROKER_HTTP_TOKEN` (per instance) | local 600 file only | authenticates relay -> `127.0.0.1:878x`; the relay client attaches it, the public never sees it |

Rotating a leaked public token must not require touching the broker's local tokens, and the two
channels must stay independently revocable. This is the reason the two broker instances stay
physically separate (own token, own SQLite, own profile) instead of becoming one channel set behind
one credential.

### No blind replay

A write request that was already forwarded to the local broker and whose outcome became unknown when
the WebSocket dropped must **not** be re-sent. The client answers `outcome_unknown`; recovery is the
caller's job through the broker's own `idempotencyKey` / `taskId`. Reconnect logic may re-establish
the connection and re-deliver *undelivered* frames only.

### Out of scope for the R stage

DeepSeek-as-agent, the supervisor/M3 work, C6 durable recovery, cost policy, and anything from
LocalMCP's file/shell/process/skills surface. R only moves the network layer.

## Consequences

- A second deployable appears: `relay/` (Cloudflare Worker + Durable Object, own `package.json`).
  The broker itself keeps its zero-runtime-dependency property; the relay's toolchain (wrangler,
  workerd) lives only in that subproject.
- A new failure domain exists and must be observed (heartbeat, `relay status`, worker logs). The
  relay can be the reason a call fails, so its own liveness has to be visible without reading broker
  internals.
- Deployment now needs a Cloudflare account (free) and `wrangler login` - still no domain purchase.
- `docs/stable-endpoint.md` (named tunnel) stays valid as an alternative, blocked only on a domain.
