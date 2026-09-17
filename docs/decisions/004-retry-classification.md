# 004 – Retry classification: 429, 502/503/504 and connection failures only

Status: accepted (2026-09-16)

## Context

Task book §11 says:

- retries are only for "clearly retryable 429, connection errors and *some* 5xx";
- a call that may already have produced a result must not be repeated automatically;
- automatic retries can cost money and therefore need a bound.

The stage-C plan example ("500, 500, then 200 → retried") suggests treating every 5xx as
retryable. That conflicts with the ambiguity rule above: an HTTP 500 from a chat API can
mean "the request failed before generation" (safe to retry) **or** "generation happened and
response serialization failed" (retrying double-bills).

## Decision

`retryableHttpStatus()` in `src/core/errors.ts` classifies:

| Outcome | Retried automatically |
|---|---|
| 429 | yes |
| 502, 503, 504 | yes |
| 500 | **no** |
| other 4xx / 5xx | no |
| connection refused / DNS failure (request never sent) | yes |
| socket reset after the request was sent (`ECONNRESET`, `EPIPE`, `UND_ERR_SOCKET`) | **no** |
| request timeout | yes, bounded (the worker may not have finished; no partial result was received) |

`maxRetries` (default 2) bounds every automatic retry and each attempt gets its own
AbortController and backoff (`limits.retryBaseDelayMs * 2^attempt`).

## Consequences

- A persistent 500 surfaces as `failed` with `error.code = PROVIDER_HTTP_5XX` and
  `retryable: false`. The caller (ChatGPT Pro or a local harness) can decide to re-issue the
  task, which is an explicit, visible decision rather than a silent double charge.
- `tests/integration/provider-retry.test.ts` asserts both directions: 502/503 → retried,
  bare 500 → exactly one request.
- Providers must never retry internally; retry policy lives in one place (the Broker).

## Alternatives rejected

- **Retry everything that is 5xx**: simplest, but it can double-bill on an ambiguous 500 and
  contradicts task book §11.
- **Retry nothing but 429**: would leave transient gateway errors (502/503/504, which are
  returned before generation) as hard failures, which is worse for availability at no
  correctness benefit.
