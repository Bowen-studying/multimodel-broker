# Architecture

## Layers

```text
┌──────────────────────────────────────────────────────────────────────┐
│ Harness layer (replaceable)                                          │
│   ChatGPT Pro ──LocalMCP bridge──┐                                   │
│   Codex / Claude Code / Hermes ──┼─ stdio MCP ─┐                     │
│   MCP Inspector ─────────────────┘             │                     │
└────────────────────────────────────────────────┼─────────────────────┘
                                                 ▼
┌──────────────────────────────────────────────────────────────────────┐
│ MCP interface layer      src/interfaces/mcp/                         │
│   server.ts      one McpServer per profile                           │
│   tools.ts       registers tools; each handler calls ONLY the Broker │
│   schemas.ts     Zod input schemas = the contract a model reads      │
│   annotations.ts the read-only table (docs/security.md)              │
│   profiles.ts    chatgpt-agent | local-full                          │
└──────────────────────────────────────────────────────────────────────┘
                                                 ▼
┌──────────────────────────────────────────────────────────────────────┐
│ Broker Core              src/core/                                   │
│   broker.ts       facade: submit/delegate/batch/get/trace/cancel     │
│   router.ts       deterministic routing (no LLM)                     │
│   policy.ts       limits: task/context size, waitMs, batches         │
│   scheduler.ts    global + per-provider FIFO semaphores              │
│   task-manager.ts task lifecycle, idempotency, abort, aggregation    │
│   trace-store.ts  append-only audit events, prompt protection        │
│   bootstrap.ts    config -> store/providers/scheduler/broker wiring  │
└──────────────────────────────────────────────────────────────────────┘
        │                                   │
        ▼                                   ▼
┌───────────────────────────┐   ┌──────────────────────────────────────┐
│ Providers  src/providers/ │   │ Storage  src/storage/                │
│  provider.ts  registry    │   │  memory.ts  (V0/M0)                  │
│  mock/                    │   │  sqlite.ts  node:sqlite (V1)         │
│  codex/     @openai/codex-sdk                                 │
│  gemini/    Generative Language API                          │
│  openai-compatible/ base → deepseek/ glm/                     │
└───────────────────────────┘   └──────────────────────────────────────┘
        │
        ▼
┌──────────────────────────────────────────────────────────────────────┐
│ Security  src/security/                                              │
│  paths.ts  WorkspaceGuard (allowlist, canonicalise, symlink escape)  │
│  redaction.ts  one place that knows how to scrub secrets             │
│  secrets.ts    .env loader / ${ENV} resolution / set|missing probe   │
└──────────────────────────────────────────────────────────────────────┘
```

Dependency rules (enforced by review, not by the compiler):

1. Core must not depend on ChatGPT or on MCP.
2. MCP tools must not touch providers or storage directly - only `Broker`.
3. Providers must not know about MCP, tasks or HTTP transports.
4. `src/security/redaction.ts` is the only module that knows how to mask a secret.

## Request flow (single task)

```text
tool call
  → mcp/tools.ts validates input (Zod, strict: unknown fields are rejected)
  → Broker.submit()
      → RequestPolicy.validate            limits + clamps waitMs
      → TaskManager.findOrCreateTask      idempotencyKey -> existing task or new row
      → TaskManager.registerRun           hard reference so work survives the handler
      → Router.route                     explicit worker kept as-is, else rules + fallback
      → WorkspaceGuard.resolveWorkspace/validateFiles
      → Scheduler.run(worker)            global semaphore, then provider semaphore
          → Provider.run(request, signal)  own AbortController + timeout
          → retries (bounded) only for classified retryable failures
      → TaskStore + TraceStore           rows, events, usage, artifacts
  → envelope { ok, status, taskId, traceId, data, error }
```

If the work outlives `waitMs`, the envelope returns `status: "running"` with the
`taskId`; `get_task` then returns the aggregated result. Nothing is re-run because a
handler returned.

## Parallel batch

`delegate_batch` accepts `mode: "parallel"` only, 1-8 children, `failurePolicy:
"collect_all"`. All children start inside one MCP call under a private semaphore;
each child gets its own task row, its own timeout/AbortController and its own trace.
`Promise.allSettled` semantics: one failure never discards another child's answer.
Parent status aggregation: all completed → `completed`; some completed →
`partial_success`; none completed → `failed`/`timed_out`/`cancelled`.

## Deterministic routing

No LLM is used to route. `requirements` map onto a configured rule set:

| Requirement flags | Rule | Default primary |
|---|---|---|
| `coding`, `repository`, `tests` | `coding` | `codex` |
| `longContext`, `multimodal` | `long_context` | `gemini` |
| `lowCost`, `structured`, `batch`, `independentReview` | `low_cost` | `deepseek` |
| `chinesePriority` | `chinese` | `glm` |
| (nothing) | `general` | configured |

The first matching rule wins; disabled, key-less or unhealthy workers are skipped
and the configured fallback chain is walked. Every decision carries a human-readable
`routeReason` plus the evaluated `candidates` and the matched rule names, so a
supervising model can audit *why* a worker was chosen.

## Extension points

- **Another worker**: implement `WorkerProvider` (`healthCheck`, `run`, optional
  `resume`), register it in `createProviders`, declare capabilities honestly.
- **Another transport**: keep the Core, add a thin entry point (HTTP, A2A, a native
  harness plugin). Nothing in the Core assumes stdio or MCP.
- **Another bridge**: LocalMCP is replaceable; `docs/localmcp-integration.md` lists
  the constraints a bridge must respect (short child timeouts, no multiplexing).
- **Persistence**: implement the `Store` interface (`src/core/types.ts`); both stores
  accept the same interface, and both must assign `events.seq` per trace atomically.
