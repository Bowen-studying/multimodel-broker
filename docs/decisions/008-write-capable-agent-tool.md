# 008 - The write-capable agent tool is separate, and the capability is local

Status: accepted (2026-09-17). Extends 001 (core separation) and 007 (supervisor layer). Scopes
the first agentic write path: `run_agent` (C1-C3 of the Codex write plan).

## Context

Everything the broker exposed so far is read/compute: it spends model quota and returns text, and
`run_worker`/`delegate`/`delegate_batch` are advertised with `readOnlyHint: true` on that basis
(annotations.ts states the rule: a writing capability must never be folded into a tool that keeps
that annotation).

Codex is the first worker with a real agent runtime - it can read a repository, edit files, run
commands and tests, and report what it did. That is exactly what makes it useful, and exactly what
makes it a different kind of tool. Three facts shape the design:

1. A write path is not a route: it is a capability. Routing decides *which* worker runs; it must
   never decide whether the user's files may be modified.
2. The caller is a cloud model. A remote caller may **request** work, but must never be able to
   grant itself write access. Whether writing is permitted has to be a local configuration fact
   (`providers.codex.sandbox` + `options.allowWritableSandbox`).
3. The existing read-only surface is verified and working (M0/M1/M2, `codex-scenario.mjs`).
   Widening it in place would put working, honest tooling at risk for no reason.

## Decision

1. **A new tool, `run_agent`,** exposed alongside - never instead of - the read/compute tools.
   v0.1 accepts `worker="codex"` only: Codex is the only worker with an agent runtime, and a
   half-real write path for a text-only provider would be a lie.
2. **Annotations are mutating and honest:** `readOnlyHint: false`, `destructiveHint: true`,
   `openWorldHint: true`, `idempotentHint: false`.
3. **Two profiles, two blast radii.**
   - `chatgpt-pro-readonly` - unchanged: the seven read/compute tools, every annotation still
     `readOnlyHint: true` (enforced by a test).
   - `chatgpt-agent` - the same seven **plus `run_agent`**. A separate connector therefore means a
     separate, explicit decision by the operator.
4. **`workspace` is mandatory** for `run_agent`, and the broker rejects the call without one. The
   write surface is always an allowlisted directory resolved through the existing `WorkspaceGuard`.
5. **Egress stays locked** in write mode too: `networkAccessEnabled=false`, `webSearchMode="disabled"`
   unless local config explicitly opts in. v0.1 does not support `danger-full-access`, git push,
   deploys, or writes outside the workspace.
6. **No blind cross-worker fallback for write tasks.** A write that failed in Codex must not be
   silently re-run on another worker; the caller decides.
7. `run_worker`/`delegate`/`delegate_batch` are untouched.

## Consequences

- The ChatGPT agent path needs its own connector (or connector edit) pointed at the
  `chatgpt-agent` profile; the read-only connector keeps working exactly as before.
- Long edits do not block a bridge request: `run_agent` returns `running` + `taskId` after `waitMs`
  and the caller polls `get_task` (the pattern C5 verifies).
- Cost exposure grows: an agent run bills Codex quota *and* can consume minutes. The remote
  request budget stays where it is, but a write-capable profile should get its own, tighter limits
  before it is used daily.
- Known limit, deliberately deferred: there is no durable recovery if the broker restarts mid-run,
  and no hour-scale task support yet.

## Deployment shape

The write path runs as a **second broker instance**, not as a mode switch on the existing one:
port `8790`, profile `chatgpt-agent`, its own token, its own SQLite (`data/broker-agent.sqlite`),
Codex only, and a single workspace (`scratch`). Operation, limits and preflight:
`docs/agent-instance.md`. Flipping the read-only instance to the agent profile was rejected because
it would have silently widened a surface that is already verified and in use.

## Verification (C3, this machine)

`node scripts/codex-write-scenario.mjs` prepares a private git repo, runs one `run_agent` call with
`sandbox: workspace-write`, and then checks the disk, git and the event store rather than trusting
the model's summary. See `docs/known-limitations.md` for the recorded result.
