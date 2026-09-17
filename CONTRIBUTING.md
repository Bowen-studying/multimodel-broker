# Contributing

Thanks for looking. This is a small, opinionated project: the fastest way to get a change accepted is
to keep it small, verified and honest about what it does.

## Before you start

- Node.js **22.5+** (the project uses the built-in `node:sqlite`).
- Read `docs/architecture.md` (layering) and `docs/security.md` (the rules a change must not break).

## Development loop

```bash
npm ci
npm run check      # tsc --noEmit
npm test           # vitest, offline
npm run build      # tsc -p tsconfig.build.json
node dist/cli/index.js doctor          # config / storage / workspace / provider health
```

All three gates must pass. CI runs exactly these steps and nothing that spends provider quota: the
test suite uses injected fakes and never calls a real model.

## What a good change looks like

- **Evidence over assertion.** If a change claims "this works with <provider>", include the command
  you ran and its real output (with secrets redacted). "Should work" is not evidence.
- **No new secrets, ever.** No keys, tokens, endpoint URLs that embed a secret, personal absolute
  paths or machine identifiers in code, tests, fixtures, docs or commit messages.
- **Keep the layering.** The core must not learn about MCP or ChatGPT; provider adapters must not
  learn about MCP; transport stays replaceable.
- **Honest annotations.** A tool that can mutate the machine must be advertised as such
  (`readOnlyHint: false`), and a capability that writes must be its own tool rather than hidden inside
  a read-only one.
- **Tests with the change.** A bug fix without a test that fails before it is usually not finished.
- **Small diffs.** One concern per pull request; explain the why in the description.

## Commit messages

Short imperative summary, no change-by-change narration. If the change is not obvious, the pull
request description is the place for detail.

## Reporting problems

Use issues for bugs and design questions. Use `SECURITY.md` for anything security-sensitive - not a
public issue.
