# R stage - Stable relay

Goal: replace **only the network layer**. The verified Broker Core, providers, task system and
permission model are not touched. Decision record: `docs/decisions/009-stable-relay.md`.

```text
                         ChatGPT Pro
                              |  HTTPS / MCP
                              v
        multimodel-broker-relay.<subdomain>.workers.dev
                              |
                    Cloudflare Worker
                              |
                    Durable Object
                              |
                    outbound WebSocket        (dialled by the local client)
                              |
                     Broker Relay Client
                       /             \
             readonly channel      agent channel
                   |                    |
                 :8789                :8790
       chatgpt-agent              chatgpt-agent
       (write-free config)        (write-capable)
                   |                    |
             DeepSeek/...             Codex
                                       |
                                 local workspace
```

The relay knows `deviceId`, `channel`, MCP request/response frames and connection liveness. It does
not know DeepSeek, Codex, `run_agent`, `taskId`, workspaces or routing.

## Baseline before the migration (measured 2026-09-17, quick tunnels)

`~/.broker-ops/verify-entry.sh <instance> <port>` through the public quick tunnel:

| Instance | Result | Endpoint host at measurement |
| --- | --- | --- |
| m1 (readonly, 7 tools) | 7 PASS / 0 FAIL | `sept-remarkable-hang-benjamin.trycloudflare.com` |
| agent (8 tools incl. `run_agent`) | 7 PASS / 0 FAIL | `labels-removal-grows-script.trycloudflare.com` |

Earlier the same day the agent instance also passed the restart pair (broker restart -> same URL ->
healthz 200 -> MCP handshake). Both hostnames above changed again the same hour, which is the reason
this stage exists. The relay must reproduce **at least** this level of behaviour, and keep the URL
constant while doing it.

## Phases

### R0 - Freeze the transport boundary (done)

Keep 8789/8790 and their separate tokens, SQLite databases, profiles and limits. Quick tunnels keep
running as the fallback. ADR 009 forbids business logic in the relay. Baseline recorded above.

### R1 - Minimal Worker + Durable Object on `workers.dev`

Routes: `/healthz`, device registration, and a Durable Object that owns the outbound WebSocket.
Registration returns:

```text
deviceId
agentConnectionToken
readonlyMcpToken
agentMcpToken
```

Only secrets go to 600 files locally; the repository stores none. The deliverable is the permanent
URL `https://multimodel-broker-relay.<subdomain>.workers.dev`. This phase does **not** connect to the
broker yet.

### R2 - Broker relay client

New module, broker-side, proxying the two existing instances (it does not start a third MCP server):

```text
src/relay/client.ts          orchestrates: registration state -> connection -> forwarding
src/relay/protocol.ts        frame types, encode/decode, invariants (pure, unit-tested)
src/relay/connection.ts      outbound WebSocket, heartbeat, reconnect, outcome_unknown
src/relay/registration.ts    device registration, reading/writing the local 600 credential files
```

The client dials `wss://.../agent/<deviceId>` and declares its two local services:

```text
readonly -> http://127.0.0.1:8789/mcp
agent    -> http://127.0.0.1:8790/mcp
```

Acceptance for the first batch: **`relay client online`** - the Worker sees the device connected, a
`/healthz` on the public URL reports the device online with both channels, and the client survives a
forced WebSocket close by reconnecting (with no request replayed).

### R3 - deployed (readonly channel verified through the public URL)

Worker deployed 2026-09-17: **`https://multimodel-broker-relay.bowen-studying.workers.dev`**
(account subdomain `bowen-studying.workers.dev`; Workers Free plan, SQLite-backed Durable Objects,
no domain and no payment method involved).

Operational facts learned during the deployment:

- **This machine cannot reach `workers.dev` directly** - outbound must go through the local proxy
  (`http://127.0.0.1:7897`), and Node ignores proxy environment variables unless
  **`NODE_USE_ENV_PROXY=1`** is set (verified on Node 22.22.3; undici prints an experimental-agent
  warning that is harmless). `127.0.0.1` must stay in `no_proxy`, because the client forwards to the
  two loopback broker instances. `curl` reads the proxy variables on its own, so "curl works" is not
  evidence that the Node client works.
- The client runs as a systemd **user** service `broker-relay.service` (proxy + `NODE_USE_ENV_PROXY`
  in `~/.broker-ops/broker-relay.env`, mode 600; broker tokens read from their own 600 files).
- `relay setup` refuses to overwrite an existing credential file, so a credential file bound to a
  different origin must be moved aside first (the local workerd test device was archived as
  `~/.broker-relay-device.local-e2e.json`).
- **Proving which hop carried a request**: the broker only ever sees `127.0.0.1` (both the relay
  client and cloudflared terminate locally), so broker logs cannot distinguish the relay from a quick
  tunnel. The relay client therefore logs every forwarded request
  (`forward <method> <channel> -> <status> <ms> requestId=xxxxxxxx`) to `~/.broker-ops/relay.log`; a
  request that appears in both logs (relay forward line + broker `openai-mcp/1.0.0` line) with the
  matching task row in SQLite is the evidence that the relay path was actually used.
- `tsconfig.build.json` now sets `noEmitOnError: true`: `tsc` otherwise **emits JavaScript even when
  it reports type errors**, so one bad build left a broken `dist/` running behind a restarted service
  (symptom: the client connected but every forwarded call failed). Trust the build's exit status, not
  a truncated output tail.
- Fixed defect found while deploying: a **failed** registration used to leave a zero-byte
  `~/.broker-relay-device.json` behind, which the `wx` guard then treated as "already registered".
  `register()` now removes the file when it did not complete.

Acceptance (real output, `scripts/relay-public-check.mjs` - read-only, never calls `run_agent`):

```text
readonly: initialize 200 (serverInfo=multimodel-broker); notifications 200;
          tools/list = 7 (ping, list_workers, run_worker, delegate, delegate_batch, get_task, get_trace);
          ping ok; list_workers reports deepseek;
          run_worker(deepseek) -> RELAY_R3_1B2BC6FF taskId=596c1b5d-…
          usage={inputTokens:72,outputTokens:33,reasoningTokens:21,cacheHitTokens:0};
          SQLite corroborates the same taskId (kind=run_worker, status=completed,
          provider=deepseek/deepseek-flash, trace=9e7b3189-...)
agent:    initialize 200; tools/list = 8 incl. run_agent;
          run_agent annotations readOnlyHint=false destructiveHint=true - not executed
sessions: DELETE 200 on both channels           => 12 PASS / 0 FAIL
```

### Single entry: one connector for delegation and for Codex (2026-09-17)

Requirement: one plugin that can delegate to the API workers *and* drive the local Codex agent,
including modifying files - without changing the public URL.

How it is wired (no Worker change, no URL change, no token change):

```text
existing public URL  /mcp/<deviceId>/readonly/<token>  ->  relay channel `readonly`
                                                              |
                                                    local target override
                                                              v
                                        127.0.0.1:8790  profile chatgpt-agent
                                        providers: codex(workspace-write) + deepseek + glm + mock
                                        => 8 tools: ping, list_workers, run_worker, run_agent,
                                           delegate, delegate_batch, get_task, get_trace
```

- `relay start` accepts `--readonly-target/--agent-target/--readonly-token-file/--agent-token-file`;
  both channels point at the single instance and use its local token. Defaults still implement the
  read/write split, and `resolveTargets()` refuses any target that is not loopback `/mcp`.
- Routing sends plain tasks to a cheap API worker (`general/low_cost -> deepseek`,
  `chinese -> glm`); **Codex is only reached explicitly** via `run_agent` or `worker=codex`, so a
  delegation cannot silently modify files.
- Writing remains a local policy: `sandbox` + `allowWritableSandbox` in the instance config are the
  only switch (helper: `~/.broker-ops/broker-write-mode.sh on|off|status`). With `off`, `run_agent`
  is still visible but every write is refused by the sandbox - the C0 baseline behaviour.
- Naming: the two channels keep honest labels. `.../readonly/<token>` really is read-only (7 tools,
  the 8789 instance); **`.../agent/<token>` is the single daily entry** (8 tools on the 8790 instance,
  including `run_agent`). A first attempt pointed both channels at the write-capable instance, which
  made the `readonly` label lie - reverted once the user allowed a URL change.
- Tool descriptions carry the selection policy so the caller (GPT) decides: `run_worker` names
  `deepseek` for general/cheap work and `glm` for Chinese-first work and says to prefer it when no
  local access is needed; `run_agent` says to use it only when the user's own machine is involved
  (files, commands, tests), and that it is slower and draws on a separate quota.
- Acceptance (real output, `scripts/relay-public-check.mjs --deepseek`): 13 PASS / 0 FAIL, including
  `tools/list = 8 tools ... [single-entry: run_agent visible]`, honest `run_agent` annotations, a
  real `run_worker(deepseek)` whose taskId was corroborated in `data/broker-agent.sqlite`, and a
  relayed `GET -> 200` SSE stream. `run_agent` itself was **not** executed by the checker.

### R3 - agent path write acceptance (verified 2026-09-17)

`NODE_USE_ENV_PROXY=1 node scripts/relay-agent-write-check.mjs` drives `run_agent` through the
PUBLIC agent URL with an **absolute** workspace path, so one run proves the write path and the
"follow what local Codex can reach" workspace policy together. Result: 4 PASS / 0 FAIL, task
`b35de74f-…`.

```text
first reply   status=running in 1520 ms (waitMs=1000 - the request returns before Codex finishes)
task row      run_agent completed 08:08:09.144Z -> 08:08:42.213Z  trace bff427b8-…
session       01a0ae68-…   usage {inputTokens:50288, outputTokens:525, cacheHitTokens:26112}
events        task.created, route.selected, queued, running, run.started, prompt.sent, provider.request
              (sandbox=workspace-write, approvalPolicy=never), tool.event x2 (command_execution),
              note{threadId,timedOut:false}, usage, provider.response, run.finished, task.completed
disk          async-relay.txt = "ASYNC_RELAY_OK" (sha256 a27d0e092519ad11...)
              .async-relay-check = sha256 a27d0e09... ok=true timestamp 2026-09-17T08:08:27Z (inside the run)
              scratch git: only untracked/modified files as expected, commits=1, no remote
relay log     forward POST agent -> 200 1022ms ... plus the relayed GET/SSE and DELETE lines
```

Codex sessions triggered this way are **real Codex threads the operator can see**: the run writes
`~/.codex/sessions/<date>/rollout-...-<sessionId>.jsonl` and the id appears in Codex's own
`thread_history` projection, so it shows up in the app / `codex resume` picker / `codex agents`
(verified for 01a0ad86-... and 01a0ae68-...).

**Regression found while doing this**: attempt 1 failed with
`codex: Reconnecting... 2/5 (request timed out)` and an empty answer. Root cause: the broker
instances had been moved to systemd user units, and a systemd unit does **not** inherit the
`~/.bashrc` proxy exports - while `api.openai.com` is unreachable directly from this network
(direct `000`, via proxy `401`). Manual runs had worked because they inherited the shell. Fixed with
`EnvironmentFile=-/home/<you>/.broker-ops/broker.env` (600, proxy + a `no_proxy` list that
keeps the domestic provider endpoints direct). Note the units' `Environment` property does not show
EnvironmentFile values - read `/proc/<pid>/environ` to verify.

### R3 - ChatGPT chat driving local Codex, verified from the desktop app (2026-09-17)

The user asked the desktop ChatGPT conversation (connector: Multimodel Broker) to create a file on
this machine. The model's summary is not evidence, so the four layers were checked:

```text
task        0f604041-…  kind=run_agent  completed
            request: workspace="scratch", waitMs=45000, idempotencyKey="chat-co..."
            run 09:48:51.044Z -> 09:49:10.036Z, session 01a0aec4-e238-74b0-a...
            usage {inputTokens:33248, outputTokens:184, cacheHitTokens:26112}
            events task.created, route.selected, queued, running, run.started, prompt.sent,
                   provider.request, tool.event x2, note, usage, provider.response,
                   run.finished, task.completed
broker log  run_agent start 09:48:51.043 -> end 200 in 19004ms, user-agent openai-mcp/1.0.0
relay log   forward POST agent -> 200 19005ms requestId=d80769fb   (the 19s forwarded call)
disk        /home/<you>/broker-scratch/chat-codex-test.txt
            2 bytes, content "ok", sha256 2689367b205c16ce..., scratch repo commits still 1
```

Two details worth keeping: the model chose **waitMs=45000** so the tool call blocked until Codex
finished (~19 s) and returned the answer inline, and it supplied an **idempotencyKey** on its own.
The Codex that executed was **ours (WSL)** — the Codex application's own instance is not reachable
from outside (private stdio child, no port, and `app-server daemon` is Unix-only).

### R3 - ChatGPT verified through the relay (read-only channel)

Three logs, one request, matched by hand on 2026-09-17 (the decisive check that this traffic really
went through the relay and not a leftover quick tunnel):

```text
relay.log    (client, ~/.broker-ops/relay.log)
  forward POST readonly -> 200    7ms  requestId=c042e167     <- initialize
  forward POST readonly -> 202    4ms  requestId=9a9da6ce     <- notifications/initialized
  forward GET  readonly -> 200    3ms  requestId=ecd5e307     <- server->client SSE stream
  forward POST readonly -> 200  121ms  requestId=fa7cff55     <- tools/call list_workers
  forward POST readonly -> 200  531ms  requestId=60bfe8c4     <- tools/call run_worker

broker log   (readonly-broker.log, user-agent openai-mcp/1.0.0)
  07:45:41.575 initialize 200 5ms | 07:45:41.984 notifications 202 |
  07:45:42.467 tools/call run_worker -> 200 528ms

SQLite       (data/broker.sqlite)
  task dcdbb069-…  kind=run_worker completed
       07:45:42.469Z -> 07:45:42.982Z  trace c2ec1093-…
  run  73d04aad-…  deepseek/deepseek-flash completed
       usage {inputTokens:69, outputTokens:22, reasoningTokens:13, cacheHitTokens:0}
  answer "RELAY_CHATGPT_OK_2"
  evidence provider.response_id c6c62211-…
```

Every identifier above also appears in the envelope ChatGPT returned to the user, so the claim
"ChatGPT reaches DeepSeek through the relay" now rests on the broker's own store rather than on a UI
transcript. Note the relayed `GET -> 200`: the cloud client's server-to-client SSE stream survives
the relay, which is why the standard session model keeps working.

### R3 - readonly first, then agent

Public URLs keep the permission split visible:

```text
/mcp/<deviceId>/readonly/<readonlyToken>
/mcp/<deviceId>/agent/<agentToken>
```

Readonly must reproduce M0/M1 (`ping` -> `list_workers` -> DeepSeek). Only then the agent URL gets a
minimal scratch `run_agent`, re-checked the same way as C4 (disk change, real test run, SQLite
`taskId`/`traceId`/usage, honest mutating annotations). Quick Tunnel is demoted to fallback only
after this passes.

### R4 - Transparent transport

Not "a POST got through", but the behaviour already verified locally: `POST`/`GET`/`DELETE`,
`MCP-Session-Id`, `MCP-Protocol-Version`, response status codes, SSE/streamed responses, body size
limits, `401`/`429`. The frame protocol uses `requestId` multiplexing and response **chunks** from the
start, so SSE and large answers do not force a protocol redesign later.

### R5 - Reliability and write safety

Four fault experiments: relay client restart, 8789/8790 restart, WSL/PC restart, and a temporary
WebSocket drop. Acceptance: the public URL never changes and the ChatGPT connector needs no edit
after recovery. For `run_agent`: never replay a request that may already have executed - answer
`outcome_unknown` and let the caller recover via `idempotencyKey`/`taskId`.

### R6 - Productised installation (last)

```bash
multimodel-broker relay setup|start|status|stop
```

Target experience for a new user: clone -> `codex login` -> fill the DeepSeek key (optional) ->
configure a workspace -> `relay setup` -> two fixed MCP URLs -> add to ChatGPT. No domain, no
Cloudflare Tunnel knowledge.

## Protocol principles fixed now

- **Capability URLs, not broker tokens.** The public credential authorises entry to one channel; the
  local `BROKER_HTTP_TOKEN` stays on loopback and is attached by the relay client.
- **Channels stay independent.** Two credentials, two URLs, two profiles - never merged into one
  because a single Worker serves both.
- **`requestId` multiplexing + chunked responses + heartbeats** from the first implementation.
- **`outcome_unknown` instead of blind replay** for anything that may have side effects.
- **The relay's own health is observable** without reading broker internals.

## Exit criteria

```text
fixed workers.dev URL                 [x]
readonly -> 8789                      [x]
agent -> 8790                         [ ]
MCP sessions / headers / SSE          [x] (sessions + a relayed GET/SSE stream; full status matrix in R4)
ChatGPT -> DeepSeek                   [ ]
ChatGPT -> Codex write                [ ]
automatic reconnect after a drop      [ ]
URL survives a PC restart             [ ]
no blind replay of write requests     [ ]
Quick Tunnel no longer the main path  [ ]
```

After this stage: `remotePolicy` -> C4.5 -> real daily use. C6 (hour-scale durable recovery) is
designed after real use, not before.
