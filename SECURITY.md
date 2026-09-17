# Security policy

## Reporting a vulnerability

Report privately through GitHub's **Report a vulnerability** (Security -> Advisories) on this
repository, or open an issue that describes the impact **without** including a working exploit or any
credential. Please do not open a public issue containing a live secret, a token-shaped string, or a
reproduction that spends someone else's quota.

Expect an acknowledgement within a few days. This is a personal project without a paid support
window; fixes ship when they are ready rather than on an SLA.

## Threat model, in one paragraph

The broker sits between a remote MCP client and things that cost money or touch disk: it holds
provider credentials, it can run a local coding agent, and it can write files inside configured
workspaces. Its job is to make those powers explicit and bounded. The design rules below are the
security posture, not features - a change that breaks one of them is a security regression.

## Design rules

1. **Credentials never come from a config file.** Provider keys are read from the environment or a
   gitignored `.env`; the schema rejects a literal secret where an `*_env` variable name belongs.
2. **Secrets never reach argv or the trace.** Where a child process needs a token (for example the
   Claude Code runner) it is written to a `0600` temporary file that is deleted afterwards. Prompts
   are not stored by default (`trace.storePrompts: false`).
3. **Everything outbound is redacted.** Provider error bodies, tool output and traces pass through
   the redaction layer before they are persisted or returned; secret-shaped values are replaced, not
   echoed.
4. **Read and write capabilities are separate tools.** Tools advertised as read-only (`run_worker`,
   `delegate`) refuse write-capable adapters outright, so a file-modifying run cannot hide behind a
   read-only annotation. Writing is a local decision (`sandbox` + `allowWritableSandbox`) that a
   remote caller can never grant itself.
5. **Sensitive paths stay refused.** Credential and system trees (`~/.ssh`, `~/.aws`, `~/.gnupg`,
   `~/.hermes`, `~/.codex`, `/etc`, `/boot`, `/proc`, `/sys`, `/dev`, `/root`, `/usr`, the Windows
   system directories) are rejected even when `allowAnyWorkspace` is on.
6. **A write request is never replayed blindly.** If a write is delivered but its result is unknown
   (connection lost), the transport reports `outcome_unknown` instead of retrying; recovery is the
   caller's job through the same `idempotencyKey`.
7. **Two credentials, two blast radii.** A public entry point and the local agent endpoint use
   different secrets, and the read-only instance is never switched to the agent profile.
8. **A public URL is a credential.** Endpoint URLs that carry a secret are treated as passwords:
   never committed, never printed in full, rotated on suspicion of exposure.

## Operating advice

- Keep `max-rpm` / `max-concurrent` small; the remote endpoint spends real money per call.
- Run the read-only profile by default and the write-capable instance only when you need it.
- `doctor` reports provider health and workspace wiring without printing any secret.
