# 010 - 单一写工具 + 粘性选择（模型由使用者决定）

- Status: accepted (2026-09-18)
- Supersedes in part: 003 (the `chatgpt-pro-readonly` profile name), 007, 008 (the tool pair
  `run_agent` / `run_claude_code`), 009 (the profile column).
- Refines: the product positioning - **this broker is a connector**; which model/harness runs is the
  caller's configuration and the caller's explicit choice.

## Context

Two decisions had drifted away from the product's purpose:

1. **Two write tools existed** (`run_agent` for Codex, `run_claude_code` for the local Claude Code
   CLI). They are the same kind of capability - a local agent that edits files and runs commands -
   so the tool surface, the descriptions, the profiles, the tests and the docs all carried the same
   facts twice, and a caller had to learn two names for one idea.
2. **Three profiles existed** (`chatgpt-pro-readonly`, `chatgpt-agent`, `local-full`), but
   `chatgpt-agent` already contained everything the read-only one exposed. The read-only profile was
   a second *tool list*, while "this entry point must not write" is actually a **config** question
   (does this instance enable any write-capable worker?).

At the same time the operator's real workflow wanted the opposite of "no defaults at all": once a
model/harness has been chosen for a task, the next call should keep using it - and switching it must
stay one explicit argument. The broker must never choose a model by itself, and must not imply a
vendor default anywhere in code, config templates or docs.

## Decision

1. **One write tool.** `run_agent`, whose `worker` (`codex` | `codex-win` | `claude-code`) must be
   named the first time and may be omitted afterwards (the choice sticks) - the schema injects no
   default, so a call with no `worker` and nothing remembered is refused. Write-capable adapters (`codex-sdk`, `claude-code`) remain reachable *only* here;
   the read-only tools keep refusing them, and the refusal still comes from `TaskRecord.kind`, which
   a caller cannot forge. Registered tools drop from 10 to 9.
2. **Two profiles.** `chatgpt-agent` (default; the 7 read-only tools + `run_agent`) and `local-full`
   (the 7 + `cancel_task`, local harness only). A read-only remote entry point is produced by
   **not enabling any write-capable worker on that instance**, not by a profile name: a profile
   decides the tool surface, not the permissions.
3. **Sticky choice, explicit switch.** Naming a `worker` remembers it *per tool*; omitting it reuses
   the remembered one; naming another switches and becomes the new default. A `model` override is
   remembered per worker and reapplied when omitted; `model: "auto"` forgets it so the worker's
   configured model applies again. `list_workers` marks the current choice with
   `defaultFor: ["run_agent"]`, and the trace carries a `choice.remembered` event, so a reused choice
   is never silent.
4. **A refused worker is never remembered** - validation runs before persistence, and a remembered
   choice that no longer validates is forgotten rather than re-thrown. Otherwise "omit the worker"
   would inherit something unusable and there would be no way back except by reading the config.
5. **Preferences live in the instance's own store** (`settings` key/value table, migration 002), so
   two instances - or two operators - never share a choice.
6. **No default model anywhere.** Example configs use environment placeholders, the schemas accept
   any id the caller's provider serves, and nothing in the code assumes a vendor. Fixing this
   surfaced a real bug: the broker was forwarding `entry.config.model` to every provider and
   dropping the caller's documented `model` override, so the override now actually reaches the
   provider (a caller-supplied model wins; `auto` means "use the configured one").

## Consequences

- A caller that only ever used `run_claude_code` must call `run_agent` with `worker: "claude-code"`.
- The remote read-only instance still *lists* `run_agent`; every call is refused because its config
  has no write-capable worker enabled. That is the accepted trade: one fewer profile name, no
  capability widened.
- `tests/integration/sticky-choice.test.ts` covers reuse, switching, non-persistence of refusals,
  per-instance isolation, and the model-override round trip.
- `run_agent`'s `workspace` means different things per worker (a sandbox write boundary for Codex, a
  starting directory for `claude-code`); the tool description says so, because the argument looks
  identical at the call site.
