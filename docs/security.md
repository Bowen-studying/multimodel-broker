# Security model

Scope: a single-user, local broker that spends money on model calls and reads
allowlisted local files. The threats that matter are *leaking credentials*, *writing
to the user's real repositories by accident*, *double-billing*, and *misleading a
client about what a tool does*.

## 1. Tool annotations are honest, never tuned

| Tool | readOnlyHint | destructiveHint | openWorldHint |
|---|---:|---:|---:|
| `ping`, `list_workers`, `get_task`, `get_trace` | true | false | false |
| `run_worker`, `delegate`, `delegate_batch` | true | false | true |
| `cancel_task` (local profile only) | **false** | **true** | false |

`readOnlyHint: true` on the delegation tools is justified by their actual effect:
they request model inference and return text. They do not create, update or delete
user files, repositories, database rows or third-party business objects. They do
reach a third-party API over the network, which is why `openWorldHint` is `true`.

Any future capability that writes (files, git, deploys, DB rows, third-party
objects) must be a **separate** tool with `readOnlyHint: false` and an honest
`destructiveHint`. Folding a write into `run_worker` while keeping its annotation is
forbidden. If a client (e.g. ChatGPT Pro) refuses a tool because a *parent* proxy
tool is not read-only, the fix is a different bridge - not a faked annotation
(`docs/decisions/003-chatgpt-bridge.md`).

### 1.1 "Read-only" includes "no side-effecting egress"

The promise above only holds if a worker cannot reach out and *do* something. A
filesystem sandbox is not the same thing as no network, so the Codex worker does not
inherit SDK defaults:

- `networkAccessEnabled: false` and `webSearchMode: "disabled"` are sent explicitly on
  every thread (`tests/integration/codex-provider.test.ts`).
- Turning either on requires a second, deliberate flag
  (`options.allowNetworkAccess=true` / `options.allowWebSearch=true`); without it the
  run fails with `CONFIG_ERROR` instead of quietly gaining egress.
- `doctor` warns when a provider is configured with egress, because the read-only
  annotation no longer means "spends compute and returns text only".
- The regression test is `node scripts/codex-network-scenario.mjs` (scenario G): a
  loopback canary server must receive **zero** requests while Codex is asked to fetch
  it. Measured: `canaryHits=0`, Codex's own answer `curl: (7) failed to open socket:
  Operation not permitted`, trace shows `networkAccessEnabled=false`,
  `webSearchMode="disabled"`, and the `command_execution` tool event is `failed`.
  This is evidence for this configuration, not a formal proof about every future SDK
  version - re-run the scenario after an SDK upgrade.

## 2. Secrets

- Credentials come from the environment (`.env` is loaded once, if present, and never
  overwrites an existing variable). `.env` and `config/providers*.yaml` are
  gitignored.
- `requireSecret(name)` resolves a key at call time; a missing key is a
  non-retryable `SECRET_MISSING`, never a silent empty header.
- `redact()` / `redactString()` is the single scrubbing implementation. It removes:
  known secret values, `sk-*` keys, `${ENV}` placeholders, Authorization/Proxy-
  Authorization headers, `Cookie`/`Set-Cookie`, `session*`/`access_token`/
  `refresh_token`/`api_key`/`password` assignments, credential-bearing MCP URLs,
  `https://user:pass@host`, long hex/base64 token shapes, and any object key whose
  name looks secret.
- Everything persisted (memory, SQLite, trace events, task/run rows, artifacts) and
  everything returned over MCP passes through redaction.
- Logs go to **stderr** as structured JSON. stdout is reserved for the MCP protocol,
  so a stray log line cannot corrupt the transport.
- `doctor` (and `list_workers`) report credentials as `set`/`missing` only. No
  provider response, error message, trace event or DB row contains a key: this is
  covered by tests (`tests/unit/openai-compatible.test.ts`,
  `tests/integration/provider-retry.test.ts`, `tests/integration/mcp-stdio.test.ts`).

## 3. Hidden reasoning is never stored

Chain-of-thought is not an output. `OpenAiCompatibleProvider` ignores
`reasoning_content`/`reasoning`/`thinking` fields entirely: a response containing
only reasoning is `PROVIDER_BAD_RESPONSE`, and the text never reaches a result, a
trace or a log. `CodexProvider` drops `reasoning` stream items for the same reason.

## 3.1 The one writing tool

`run_agent` is the only tool that changes files. It is deliberately narrow:

- `worker` is pinned to `codex` (the only worker with a real local agent runtime) and `workspace`
  is mandatory, so every write happens inside an allowlisted directory resolved by the same
  `WorkspaceGuard` as the read path (absolute paths, `..` and symlink escapes are rejected).
- Whether writing is allowed at all is decided **locally** by
  `providers.codex.sandbox: workspace-write` plus `options.allowWritableSandbox: true`. A remote
  caller can ask for work; it can never grant itself the capability. If the local config says
  `read-only`, a `run_agent` call fails with a provider `CONFIG_ERROR` instead of quietly writing.
- Egress is locked in write mode too (`networkAccessEnabled: false`, `webSearchMode: "disabled"`),
  so an "edit this file" task cannot turn into an outbound request.
- v0.1 excludes `danger-full-access`, git push, deploys and any write outside the workspace.
- It is exposed through the `chatgpt-agent` profile only, and its annotations say what it is:
  `readOnlyHint: false`, `destructiveHint: true`, `openWorldHint: true`, `idempotentHint: false`.
- `tests/unit/annotations.test.ts` asserts that every tool in `chatgpt-pro-readonly` still has
  `readOnlyHint: true`, so the mutating tool cannot leak into the read-only surface unnoticed.

## 4. Workspace and file safety

- Only **workspace names** from the allowlist are accepted; absolute paths and `..`
  are rejected before anything is read.
- Paths are canonicalised (`realpath` of the closest existing ancestor), then
  re-checked against the canonical workspace root, which blocks symlink/junction
  escapes.
- Only regular files may be attached, with `maxFiles` and `maxFileBytes` (total)
  enforced.
- Codex defaults to `sandboxMode: "read-only"`, `approvalPolicy: "never"`,
  `skipGitRepoCheck: false`; a writable sandbox additionally requires
  `options.allowWritableSandbox=true`, and `approvalPolicy: "on-request"` is
  rejected (a non-interactive MCP server cannot answer prompts).
- The broker never runs `git push`, `git commit` or a deploy, and never modifies a
  repository other than the allowlisted workspace it was pointed at.

## 5. Money and idempotency

- Retries are bounded (`limits.maxRetries`, default 2) with backoff and happen only
  for classified-transient failures (429, 502/503/504, connection refused, timeout).
  An ambiguous HTTP 500 or a socket reset **after** the request was sent is never
  retried automatically - the call may already have been billed
  (`docs/decisions/004-retry-classification.md`).
- `idempotencyKey` collapses repeated submissions (including across processes sharing
  one SQLite file) into a single execution; the key is stored as a salted digest, so
  a key that itself looks like a secret is not persisted.
- On restart, tasks that were `queued`/`running` become `interrupted` and are never
  re-run automatically.

## 6. Trace contents

Recorded: the delegation goal, the route decision and reason, provider/model/thread
id, timestamps, explicit tool events, provider output, usage, errors and retries,
artifact metadata.

Not recorded: hidden chain-of-thought, API keys, cookies, OAuth tokens, full
environment variables, or any "internal thinking" a provider did not return
explicitly. With `trace.storePrompts: false` (default) prompt bodies are stored as
`{chars, sha256}` only.

## 7. Bridge / network

- Two interfaces, one core: `mcp-stdio` (local harnesses) and `mcp-http` (Streamable
  HTTP for cloud clients). The HTTP listener binds loopback by default, refuses to
  start without a shared secret, caps the body at 1 MiB, and enforces a request budget
  (60/min) plus a concurrency cap (4) - see `docs/remote-mcp.md`.
- ChatGPT connectors authenticate with OAuth 2.1 or nothing, so the secret rides in the
  endpoint URL. That URL **is** the credential: never commit it, never log it in full,
  and rotate the token if it leaks. This is a POC-grade scheme, not a long-term one.
- Reachability is a separate decision from protocol. The official Secure MCP Tunnel
  (outbound-only, no public port, no OAuth needed) requires a Platform account; with a
  ChatGPT subscription only, the options are a generic tunnel (e.g. `cloudflared`) or
  the project's own relay.
- A public relay (third-party Cloudflare Worker) is acceptable only for mock or
  non-sensitive POC traffic; sensitive papers, code and provider output must go
  through a self-hosted Worker or a trusted official tunnel.
- The MCP URL embeds credentials and is treated as a secret: it is never committed
  and never printed in full (the redactor masks credential-bearing URLs).
- Secret rotation: rotate the API keys and re-register the bridge if a URL or key
  leaks. The broker needs no redeploy for a key rotation - only the environment.

## 8. What is intentionally absent

No web UI, no SaaS/multi-user/RBAC, no GPT "Work" adapter, no browser automation of
ChatGPT/Gemini web UIs, no OAuth-token extraction from local CLIs, no free-form
multi-agent conversation, no delete tool reachable from the ChatGPT profile.
