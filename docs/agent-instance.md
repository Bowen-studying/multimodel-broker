# Running the write-capable (agent) instance

The write path lives in its own broker process, its own token and its own database. The read-only
instance is never switched to the agent profile: two connectors, two blast radii.

| | Read-only instance | Agent instance |
|---|---|---|
| Port | `8789` | `8790` |
| Profile | `chatgpt-pro-readonly` (7 tools) | `chatgpt-agent` (9 tools, adds `run_agent` + `run_claude_code`) |
| Token | `~/.broker-m1-token` | `~/.broker-agent-token` |
| Config | `config/providers.yaml` | `config/providers.agent.yaml` (see `providers.agent.example.yaml`) |
| Database | `data/broker.sqlite` | `data/broker-agent.sqlite` |
| Workers | mock + deepseek + glm | codex, codex-win, claude-code, deepseek, glm, mock |
| Workspaces | broker repo + scratch | **scratch only** |
| Limits | 30 req/min, 4 concurrent | 20 req/min, **1 concurrent**, batch max 1 |
| Connector name | `Multimodel Broker` | `Multimodel Broker Agent [DEV]` |

Why a separate database: read-only history and write history answer different questions ("what did
a model say" vs "which command changed which file"). Keeping them apart means an audit of the
agent entry point never has to filter anything out.

## Start

```bash
cd ~/projects/multimodel-broker
npm run build
BROKER_HTTP_TOKEN="$(cat ~/.broker-agent-token)" \
  node dist/cli/index.js mcp-http \
    --config config/providers.agent.yaml --profile chatgpt-agent \
    --port 8790 --max-rpm 20 --max-concurrent 1
```

Publish it (a quick tunnel URL changes whenever cloudflared restarts; the supervisor republishes
the URL to `~/.broker-agent-connector-url` and the Windows clipboard):

```bash
bash ~/.broker-ops/broker-tunnel-supervisor.sh agent 8790 ~/.broker-agent-token
```

## Stop

```bash
# Bracket the dots: a bare `pkill -f providers.agent.yaml` also matches the pkill command
# itself and kills the shell running it.
pkill -f 'providers[.]agent[.]yaml'
pkill -f 'broker-tunnel-supervisor[.]sh agent'
```

## Preflight before any ChatGPT test

```bash
bash ~/.broker-ops/broker-call.sh "$(cat ~/.broker-agent-connector-url | sed 's|/mcp?token=.*||')" \
  "$(cat ~/.broker-agent-token)" list_workers '{}'
```

Expected: one worker (`codex`, `healthy: true`), and `healthz` reporting `profile: chatgpt-agent`
with 8 tools. A `run_agent` call with an unknown workspace must come back `PATH_NOT_ALLOWED`, and
`runs` in `data/broker-agent.sqlite` must stay empty for rejected calls - a path rejection is not a
provider call.

## Two local harnesses, one connector (`run_agent` vs `run_claude_code`)

Both write for real, so both carry `readOnlyHint: false` and both are their own tool - a write
capability is never folded into a read-only tool. They differ in which local agent does the work:

| | `run_agent` | `run_claude_code` |
|---|---|---|
| Runtime | local Codex (`codex`, `codex-win`) | local Claude Code CLI on DeepSeek |
| Cost | Codex subscription quota | ~$0.0002-0.005 per run, measured |
| Answers | Codex's reply + trace events | reply + audit line (files, commands, cost) |
| Speed | minutes | seconds for a small edit (3-4 s measured) |

The router refuses write-capable adapters (`WRITE_CAPABLE_ADAPTERS` in `src/core/types.ts`), so
`run_worker` and `delegate` can never be a back door into either one - naming `codex` or
`claude-code` there comes back as a failed task that points at the right tool.

### Verified: run_claude_code → disk (Track 2, 2026-09-17)

Driven over MCP against the real instance, then checked on disk (the only evidence that counts):

```
marker : TRACK2_ACCEPT_fbf82d09   (unique random marker)
wall   : 3s
envelope: ok=True status=completed
worker  : claude-code | reason: Explicit worker requested by caller
result  : status=completed model=deepseek-flash sessionId=bfb786ea-…
usage   : {"inputTokens": 292, "outputTokens": 120, "cacheHitTokens": 24448, "cost": 0.000378}
evidence: [{"type":"file_touched","content":"track2-acceptance.txt","source":"Write"}]
file    : EXISTS size=23 sha256=a1888fc6c53cff7e ; content == marker
```

`cacheHitTokens` that high is the whole point of the harness being affordable: every turn re-sends
~24k tokens of fixed overhead, and DeepSeek's automatic prefix cache serves it at 1/50 of the input
price. `cost` is our own token-based estimate (peak pricing, therefore an upper bound); Claude Code's
own `total_cost_usd` is priced with Anthropic's table (~500x the real charge) and is never shown as
the bill.

Two environment traps this worker hit on first use, both now closed:

- **`spawn node ENOENT`** under systemd: the service PATH has no `node`. The provider spawns the
  runner with `process.execPath` (the Node running the broker), overridable with `options.nodeBinary`.
- **`claude` not on the service PATH**: the CLI lives in `~/.hermes/node/bin`, which a service
  manager does not know. Pin `options.claudeBinary` (the runner also falls back to asking a login
  shell). The runner reports its own startup failure as JSON, so the reason reaches the caller.

## Verified: ChatGPT → run_agent → disk (Gate 2, 2026-09-17)

Two ChatGPT runs were executed against this instance; the second is the recorded one because the
first exposed a real defect.

| Layer | Evidence |
|---|---|
| MCP | `tools/call run_agent` from `user-agent: openai-mcp/1.0.0`, HTTP 200, 41,830 ms (session `489e52b6…`) |
| Broker DB | task `ae09f3b4-…`, `completed`, trace `3ee053c9…`, session `01a0ad86-…`, usage `{inputTokens:69132, outputTokens:663, cacheHitTokens:60288}` |
| Codex trace | 5 × `tool.event` (`command_execution`), including the `python3 - <<PY …` that rewrote line 2 and the `node check.mjs hello.txt CODEX_CHATGPT_E2E_OK` verifier; `provider.request` records `sandbox=workspace-write`, `networkAccessEnabled=false`, `webSearchMode=disabled`, `approvalPolicy=never` |
| Disk | `hello.txt` line 2 = `CODEX_CHATGPT_E2E_OK` (sha256 `f327a0f1…` → `bcbe9606…`), line 1 unchanged, `.check-ran` = `ran=2026-09-17T04:01:17.877Z ok=true`, `git status` = exactly `M hello.txt` + `?? .check-ran`, commits 1 → 1, no remote, nothing outside the workspace changed |

Two findings worth keeping:

- **The first run had no tool events at all.** The adapter used buffered execution unless the caller
  asked for `verbose`; ChatGPT does not, so a run that really edited a file produced an empty audit
  trail. Fixed in `d6dc514`: the Codex adapter always streams, and `traceLevel` only filters the
  *read* view. Do not reintroduce a level-dependent audit path.
- **A write can be audited as `command_execution` instead of `file_change`.** When the agent edits
  through a shell command, Codex reports it as a command, not as a patch item. A checker that
  requires `file_change` specifically will report a false failure on that shape.

## Verified: task lifetime ≠ request lifetime (C5, 2026-09-17)

`node scripts/codex-async-scenario.mjs` builds a deterministic >1 s task (the fixture command
sleeps 9 s), calls `run_agent` with `waitMs: 1000`, makes **no MCP requests at all for 40 s**, and
only afterwards polls `get_task` once. 19/19 checks:

```text
call      : status=running  taskId=c9c57de1-…  roundtrip=1576 ms
no-poll   : 04:50:52.086Z → 04:51:32.134Z   (zero MCP requests; 40 s)
marker    : started 04:51:00.777Z  finished 04:51:09.783Z  ok=true   ← inside the window
run       : started 04:50:50.840Z (with the request, before the client held the response)
            finished 04:51:15.945Z (23.9 s of work after the response)
task row  : completed 04:51:15.963Z   → 16.2 s BEFORE the first poll
first poll: 04:51:32.134Z → status=completed, with results
store     : runs=1  session=01a0adb4-…
            usage {inputTokens:33260, outputTokens:126, cacheHitTokens:32768}
```

So: the request returned while the task was still running, 40 s passed with nobody asking anything,
the workspace command ran to completion in that silence, and the task had finished 16 s before the
first poll ever went out. Polling does not drive execution.

What it does **not** prove: anything about a broker/WSL/PC restart - that is v0.2 (`resumeThread`,
durable recovery).

Three things the experiment exposed:

- **Window length matters.** With a 25 s window the "completed before the first poll" comparison
  degenerated into a sub-second clock race (the completion row write landed 0.55 s after the client's
  send timestamp even though the poll response already said `completed`). The window is now 40 s,
  which puts completion ~16 s inside it. Assert on the window, not on a coincidence.
- **Completion lags the file work.** The task and `runs` rows are written when the provider returns,
  i.e. after Codex finishes composing its answer - tens of seconds after its edits landed (run 3:
  marker finished 04:39:00, task completed 04:39:07; run 4: no `runs` row existed yet at the poll).
- **Quick tunnels revoke mid-run.** 3 of 7 attempts lost the tunnel. The script now hot-swaps to the
  republished URL and sends an `idempotencyKey`, so a retry can never start a second agent run; the
  supervisor probes the public URL instead of trusting that the process is alive, and it no longer
  mistakes `api.trycloudflare.com` for a tunnel hostname.

## `codex-win`: the Windows Codex build (registered 2026-09-17)

A second local-agent worker, `codex-win`, runs the Codex that ships inside the Windows
ChatGPT/Codex desktop app instead of this machine's own Codex:

| Setting | Value |
|---|---|
| `adapter` | `codex-sdk` (same adapter as `codex`) |
| `options.codexPath` | `C:\Users\<you>\AppData\Local\OpenAI\Codex\bin\codex.exe` (the app's bundled binary, reached from WSL as `/mnt/c/...`) |
| `options.windowsPaths` | `true` - a `/mnt/<drive>/...` workspace is translated to `<DRIVE>:\...` before it is handed to the child process |
| workspace | `win-scratch` → `/mnt/c/Users/18821/Documents/gpt-codex-bridge-scratch` |
| policy | `workspace-write`, `approvalPolicy: never`, no network, no web search, `maxConcurrency: 1` |
| `options.skipGitRepoCheck` | `true` - the Windows workspace is not a git repo, so verification there is file-level (content + hashes), not git-based |

Why: the binary writes its sessions into the Windows store (`C:\Users\<you>\.codex`), the same
store the app lists, so a run started here lands in that history. `broker-write-mode.sh` now flips
`codex` and `codex-win` together, so "writes off" means both are read-only.

Verified so far:

- `doctor` reports `codex-win [enabled] adapter=codex-sdk ... healthy=ok` with
  `codexPath=[REDACTED].exe` / `windowsPaths=true`, and `win-scratch -> [ok]`.
- Both stores carry a live login (`~/.codex/auth.json` on this side,
  `/mnt/c/Users/18821/.codex/auth.json` on the Windows side). The broker reads none of them: the
  child process uses its own login, exactly like the `codex` worker.
- The Windows binary answers the app-server probe from WSL: `initialize` returns
  `codexHome=C:\Users\<you>\.codex`, `platformOs=windows`; `thread/list` returns the 25 threads
  the app shows; `model/list` works.

Verified 2026-09-17 with a real call (`run_agent(worker="codex-win", workspace="win-scratch")`):
the run did drive the Windows binary - the session landed in the Windows store
(`C:\Users\<you>\.codex\sessions\2026\09\17\rollout-...jsonl`, `cwd` =
`C:\Users\<you>\Documents\gpt-codex-bridge-scratch`, `cli_version` 0.153.4, `sandbox` =
workspace-write, `approval_policy` = never). That run then **failed**:
`PROVIDER_ERROR: codex-win: Reconnecting... 2/5 (stream disconnected before completion: ... os error
10061)`. Root cause is the Windows build's WebSocket transport on this network: the plain CLI prints
`Reconnecting... 5/5` and then `Falling back from WebSockets to HTTPS transport` and succeeds, but the
SDK-driven path aborted before that fallback. It is not the proxy (reproduced with all proxy variables
unset) and not a config error - `responses_websockets`/`responses_websockets_v2` are `removed` feature
flags, so the transport cannot be pinned to HTTPS from here. Treat `codex-win` as experimental; the
`codex` worker (0.154.0 on this side) has been reliable.

### The Codex app's own list will not show these sessions

The app lists threads through the app-server's `thread/list`, whose default is documented as
"interactive sources only". Measured on the Windows store: the default answer is 50 threads, all
`source: vscode`; an `exec` filter returns the externally started ones (`... = 6 条`), and they are
absent from the default list. Creating the session through the app-server instead does not help:
`thread/start` (+ a started `turn`) produced a thread that appeared in **no** bucket the default list
uses - not under `cli`, `vscode`, `appServer`, `subAgent` or `unknown` - and it stayed absent when the
app-server was launched with the app's own flags (`--analytics-default-enabled -c
features.code_mode_host=true -c plugins.codex-app-tools@openai-bundled...`) or when `threadSource` was
passed as `cli`/`vscode`. Conclusion: a session started by any client other than the app itself is
recorded (rollouts, `codex resume <id>`) but never listed in the app, so "GPT triggers it, I watch it
in the app" is not reachable through these surfaces. What remains for approvals and progress in the
app is a session the app (or the phone's Remote) starts itself.

### Who picks the model

`run_agent` takes an optional `model` (a plain identifier, validated before it reaches a child
process). Omitted or `"auto"` means the configured default - and with `model: "auto"` in the worker
config, that is whatever the Codex client itself is configured with, i.e. the model shown in the
Codex app (`gpt-6-astra` here). A value like `gpt-5.6-luna` is passed straight through to the CLI's
`--model`, and the run fails with the provider's own message if the signed-in account does not offer
it - which is exactly what happened when this was probed with `gpt-5.3-codex-spark`:

```text
ERROR: {"detail":"The 'gpt-5.3-codex-spark' model is not supported when using Codex with a ChatGPT account."}
```

So the Spark rate-limit bucket (`codex_bengalfox`, which can sit at 0% while the main `codex` bucket
is at 100%) is **not** a way to keep working on a ChatGPT account. Models this account does offer,
per `model/list`: `gpt-6-astra`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`.

### Approvals do not reach the Codex app for a run started here

`approvalPolicy: never` is not a shortcut, it is the only correct value for this client. Codex's
approvals and questions are a protocol between a Codex *client* and *its* app-server
(`CommandExecutionRequestApproval`, `FileChangeRequestApproval`, `ToolRequestUserInput`). A run
started by the broker has the broker as its client, so no prompt can pop up in the app: the app
simply is not a party to that session. Sessions the app itself starts (or that you resume in it)
prompt natively, as before. `on-request` must not be set for the broker-driven path - a
non-interactive client cannot answer, and the run would stall or be refused.

There is no shared-daemon escape on Windows: `codex app-server daemon ...` answers
`lifecycle is only supported on Unix platforms`, and the app's own app-server is a private stdio
child with no TCP listener and no control socket, so no third process can attach to it. On this
platform, "the app shows the progress" and "the broker answers the prompts" cannot both be true.

## Limits that are intentional in v0.1

- `run_agent` writes only inside an allowlisted workspace (`scratch` here). Real projects are added
  later, deliberately.
- No network, no web search, no `danger-full-access`, no git push, no deploys.
- `maxConcurrent: 1` and `maxBatchTasks: 1` prevent agent fan-out: one call already spawns many
  internal Codex interactions (a single edit-and-test run measured ~66k input tokens).
- Whether writing is allowed at all is local config (`sandbox: workspace-write` +
  `options.allowWritableSandbox: true`); the caller cannot enable it.
