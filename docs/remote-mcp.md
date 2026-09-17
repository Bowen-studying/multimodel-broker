# Remote MCP (cloud clients)

The broker serves MCP itself, twice:

    stdio  ->  local harnesses (Codex, Claude Code, Hermes, OpenClaw, MCP Inspector)
    http   ->  cloud clients (ChatGPT connectors) and anything that cannot spawn a process

Both interfaces sit on the same `Broker` object and the same profile registry, so a tool
exists once and is reachable both ways. Adding the HTTP transport changed nothing in
`src/core`, `src/providers` or `src/storage` (see `docs/decisions/006-transport-layering.md`).

## Run it

```bash
export BROKER_HTTP_TOKEN="$(openssl rand -hex 24)"   # the endpoint's shared secret
node dist/cli/index.js mcp-http --profile chatgpt-pro-readonly --port 8789
```

Defaults and flags:

| Flag | Default | Meaning |
|---|---|---|
| `--host` | `127.0.0.1` | Bind address. Loopback keeps the tunnel/relay local; anything else is a warning-worthy decision. |
| `--port` | `8789` | `0` picks a free port (used by tests). |
| `--path` | `/mcp` | MCP endpoint path. `/healthz` is always served. |
| `--profile` | `chatgpt-pro-readonly` | Tool set. This profile has no `cancel_task`. |
| `--token-env` | `BROKER_HTTP_TOKEN` | Name of the variable holding the secret. Empty + no `--allow-anonymous` = refuse to start (exit 2). |
| `--max-rpm` | `60` | Sliding-window request budget for the MCP path; over budget = `429` + `Retry-After`. |
| `--max-concurrent` | `4` | Requests handled at once; over = `429` (`busy`). |
| `--sse` | off | Answer with an SSE stream instead of plain JSON. |

Authentication accepts the secret as `Authorization: Bearer <token>`, as an
`x-broker-token` header, or as `?token=<token>` - the last one exists because a cloud
client can only be handed a URL. The transport uses the standard **stateful session**
model: `initialize` returns an `mcp-session-id`, later POSTs carry that header, `GET` opens the
server-to-client SSE stream and `DELETE` ends the session (a *missing* session header is `400`,
an *unknown* or expired one is `404`).

Two deliberate compatibility behaviours sit in front of that (both are deviations from the
strict spec, taken because a cloud client's availability probe is unforgiving):

- **A `GET` with no session header gets `200 text/event-stream`** and an idle stream (capped at 8,
  each closed after 30 minutes idle) instead of the spec's `400`. ChatGPT's probe
  (`Python/3.14 aiohttp`) opens the endpoint before initializing, and while it received errors the
  app was marked *unavailable*.
- **A `POST` whose `Accept` header is not the strict `application/json, text/event-stream` pair is
  accepted anyway** (the header is normalised before it reaches the transport, which would answer
  `406`). We only ever emit JSON or SSE, so there is nothing to negotiate.

`server/discover` (mandatory since protocol revision `2026-07-28`, which replaced the
`initialize` handshake with per-request metadata) is answered in this transport layer, because the
installed SDK only speaks the legacy era. The answer follows the spec's version negotiation:

| Client asks for | Answer |
|---|---|
| `2026-07-28` (or any version we do not implement) | `400` + `-32022 UnsupportedProtocolVersionError` with `data.supported = ["2025-11-25", …, "2024-10-07"]` |
| one of the legacy versions | `200` + `DiscoverResult` (`resultType`, `supportedVersions`, `capabilities`, `serverInfo`, `instructions`) |

Answering a modern client with a *successful* result that lists only legacy versions is worse than
an error: ChatGPT's connector creation then fails with "Something went wrong" (observed
2026-09-17), where a `400` made it downgrade to `initialize` and succeed. A full dual-era server
(no handshake, `_meta` per request) is not implemented - see `docs/known-limitations.md`. A stateless variant was tried first and looked fine against the SDK client and `curl` -
but a real cloud client also opens the `GET` stream, and answering `405` there is exactly what
makes it report the app as unavailable.

## Verify locally (no money spent)

```bash
curl -s http://127.0.0.1:8789/healthz          # {"status":"ok",...} - no token needed
npm test -- tests/integration/mcp-http.test.ts # 12 checks: auth, budget, tools, real round trip
```

The integration test speaks to the real HTTP listener with the official SDK client, so a
green run means the wire format is right - not that ChatGPT likes it.

## How a cloud client reaches a loopback listener

| Option | What it needs | Status here |
|---|---|---|
| **Official Secure MCP Tunnel** (`openai/tunnel-client`) | A Platform `tunnel_id` + runtime API key, Platform org permission `Tunnels Read+Manage`, and ChatGPT developer mode. Outbound-only, no public port. | **Not usable yet**: a ChatGPT subscription alone is not a Platform account. |
| **Cloudflare quick tunnel** (`cloudflared tunnel --url http://127.0.0.1:8789`) | Nothing but the binary. Gives an `https://*.trycloudflare.com` URL that **changes on every restart**. | Not installed on this machine yet. |
| **Own relay** (`packages/relay`, not built) | A Cloudflare account + the project's own Worker and agent. Stable URL, nothing third-party except Cloudflare's edge. | Planned - this is where LocalMCP's MIT code may be reused (`docs/decisions/006-transport-layering.md`). |
| **LocalMCP** | Its own install + its hosted Worker. | Optional adapter, no longer on the critical path. |

## First connection (POC) checklist

The first ChatGPT connection must not be able to spend real provider quota, so it runs
against `config/providers.mock.yaml` (MockProvider only) with a throwaway token:

```bash
# 1. Broker, mock-only, loopback
export BROKER_HTTP_TOKEN="$(openssl rand -hex 24)"
node dist/cli/index.js mcp-http --config config/providers.mock.yaml --port 8789
#    or: npm run mcp:http:mock

# 2. In a second shell: expose it. The URL is the secret, so do not paste it into a chat
#    that leaves this machine without knowing that.
cloudflared tunnel --url http://127.0.0.1:8789
#    -> https://<random>.trycloudflare.com   (rotates on every restart)

# 3. Sanity-check the public URL from outside the listener's process, then add it in
#    ChatGPT as a custom connector: https://<random>.trycloudflare.com/mcp?token=<token>
#    (Authentication: No authentication.)
```

What to record in your own deployment notes: which path was used, the raw answer
to `ping` / `list_workers` / `run_worker(mock)`, and any error text verbatim. Then:

```bash
# 4. Stop the tunnel (Ctrl-C) and rotate: the token in a leaked URL is dead weight.
unset BROKER_HTTP_TOKEN    # generate a new one next time
```

Only after that has been recorded as `verified` should the real-provider config be used,
and only after the remote cost policy (`docs/known-limitations.md` item 8) exists should
the endpoint stay up for longer than a manual test.

### ChatGPT connector

1. Settings -> Apps -> Advanced settings: enable developer mode (paid plans).
2. Settings -> Connectors: create a custom connector.
3. Type: MCP; Authentication: **No authentication** (ChatGPT can send OAuth 2.1 or nothing;
   it cannot send a plain bearer token, which is why the secret rides in the URL);
   URL: the tunnel URL plus `?token=<the secret>`.
4. Then run the M0 protocol: list the servers and tools, then call `ping` and `list_workers`,
   and record the raw answers or errors in your own deployment notes.

Until that has actually been done by a human, the ChatGPT entry point stays **unverified**.
Status 2026-09-17: **verified for the mock path** (M0), recorded in the project's deployment
notes. A real provider has not been reached from ChatGPT yet.

## Security rules (they are not optional)

- The endpoint URL carries the secret: treat it as a credential, never commit it, never
  print it in full, rotate it if it leaks.
- Public exposure = exposing **money**: every `run_worker`/`delegate` spends provider
  quota. Keep the read-only profile, keep the request budget small, and stop the listener
  when you are not testing.
- A tunnel or relay sees MCP requests in plaintext (they terminate TLS). Do not send
  private papers, code or personal data through a path you do not control; use mock or
  non-sensitive material while the path is still being proven.
- `/healthz` is deliberately unauthenticated and returns no task data and no secret.
- The HTTP endpoint refuses to start without a token unless `--allow-anonymous` is passed
  explicitly - and that flag exists for throwaway local tests only.
