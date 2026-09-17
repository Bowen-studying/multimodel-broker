# Known limitations and verification status

Last updated: 2026-09-17 (this machine: WSL2, Node 22.22.3; Windows Node 24.19.0).

## What is verified, and how

| Area | Status | Evidence |
|---|---|---|
| Type check / build | ✅ | `npm run check`, `npm run build` |
| Unit + integration suite | ✅ 213 tests, 27 files | `npm test` (no network, no real provider calls) |
| stdio MCP end to end | ✅ | `tests/integration/mcp-stdio.test.ts` spawns the real CLI and speaks MCP to it; `node scripts/mcp-roundtrip.mjs` |
| Streamable HTTP MCP end to end | ✅ | `tests/integration/mcp-http.test.ts`: real listener + official SDK client - profile tools/annotations, `run_worker(mock)`, token as header **and** query, `401` without a secret, `429` + `Retry-After` over budget, `/healthz` open and secret-free, malformed body `400`, standard sessions (`initialize` → `mcp-session-id`, SSE `GET`, `DELETE`, `400` for a missing session, `404` for an unknown one, `server/discover` answered with the real legacy-era version list), CLI exits 2 without a token (14 checks). Verified again through the public tunnel. |
| Windows end to end | ✅ | Windows Node `v24.19.0 win32` ran `doctor`, `task`, `tasks` with the SQLite driver on a `C:\` path, and `scripts/mcp-roundtrip.mjs` (8/8 checks) against the same `dist/` |
| **Local Codex write path** (`run_agent`, C1-C3) | ✅ **verified 2026-09-17** | `node scripts/codex-write-scenario.mjs`: 13/13 checks. One `run_agent` call under `sandbox: workspace-write` changed `hello.txt` (sha256 `f327a0f1…` → `18df4dc3…`), the agent ran `node check.mjs hello.txt CODEX_WRITE_OK` in the workspace (marker `.check-ran` = `ran=2026-09-17T03:41:20.353Z ok=true`), `git status` showed exactly `M hello.txt` + `?? .check-ran`, commits stayed 1→1 with no remote, the broker repo outside the workspace was byte-identical, and the event store recorded `file_change` + `command_execution` with `sandbox=workspace-write`, `networkAccessEnabled=false`, `webSearchMode=disabled`. Usage `{inputTokens:66757, outputTokens:165, cacheHitTokens:49408}`. Gate 2 (the same through ChatGPT) is not run yet. |
| **ChatGPT → `run_agent` → local Codex → disk** (C4 / Gate 2) | ✅ **verified 2026-09-17** | Second instance (8790, `chatgpt-agent`, own token, own DB `data/broker-agent.sqlite`, Codex-only, scratch-only). ChatGPT's call: task `ae09f3b4-…`, trace `3ee053c9…`, session `01a0ad86-…`, `completed`, 04:00:46.990Z → 04:01:28.783Z, usage `{inputTokens:69132, outputTokens:663, cacheHitTokens:60288}`; MCP log `tools/call run_agent` 200 in 41,830 ms. Disk: `hello.txt` line 2 became `CODEX_CHATGPT_E2E_OK` (sha256 `f327a0f1…` → `bcbe9606…`), the workspace test ran (`.check-ran` = `ran=2026-09-17T04:01:17.877Z ok=true`), `git status` = exactly `M hello.txt` + `?? .check-ran`, commits 1 → 1, no remote, and the broker repo outside the workspace stayed clean. |
| Trace shape of a Codex write | ⚠️ two legitimate shapes | Codex reports a file mutation as a `file_change` item when it applies its own patch, but as a `command_execution` when the edit happens inside a shell command (measured on the C4 run: 5 × `command_execution`, one of them the exact `python3 - <<PY …` that rewrote line 2, plus the `node check.mjs …` verifier; no `file_change` item). Both are audited; a test asserting strictly `file_change` will fail on the second shape. Tool events are recorded regardless of the caller's `traceLevel` - the first ChatGPT run produced zero events because buffered execution was the default, fixed in `d6dc514`. |
| **Task lifetime outlives the MCP request** (C5) | ✅ **verified 2026-09-17** | `node scripts/codex-async-scenario.mjs` 19/19: `run_agent` with `waitMs=1000` returned in 1576 ms as `running` + task `c9c57de1-…`; **40 s with zero MCP requests**, during which the fixture command ran to completion in the workspace (marker `started=04:51:00.777Z finished=04:51:09.783Z ok=true`); the task row completed at 04:51:15.963Z, i.e. **16.2 s before the single first poll at 04:51:32.134Z**, which already saw `completed`. The run started 04:50:50.840Z (with the request) and finished 04:51:15.945Z - 23.9 s of work after the response. `runs=1`, session `01a0adb4-…`, usage `{33260,126,32768}`, egress locked, one commit, no remote, nothing outside the scratch workspace changed. |
| Task completion lags the file work | ⚠️ measured | The task row and the `runs` row are written when the **provider returns**, i.e. after Codex finishes composing its answer - which can be tens of seconds after the file work is done (run 3: marker finished 04:39:00, task completed 04:39:07; run 4: the run row did not exist yet at the first poll). A checker that requires `completed` before the first poll with a fixed window will flake; assert on *work happening inside the no-poll window* instead. |
| Quick tunnel uptime under agent traffic | ⚠️ operational, being replaced | C5 attempts hit a revoked tunnel mid-run (`Unauthorized: Tunnel not found` / HTML instead of JSON), and an earlier version of the supervisor also killed *healthy* tunnels: a fresh quick-tunnel hostname does not resolve yet, the probe reported `000` while a manual `curl` of the same URL returned `200`, and the loop restarted a working tunnel every ~2.5 min. The supervisor now treats Cloudflare's own `Unauthorized`/`Tunnel not found` line as the authoritative signal, needs DNS to resolve before counting a probe strike, and waits 90 s after publishing. **Decision:** the production entry becomes one Cloudflare **named tunnel** with two stable hostnames; quick tunnels are demoted to a development fallback. Setup, acceptance criteria and rollback: `docs/stable-endpoint.md`. Blocked on the account owner running `cloudflared tunnel login` and having a domain in that Cloudflare account. |
| Local instances are not service-managed | ✅ fixed 2026-09-17 | Both brokers now run as systemd **user** services (`broker-readonly.service`, `broker-agent.service`, `Restart=always`; `Linger=yes` so they survive a WSL restart) instead of hand-started shells. Tokens stay in their 600 files and are read at start - never copied into a unit or the journal. Acceptance: `~/.broker-ops/verify-entry.sh <m1\|agent> <port> [--restart]` (m1 7/7, agent 10/10, including `URL unchanged after restarting the broker`). |
| Durable recovery / hour-scale agent runs | ❌ not implemented | A broker restart mid-run loses the run; `run_agent` returns `running` + `taskId` after `waitMs` and is polled with `get_task`, but nothing survives a restart. Deliberately out of scope for v0.1. |
| `danger-full-access`, git push, deploys | ❌ deliberately excluded | v0.1 supports `workspace-write` inside an allowlisted workspace only; write tasks never fall back to another worker. |
| Real **DeepSeek** API | ✅ | `node scripts/smoke.mjs`: unique token echoed verbatim, `model=deepseek-flash`, provider response id returned as evidence, usage tokens recorded |
| Real **Codex** worker | ✅ | `node scripts/codex-scenario.mjs`: read a canary file (`thread 01a0aac3-…`), a write attempt was blocked by the read-only filesystem (file hash unchanged, one real `command_execution` tool event), no commits created |
| Real **Codex** egress lockdown | ✅ | `node scripts/codex-network-scenario.mjs` (scenario G): a loopback canary server recorded **0** requests while Codex was asked to `curl` it; the answer was `curl: (7) failed to open socket: Operation not permitted`; the trace recorded `networkAccessEnabled=false`, `webSearchMode="disabled"`, `sandbox="read-only"`, `approvalPolicy="never"`; no file or commit was created. Re-run after any `@openai/codex-sdk` upgrade. |
| Real **GLM** API | ⚠️ partial | `glm-4.5-air` returns HTTP 429 / code `1113` "余额不足或无可用资源包,请充值" (no paid balance). `glm-4-flash` (free tier) works: public `run_worker(glm)` answered `GLM_PUBLIC_PREFLIGHT` with a real `provider.response_id` (`20260917092715c88b5b94ad4b4e6b`) and usage `44/7`. `glm-4.5-flash` is reachable but is a reasoning model that needs a larger `max_tokens`. |
| Cloud-client availability probe | ⚠️ accommodated | A session-less `GET` is answered with an idle SSE stream (spec says `400`) and a non-strict `Accept` header is accepted (spec/transport says `406`), because ChatGPT's `aiohttp` probe otherwise marks the app **unavailable**. Capped at 8 streams. Deliberate deviation, documented in `docs/remote-mcp.md`. |
| Modern-era MCP (protocol `2026-07-28`) | ⚠️ partial | `server/discover` is answered by the HTTP transport (a version we do not support gets `-32022` + the supported list, a legacy version gets a real `DiscoverResult`), but the server still negotiates the legacy `initialize` handshake; per-request `_meta` metadata and `2026-07-28` itself are not implemented (the SDK 1.30.x line has no release that supports them yet). |
| Real **Gemini** API | ⛔ not attempted | no `GEMINI_API_KEY` on this machine; adapter covered by the fake server only |
| **ChatGPT Pro** entry point (M0, mock) | ✅ **verified 2026-09-17** | Path A: broker `mcp-http` behind a Cloudflare quick tunnel, read-only profile, mock-only config. Server log shows the ChatGPT MCP client (`user-agent: openai-mcp/1.0.0`) issuing `server/discover`, `initialize`, `notifications/initialized`, `tools/list`, then `ping`, `list_workers` and `run_worker`; task `ced16110-…` completed with `Mock answer: M0 smoke test`. |
| **ChatGPT Pro → real provider** (M1, DeepSeek) | ✅ **verified 2026-09-17** | Same path with `mock` + `deepseek` enabled: task `9719196c-…` ran on `deepseek-flash`, answered `REAL_PROVIDER_OK`, usage `{"inputTokens":66,"outputTokens":187}`, evidence `provider.response_id 989e331d-…`. Note: the provider counts tokens that never appear in the answer, so cost math must use its numbers. |
| **ChatGPT Pro → multi-model orchestration** (M2) | ✅ **verified 2026-09-17** | Three ChatGPT-side runs, read back from the store: `run_worker(glm)` task `1c2b3f90-…` → `GLM_PROVIDER_OK` (`glm-4-flash`, usage `43/6`, provider response id `20260917102309c559c64b4a1e41cf`); `delegate_batch parallel` parent `8c63bf16-…` with two children (`deepseek` `6d20fc36-…` usage `71/403`, `glm` `d5ca679d-…` usage `50/85`); `delegate` + `requirements={chinesePriority:true}` task `236be2cf-…` → `selectedWorker=glm`, `routeReason="chinese requirements selected glm"`, `matchedRules=["chinese"]`. |
| Answer quality / disagreement detection (M3) | ⚠️ protocol only | Routing decides *who answers*, never whether the answer is right. M2c is the demonstration: GLM returned a confidently wrong lattice/basis explanation with `status: completed` and a healthy provider. A supervisor/reviewer layer is the next milestone. As of M3.0 the protocol is frozen (`docs/supervisor-protocol.md`, ADR 007), the adjudicator is the caller-side model, and the regression set is in `docs/evals/`; the broker still neither judges answers nor stores verdicts (the cloud profile is read-only, and `record_review` would need its own justification). `delegate_compare` is deliberately deferred until the fixtures have run. |
| Cross-provider usage comparison | ⚠️ needs normalisation | Same three-sentence task: DeepSeek `outputTokens=403` vs GLM `85`. DeepSeek bills hidden reasoning inside `completion_tokens` (probe: `completion_tokens=341` with `completion_tokens_details.reasoning_tokens=249`). The adapter now records `reasoningTokens` separately (and `cachedTokens` from either usage shape); until a comparison subtracts them, cost/efficiency maths across providers is apples-to-oranges. |

The mock path is now verified end to end (M0, 2026-09-17). Everything beyond it - a real
provider reached from ChatGPT, a durable endpoint, real cost limits - is still open, and
`docs/poc/` exists to keep those tests cheap and reproducible.

## Not implemented in V1 (deliberate)

1. **File / multimodal input.** No worker declares `files` or `multimodal`
   (`docs/decisions/005-provider-capabilities.md`), so an MCP caller cannot attach
   documents yet: text must go through `task`/`context`. Gemini is text-only here.
2. **Sequential and DAG batches.** `delegate_batch` accepts `mode: "parallel"` and
   `failurePolicy: "collect_all"` only.
3. **Automatic recovery of interrupted runs.** After a restart, `queued`/`running`
   tasks become `interrupted` and are never re-run automatically (that could
   double-bill). Codex threads can be resumed manually via `resume(sessionId)`.
4. **Codex app-server integration.** No approval flows, no fine-grained streamed
   events, no conversation history beyond a thread id. Only what
   `@openai/codex-sdk` returns is traced.
5. **Transports.** stdio MCP and Streamable HTTP MCP exist; A2A, native harness plugins
   and the project's own relay (`packages/relay`) are future work. The Core stays
   transport-agnostic by design (`docs/decisions/006-transport-layering.md`).
6. **Credential storage.** Environment variables / `.env` only - no OS keychain.
7. **Artifacts.** The schema, store and trace support artifact metadata, but no
   provider produces artifacts yet.
8. **Cost (not request) budget for the remote entry point.** `mcp-http` limits
   *requests* (60/min, 4 concurrent), not *spend*: one `delegate_batch` can run up to 8
   workers, so a leaked token can still burn provider quota. A remote policy - daily
   provider calls / tokens, per-provider budgets, a smaller batch cap and an optional
   worker allowlist for the cloud profile - is not implemented yet.

## Sharp edges worth knowing

- **Health checks do not check quota or balance.** `doctor` and `list_workers` report
  a provider healthy when its credentials and endpoint work (e.g. GLM's `/models`
  answers 200 while every chat call returns 429 for an empty account). A worker can
  therefore look `healthy` and still fail on the first real task - the failure is
  honest (`PROVIDER_RATE_LIMITED`, with the provider's own message) but it is not
  predicted by the health probe.
- **HTTP 500 is not retried automatically**, and neither is a connection lost after
  the request was sent: both may already have been billed
  (`docs/decisions/004-retry-classification.md`). 429 / 502 / 503 / 504 and refused
  connections are retried, bounded by `limits.maxRetries`.
- **`node:sqlite` is experimental** in Node 22 and 24 and prints an
  `ExperimentalWarning` on stderr (harmless: stderr is not the MCP channel). A future
  Node release may change that API.
- **SQLite is used as a single-writer database.** Cross-process idempotency is
  covered by a shared-file test, but multi-writer stress (many brokers on one file)
  has not been tested.
- **Windows needs its own dependency install for the Codex worker.**
  `@openai/codex` ships a platform-specific binary as an optional dependency, so the
  WSL install contains `linux-x64` only. The rest of the broker (including the
  SQLite store) is pure JS and ran unchanged on Windows.
- **`trace.storePrompts: true`** (storing raw prompt text) has unit coverage for the
  redaction path but has not been exercised end to end against real providers.
- **Unresolved `${ENV}` placeholders**: an *enabled* provider whose placeholder
  resolved to nothing is rejected at startup (`CONFIG_ERROR` naming the field); a
  *disabled* provider is allowed to keep the placeholder so it can still be listed by
  `list_workers`/`doctor`. Using such a provider fails loudly
  (`CONFIG_ERROR: baseUrl is not configured`).
- **The HTTP endpoint is a spending surface.** `mcp-http` binds loopback, requires a
  shared secret and enforces a request budget, but anyone who obtains the URL (which
  carries the token) can spend provider quota through `run_worker`/`delegate`. Rotate the
  token if it leaks, and keep the listener stopped when it is not being tested.
- **ChatGPT connectors cannot send a bearer token.** Its connector authentication is
  OAuth 2.1 or nothing (`developers.openai.com/plugins/build/auth`), which is why this
  project's secret travels in the URL - the same trick LocalMCP uses. An endpoint behind
  a public host therefore has to treat the URL itself as the credential.
- **The official Secure MCP Tunnel needs a Platform account.** `openai/tunnel-client`
  (outbound-only, no public port, no OAuth needed) requires a Platform `tunnel_id` and a
  runtime API key plus `Tunnels Read+Manage` permission. A ChatGPT subscription alone
  does not provide that, so on this machine the reachability options are a generic tunnel
  (e.g. `cloudflared`) or the project's own relay.
- **A tunnel or relay terminates TLS**, so MCP request bodies are visible to it. Use mock
  or non-sensitive material until a path you control is in place.
- **A broker-started Codex run never prompts in the Codex app.** Approvals/questions belong to
  whichever client drives the session; when the broker drives it, there is no interactive party, so
  `approvalPolicy` is `never` and the run simply proceeds (or is refused by the sandbox). If you
  want Codex to ask you, start that turn from the app (or from the phone's Remote), not through the
  connector. Windows makes this structural: `codex app-server daemon` is Unix-only and the app's
  app-server is a private stdio child with no port or control socket, so an external process cannot
  join it.
- **A Windows-launched broker cannot keep SQLite on the WSL filesystem.** The Codex app starts the
  stdio MCP server with Windows `node`, and SQLite over `\\wsl.localhost\...` (9p) fails immediately
  with `error[INTERNAL]: database is locked` - reproduced with a two-line script: the same process
  succeeds on a native Windows path and fails on the WSL one. That is what broke the app's
  `[mcp_servers.multimodel_broker]` handshake. Hence `config/providers.app.yaml`, whose `sqlitePath`
  is a Windows path and which never touches the WSL service's database.
- **Quota is visible without spending any.** `account/rateLimits/read` on the app-server reports
  `usedPercent`, the window length and `resetsAt`, plus any other limit buckets (e.g.
  `codex_bengalfox` = GPT-5.3-Codex-Spark). `scripts/codex-quota-probe.mjs` prints it.
- **A ChatGPT account cannot spend the Spark bucket.** `account/rateLimits/read` lists a second
  bucket (`codex_bengalfox` = GPT-5.3-Codex-Spark) that can read 0% while the main `codex` bucket reads
  100%, but asking for that model is refused server-side: `The 'gpt-5.3-codex-spark' model is not
  supported when using Codex with a ChatGPT account`. Exhausting the weekly window therefore means
  waiting for `resetsAt` (or moving to API-key billing); switching models does not help.
- **Cost visibility** is limited to the usage numbers a provider returns; no price
  table is bundled, so `cost` is only populated when a provider reports it (the
  mock does).

## Next steps that would close the remaining gaps

1. Run the M0 protocol in `docs/poc/chatgpt-pro-localmcp.md` and record the result
   (`verified` / `partially verified` / `blocked`).
2. Top up the GLM account (or swap the worker's model/account) and re-run
   `node scripts/smoke.mjs` to move GLM from "blocked by account" to verified.
3. Provide `GEMINI_API_KEY` (or a Vertex credential) and add a Gemini branch to the
   smoke script.
4. Implement file/multimodal input for one worker, add its capability, and extend
   the workspace-guard tests accordingly.
5. Put a public HTTPS path in front of `mcp-http` (cloudflared quick tunnel first, the
   project's own relay later), then run the M0 protocol from ChatGPT against the broker's
   own tools instead of a generic proxy.
6. Implement the remote cost policy from item 8 of "Not implemented" (daily provider
   calls/tokens, per-provider budget, cloud-profile batch cap and worker allowlist)
   before the endpoint is exposed beyond a short, manual test.
