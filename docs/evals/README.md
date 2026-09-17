# Supervisory evaluation set (M3.1)

Purpose: make "did the supervisor help?" measurable instead of a matter of taste. Each fixture
pre-writes the `criticalClaims` of a task, so a run is judged by **which claims were flagged**, not
by whether the final prose sounds good.

Protocol: `docs/supervisor-protocol.md`. Decision record: `docs/decisions/007-supervisor-layer.md`.

## Layout

```text
docs/evals/
├── README.md                 this file (schema + acceptance criteria)
├── fixtures/                 one JSON per task, pre-written claims
└── runs/                     one markdown file per executed fixture (the experiment log)
```

## Fixture schema (v1)

```json
{
  "id": "001-lattice-basis",                       // ^\d{3}-[a-z0-9-]+$, unique, file name = id + .json
  "domain": "materials-science/crystallography",
  "mode": "parallel_compare",                      // single | parallel_compare | adjudication
  "task": "<the exact question to send>",
  "criticalClaims": [                              // >= 1; the yardstick for the run
    {"claim": "<an assertion that can be ruled right or wrong>", "verdict": "required"}
  ],
  "knownFailures": [                               // optional, from real runs only
    {"worker": "glm", "taskId": "...", "observedAt": "2026-09-17T02:24:25Z",
     "claim": "<what the worker got wrong>", "explanation": "<why it is wrong>"}
  ],
  "knownCorrect": [                                // optional
    {"worker": "deepseek", "taskId": "...", "observedAt": "...", "note": "..."}
  ],
  "expectedAdjudication": {
    "mustDetect": ["<something the supervisor must notice>"],   // >= 1
    "mustNotClaim": ["<a wrong conclusion it must not reach>"],
    "resolution": "<what a correct final answer contains>"
  },
  "source": "<where the claims come from: textbook, measured run, verification probe>"
}
```

Rules:

- Only **real** `knownFailures` / `knownCorrect` entries - a run that actually happened, with the
  task id it happened under. Never fabricate a failure to make a fixture look stronger.
- Claims must be checkable by a reader who knows the domain, not "the answer should be good".
- A fixture whose claims cannot be settled is not a fixture; park it in the run log as unresolved.

`tests/unit/evals.test.ts` enforces the schema, so a malformed fixture fails the normal test run.

## Coverage the set must reach (M3.1 target: 8-12 fixtures)

| Category | Example |
|---|---|
| definition / basic concept | 001 lattice vs basis |
| subtle conceptual trap | lattice point ≠ atom occupancy |
| quantitative reasoning | 002 FCC atoms per cell + coordination number |
| materials-science context dependence | does a property value need its experiment conditions |
| both correct, different wording | must NOT be reported as a conflict |
| one correct, one wrong | must be caught |
| both incomplete | must not be silently patched into one answer |

## Current set (first batch to run, M3.2)

| Fixture | Tests | Failure mode it must expose |
|---|---|---|
| `001-lattice-basis` | definition + subtle trap | one candidate confidently wrong (GLM, measured) |
| `002-fcc-atoms-per-cell` | quantitative derivation | wrong count / coordination number, or confusing the two |
| `003-faraday-constant` | quantitative + relation | magnitude/dimension slip (e.g. answering with N_A) |
| `004-solid-solution-definition` | definition | two correct but differently-worded answers must NOT be called a conflict |
| `005-metal-vs-ceramic-toughness` | explanation | both candidates partial - must be marked incomplete, not wrong |

## Recording a run

Copy `runs/TEMPLATE.md`, name it `<YYYY-MM-DD>-<fixture-id>.md`, and fill: raw tool output
(taskIds/usage/`reasoningTokens`/latency), the verdict JSON, and the compliance checklist
(structure kept? known conflict detected? a genuine agreement wrongly "corrected"? critical claims
satisfied? any invented evidence?).

## Acceptance criteria (M3)

| Item | Pass condition |
|---|---|
| Protocol | envelope structure identical across runs |
| Error detection | the lattice/basis conflict is caught every run |
| Regression | 8-12 fixtures executed |
| Architecture | evidence to decide on `delegate_compare` and/or review persistence |
