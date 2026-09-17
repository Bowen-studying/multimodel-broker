# Multi-Model Broker

[![CI](https://github.com/Bowen-studying/multimodel-broker/actions/workflows/ci.yml/badge.svg)](https://github.com/Bowen-studying/multimodel-broker/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A5%2022.5-3c873a.svg)
![Tests](https://img.shields.io/badge/tests-263%20passing-brightgreen.svg)
![MCP](https://img.shields.io/badge/MCP-stdio%20%2B%20Streamable%20HTTP-6f42c1.svg)
![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178c6.svg)

**English** · [中文](README.md)

An MCP-facing task broker for multiple models: an MCP client (ChatGPT, Codex, or any harness) hands it a task, it routes it by capability to a local or cloud worker (local Codex, local Claude Code, DeepSeek, GLM, Gemini, mock), returns one normalized result, and leaves an auditable trace. Read and write capabilities are strictly separated — a write-capable worker can only be reached through its own dedicated write tool.

## Features

- Two MCP transports: stdio (local harness) and Streamable HTTP (loopback + shared key, optional SSE responses)
- Three profiles (7 / 9 / 8 tools) over 10 registered tools, with strict read/write separation: write-capable workers are reachable only via `run_agent` / `run_claude_code`
- Deterministic routing: picks a worker from `requirements` (coding / long_context / low_cost / chinese / batch, …) plus declared capabilities, with chained fallback; an explicitly named worker is never rewritten
- Long tasks, concurrency, idempotency and audit: `delegate_batch` runs up to 8 tasks in parallel and keeps partial results; `idempotencyKey` deduplicates to avoid double billing; traces never store prompt text by default
- Publicly reachable without opening a port: `relay` dials out to a self-hosted relay; remote clients reach it via a fixed URL

## Why this exists

Put several models behind one MCP interface: a supervisor (e.g. ChatGPT Pro) only plans and reviews, while the broker routes each task to the most suitable worker and handles concurrency, tracking and audit. Each provider needs a single adapter, and the access side only swaps transports (stdio / HTTP / relay). Read and write paths are kept apart in both credentials and tool surface, so side-effecting operations like writing files cannot hide inside a "read-only" tool.

## Architecture

![Multi-Model Broker architecture: MCP client → transport (local stdio / public relay) → Broker Core (Router / Scheduler / TaskManager / TraceStore) → provider adapters (read-only workers and write-capable workers)](docs/assets/architecture.svg)

```text
┌──────────────────────────────────────────────────────────┐
│  MCP client (ChatGPT / Codex / any harness)              │
└──────────────────────────┬───────────────────────────────┘
                           │ MCP (stdio / Streamable HTTP / relay)
                           ▼
┌──────────────────────────────────────────────────────────┐
│  MCP interface layer   src/interfaces/mcp                │
│  tools · schemas · profiles · annotations · http · server│
└──────────────────────────┬───────────────────────────────┘
                           │ calls the Broker only — never a provider
                           ▼
┌──────────────────────────────────────────────────────────┐
│  Broker Core           src/core                           │
│  broker · router · scheduler · task-manager · trace-store │
│  policy · config                                          │
└──────────────────────────┬───────────────────────────────┘
                           │ normalized WorkerRequest / WorkerResult
                           ▼
┌──────────────────────────────────────────────────────────┐
│  Provider adapters     src/providers                      │
│  mock · openai-compatible(DeepSeek/GLM) · gemini          │
│  codex · claude-code                                      │
└──────────────────────────────────────────────────────────┘
```

Layering: the Core does not know about ChatGPT, and the providers do not know about MCP. The transport in front of the broker is replaceable (stdio today, a remote MCP endpoint or a harness plugin tomorrow); providers only see the normalized request/result shapes and are unaware of which MCP client is driving them.

## Tech stack and requirements

- Node.js >= 22.5 (uses the built-in `node:sqlite`), TypeScript, zero native modules, no build toolchain required
- Dependencies: `@modelcontextprotocol/sdk` ^1.30, `zod` ^4.6, `yaml` ^2.9
- Tests: 263 tests / 33 files (vitest), all offline and quota-free (providers are injected fakes)

## Quick start

```bash
npm ci
npm run check && npm test && npm run build
node dist/cli/index.js doctor                      # config/storage/provider health
node dist/cli/index.js mcp-stdio  --profile local-full          # local stdio access
node dist/cli/index.js mcp-http   --profile chatgpt-pro-readonly \
  --token-env BROKER_HTTP_TOKEN --port 8789                     # loopback HTTP access
node dist/cli/index.js relay setup|start|status|stop|url         # public (self-hosted relay)
```

- `npm run check`: type check (tsc --noEmit)
- `npm test`: vitest, offline
- `npm run build`: tsc, emits dist/

## MCP tools

| Tool | readOnlyHint | destructiveHint | Purpose |
|---|---:|---:|---|
| `ping` | true | false | Health probe, returns the service name; check connectivity before delegating |
| `list_workers` | true | false | List workers with enabled/healthy state, provider, model, auth mode, capabilities, max concurrency, and reason when unavailable |
| `run_worker` | true | false | Run one explicitly chosen API worker and return its answer (spends compute, returns text, writes no files/repos/third-party objects) |
| `run_agent` | **false** | **true** | Local Codex agent that can read and write files and run commands/tests inside an allowlisted workspace |
| `run_claude_code` | **false** | **true** | Local Claude Code agent (full-auto) that can read and write files and run shell commands |
| `delegate` | true | false | Deterministically route by `requirements` and run; returns the selected worker, route reason, route audit, and result/task id |
| `delegate_batch` | true | false | Run 1–8 independent tasks in parallel in one call (mode 'parallel', failurePolicy 'collect_all'); keeps partial results |
| `get_task` | true | false | Fetch a task by id: status, completion counters, children and (optionally) finished results, for polling |
| `get_trace` | true | false | Fetch the audit trace (goal, route reason, provider/model, timings, tool events, usage, errors) |
| `cancel_task` | true | false | Cancels a queued or running task (and its children); a local ops tool that is not handed to remote clients by default |

There is also a development probe, `ui_probe`: it is registered only when `BROKER_UI_PROBE=1` (it renders a server-hosted inline UI card and reports whether the client renders it, runs no worker, costs nothing) and is not part of any profile's default surface.

**Write-capable workers are reachable only through their own write tools**: read-only tools (`run_worker` / `delegate` / `delegate_batch`) refuse write-capable adapters (`codex-sdk`, `claude-code`); a write-capable worker can only be reached via `run_agent` (local Codex) or `run_claude_code` (local Claude Code), both annotated `readOnlyHint: false, destructiveHint: true`.

Three profiles:

- `chatgpt-pro-readonly` — 7 read-only tools (used by the ChatGPT Pro bridge)
- `chatgpt-agent` — those 7 plus `run_agent` / `run_claude_code` (9 tools)
- `local-full` — the 7 read-only tools plus `cancel_task` (8 tools, for a local harness)

## Three ways to connect

| Method | Command | For |
|---|---|---|
| Local stdio | `node dist/cli/index.js mcp-stdio --profile local-full` | Local harness (Codex / Claude Code / Hermes / MCP Inspector) |
| Loopback Streamable HTTP + shared key | `node dist/cli/index.js mcp-http --profile chatgpt-pro-readonly --token-env BROKER_HTTP_TOKEN --port 8789` | ChatGPT connector, or any client that cannot spawn a process |
| Self-hosted relay | `node dist/cli/index.js relay setup|start|status|stop|url` | Phone / remote MCP clients via a fixed URL |

Under the relay, the machine acts as a client that **dials out** to a self-hosted relay (Cloudflare Worker + Durable Object) and **opens no port**; the relay understands no business semantics and only forwards device + channel requests/responses, and it **never auto-replays a write request** (a disconnect returns `outcome_unknown`, recovered by the caller's `idempotencyKey`).

## Security model

- Secrets are read only from the environment / `.env`, never from config files or argv; when a secret must be written to disk it goes into a 0600 temp file that is deleted after use
- Prompts are not stored by default: `trace.storePrompts: false` stores only length and sha256, never the text
- Output redaction: key/token-shaped strings are always replaced
- Sensitive path deny-list: `~/.ssh`, `~/.aws`, `~/.hermes`, `~/.codex`, `/mnt/c/Windows`, …; optional `allowAnyWorkspace`
- Writing to disk must be enabled explicitly on the local side: `sandbox: workspace-write` + `allowWritableSandbox: true`
- Idempotency keys prevent double billing: `idempotencyKey` deduplicates; a repeated submission only waits, it does not re-run
- Read/write credential separation: the read path uses each provider's API key (environment variable), while write-capable local agents use the machine's existing login (Codex subscription / local Claude Code CLI); the two are never shared

## Production boundaries / known limitations

- Claude Code's self-reported `total_cost_usd` uses Anthropic pricing, ~500× higher than what DeepSeek actually charges — never treat it as the bill
- Two PATH traps under a service (systemd): spawn must use `process.execPath`; the Claude Code CLI must be given an absolute path
- Windows and WSL are two separate Codex homes (`~/.codex` vs `C:\Users\<you>\.codex`); the app-side model list relies on `model_catalog_json`
- The relay's SSE long connection is dropped after ~60 seconds; calls inside the reconnect window return 502 and should be retried as-is
- ChatGPT does not display MCP annotations (readOnlyHint, etc.); the tool description is the only thing the model can actually see

## Repository layout

```text
src/                        core (core / providers / interfaces/mcp / storage / security / relay / cli)
src/core/                   broker · router · scheduler · task-manager · trace-store · policy · config
src/providers/              mock · openai-compatible(DeepSeek/GLM) · gemini · codex · claude-code
src/interfaces/mcp/         tools · schemas · profiles · annotations · http · server
src/security/               redaction · secrets · paths
src/relay/                  outbound relay client and connection management
relay/                      relay side (Cloudflare Worker + Durable Object) and tests
tests/                      263 tests (unit + integration)
config/                     example configs (providers.*.example.yaml / *.mock.yaml / localmcp.example.json)
docs/                       architecture, security, remote access, ADRs (decisions/), eval fixtures
integrations/claude-code/   local Claude Code runner (headless) + measurement scripts
integrations/codex-local-bridge/  in-house minimal Responses API bridge (experimental, for external models)
scripts/                    smoke / roundtrip / relay self-check scripts
plugins/                    Codex plugin wrapper layer
.github/workflows/ci.yml    offline CI
```

## Development

- Tests: 263 tests / 33 files (vitest), all offline, no quota spent
- CI: GitHub Actions, runs check + test + build offline (no smoke that needs real quota/credentials)
- Contributing: see [CONTRIBUTING.md](CONTRIBUTING.md)
- Security reports: see [SECURITY.md](SECURITY.md)

## License

MIT © 2026 Bowen-studying
