# 005 – Provider capabilities: never advertise what is not implemented

Status: accepted (2026-09-16)

## Context

The stage-C plan lists Gemini's capabilities as
`["text", "long-context", "multimodal", "document-heavy"]`. Multimodal/file input is
explicitly deferred to "after the text path is complete" (task book §9.2), and the broker
never uploads local files implicitly (§13). A worker that claims `multimodal` while it can
only send text would mislead both the router and the supervising model.

## Decision

Gemini declares `["text", "long-context", "document-heavy"]` until file/multimodal input is
actually implemented and tested. DeepSeek declares
`["text", "low-cost", "structured", "batch", "second-opinion"]`, GLM declares
`["text", "chinese", "low-cost", "structured"]`, and the Mock worker declares
`["text", "mock"]`.

Capability declarations are configuration-overridable per provider
(`providers.<id>.options.capabilities`), and unknown provider ids default to `["text"]`
(never to a generous set).

## Consequences

- `list_workers` and the routing table cannot send a task type to a worker that cannot
  handle it.
- When multimodal support lands, the capability is added in the same change as the feature
  and its test.
- `tests/unit/router-providers.test.ts` asserts that `multimodal` is absent, so the gap
  cannot be papered over silently.
- V1 therefore has no worker that accepts attachments; files are only ever read as text by a
  worker that declares `files` (none in V1). Documented in `docs/known-limitations.md`.
