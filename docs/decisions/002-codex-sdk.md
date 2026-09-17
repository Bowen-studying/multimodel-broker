# 002 – Codex adapter: `@openai/codex-sdk`, with a correction to the task book

Status: accepted (2026-09-16)

## Context

The task book (§3.1) states that `codex mcp-server` has been removed and therefore
cannot be the Codex integration path, and instructs V1 to use `@openai/codex-sdk`.

## What is actually true on this machine (verified)

```text
$ codex --version
codex-cli 0.153.4

$ codex --help
... mcp-server   (still listed)
... app-server   (experimental)
```

So the task book's premise is outdated: `codex mcp-server` still exists locally.
Per the task book's own rule (§0.4: when the document and the real installation
disagree, the real behaviour wins and the difference is logged here), this is
recorded as a deviation.

## Decision

V1 is still built on `@openai/codex-sdk@0.154.0` (installed, dev-time optional
dependency), for the reasons the task book gives: the broker needs programmatic
thread start/resume, a read-only sandbox and a normalised result - not an MCP
server that would make the broker an MCP client of another MCP server.

- Imported lazily: a machine without the SDK starts normally, and the worker reports
  `reasonUnavailable: "codex sdk not installed"`.
- Auth is the user's official Codex login. The provider never reads, copies or prints
  `~/.codex/auth.json`; `doctor` reports only whether the file exists (boolean).
- Defaults: `sandboxMode: "read-only"`, `approvalPolicy: "never"` (rejecting
  `on-request`), `skipGitRepoCheck: false`, `model: "auto"` meaning "send no model id".
- Trace records only what the SDK returns: prompt, workspace, thread id, timings,
  final response, usage, errors - plus real `command_execution` / `file_change` /
  `mcp_tool_call` / `web_search` items in verbose mode. `reasoning` items are dropped.
  Command/tool events are never synthesised.
- `resume(sessionId, ...)` uses `resumeThread`; the thread id is returned as
  `sessionId` for the caller to continue later.

`codex app-server` remains a future option if the project ever needs full auth
interaction, approval flows or fine-grained streamed events; it is deliberately not
part of V1.

## Verified locally

- `tests/integration/codex-provider.test.ts` drives the adapter through an injected
  fake SDK (sandbox/approval/workspace assertions, resume path, abort, missing SDK,
  reasoning never traced).
- `scripts/codex-scenario.mjs` runs the real SDK against a scratch git repository to
  check that a read succeeds and a write cannot modify the repository (scenario F).
