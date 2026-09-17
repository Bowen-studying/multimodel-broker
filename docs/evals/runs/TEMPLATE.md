# Run: <fixture id> — <YYYY-MM-DD>

- Fixture: `docs/evals/fixtures/<id>.json`
- Mode: `<single|parallel_compare|adjudication>`
- Workers: `<deepseek + glm>`
- Supervisor: `<model/app the verdict came from>`
- Broker commit: `<short sha>`  ·  config: `<mock/deepseek/glm …>`

## 1. Raw tool output (verbatim)

```json
<delegate_batch return: parent taskId, per-child taskId / usage / reasoningTokens / latencyMs / evidence>
```

## 2. Verdict (verbatim)

```json
<the supervisor-v0 envelope>
```

## 3. Compliance checklist

| Check | Result |
|---|---|
| Envelope structure unchanged | |
| Known conflict(s) detected | |
| A genuine agreement wrongly "corrected" (must be No) | |
| Every critical claim addressed | |
| Invented evidence / citations (must be No) | |
| `needsExternalEvidence` set honestly | |

## 4. Notes

- Latency: total / per worker
- What the protocol made awkward
- Anything the broker should have returned but did not
