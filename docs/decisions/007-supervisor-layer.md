# 007 - Supervisor layer, and why the broker does not judge answers

Status: accepted (2026-09-17). Extends 001 (broker core separation) and 005 (capabilities are
declared, never assumed). Related: 006 (transport layering, the read-only cloud profile).

> Partly superseded by **010**: the `chatgpt-pro-readonly` profile name used below no longer exists
> (read-only is a config choice now, not a profile), and the tool surface is 9 tools with a single
> write tool, `run_agent`.

## Context

M2 verified multi-model orchestration end to end: explicit `run_worker`, `delegate_batch` with
parallel children under one parent task, and requirement-driven routing with a reported
`routeReason`. M2c also produced the counter-example that motivates this decision.

GLM answered a lattice/basis question with `status: completed`, a healthy provider, a real
`provider.response_id` and a plausible tone - and got two definitions wrong (it equated lattice
points with atoms, and inverted the lattice/basis relation). Routing decides *who answers*. Nothing
in the broker decides *whether the answer is right*. That gap is now the project's main risk, not
the number of connected providers.

Three constraints shape what to build:

1. **The adjudicator already exists on the caller side.** A ChatGPT-class model is a stronger judge
   than anything the broker could embed today, and it sees the user's real intent. An in-broker
   evaluator would duplicate that and add a second, weaker judge.
2. **There is no legitimate write-back channel.** The cloud entry point runs the
   `chatgpt-pro-readonly` profile; a verdict is produced *after* the tool result is returned. Adding
   `record_review` would touch the ChatGPT Pro read/write boundary and needs its own justification.
3. **`delegate_batch(parallel)` already covers the fan-out.** A `delegate_compare` tool today would
   freeze an interface before any experiment has shown which fields matter.

## Decision

1. Freeze **Supervisor Protocol v0** in `docs/supervisor-protocol.md`: three modes - `single`,
   `parallel_compare`, `adjudication` - and a fixed verdict envelope. Comparison is **per claim**,
   never a single "who is better" score.
2. **The adjudicator is the caller-side model.** The broker returns candidates, task ids, usage,
   latency and evidence, and stops there. It does not rank answers and does not claim correctness.
3. **No verdict write-back in M3.0-M3.2.** Candidate tasks and traces stay in the broker store;
   verdicts are recorded as files under `docs/evals/runs/`. Persistence gets designed from observed
   need (which fields are actually re-read), not guessed up front.
4. **`delegate_compare` is deferred** until the regression set has run (M3.3). If it is built, it is
   an orchestration envelope only - uniform candidates/taskIds/usage/latency/evidence - and must not
   pretend to decide correctness. If what the experiments actually need is a review/audit record,
   that is a separate data model, not a field bolted onto the envelope.
5. **Mode selection stays explicit** (a prompt policy) in M3. M4 may automate the choice between
   `single`, `parallel_compare` and `review`, but never by guessing from free text in the broker.

## Consequences

- Quality control is measurable now: the eval set (`docs/evals/`) pre-writes `criticalClaims` per
  task, so "did the supervisor help?" is checked against known claims instead of impressions.
- The broker stays a deterministic orchestrator. Nothing about answer quality leaks into routing,
  so a bad answer never silently changes which worker gets picked next.
- The verdict is not machine-parseable end to end (it lives in a markdown run log), which is
  deliberate at this stage - and the reason a later `review` data model may become worth building.
- Honest limit: the supervisor is not ground truth either. The eval measures **detection of known
  conflicts**, not general correctness.

## Exit criteria (M3)

| Item | Pass condition |
|---|---|
| Protocol | verdict envelope fixed and repeatable across runs |
| Error detection | the known lattice/basis conflict is detected and corrected every run |
| Regression | 8-12 fixtures with pre-written `criticalClaims` executed |
| Architecture | evidence exists to decide on `delegate_compare` and/or review persistence, with a schema |
