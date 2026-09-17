# Stable endpoint (Cloudflare named tunnel)

Decision (2026-09-17): the production entry is **one Cloudflare named tunnel** publishing two
hostnames to the two broker instances. Quick tunnels stay only as a development fallback.
ngrok and a self-hosted relay were considered and rejected for now (see "Why" below).

```text
ChatGPT Pro
   ├── https://broker.<domain>/mcp?token=<read token>   -> 127.0.0.1:8789  chatgpt-pro-readonly (7 tools)
   └── https://agent.<domain>/mcp?token=<agent token>   -> 127.0.0.1:8790  chatgpt-agent (8 tools, run_agent)

one tunnel · one config.yml · two ingress rules · two systemd units for the brokers · one for cloudflared
```

The instances stay physically separate: own token file, own SQLite (`data/broker.sqlite` /
`data/broker-agent.sqlite`), own profile, own limits. Only the network path is shared, so a tunnel
outage affects both read and write paths — accepted, because a named tunnel reconnects itself and
its hostname never changes.

## Why this over the alternatives

| Option | Why not (or why yes) |
| --- | --- |
| **Named tunnel** ✅ | Stable hostname, smallest change from the current setup, one tunnel can publish several hostnames, cloudflared reconnects on its own, no extra auth layer |
| ngrok fixed domain | Fastest, but the free endpoint shows an interstitial page unless a non-standard User-Agent/header is used - a new variable in a path that already works |
| Self-hosted relay | The right shape for a product (local agent dials out to a relay), but it re-introduces auth, device registration and connection lifecycle. Productisation, not a prerequisite for daily use |
| Quick tunnels (current) | Random hostname per restart and periodically revoked server-side; fine for development, unusable as a daily entry |

## Current state (verified 2026-09-17)

- Both broker instances run as **systemd user services** (`Linger=yes`, so they survive a WSL
  restart) with `Restart=always`:
  - `broker-readonly.service` -> 8789, `config/providers.yaml`, `chatgpt-pro-readonly`
  - `broker-agent.service` -> 8790, `config/providers.agent.yaml`, `chatgpt-agent`
  - Tokens are read from their 600 files at start (`~/.broker-m1-token`, `~/.broker-agent-token`);
    they are never copied into a unit file or the journal.
  - Node used by the units is `/home/<you>/.local/bin/node` (the symlink to the Node 22
    build shipped with Hermes - the only Node on this box). If that ever moves, the units need it too.
- Public entry today is still a **quick tunnel** per instance, supervised by
  `~/.broker-ops/broker-tunnel-supervisor.sh`. It restarts on Cloudflare's own
  `Unauthorized`/`Tunnel not found` error rather than on process death, because a revoked tunnel
  keeps its process alive.
- `~/.broker-ops/verify-entry.sh <m1|agent> <port> [--restart]` is the acceptance check: local
  healthz, public healthz, full MCP handshake (initialize -> notifications -> tools/list), a real
  `ping` call, and with `--restart` that restarting the broker keeps the same URL working.
  Measured: m1 7/7, agent 10/10 (including the restart-recovery pair).

## Cutover

```bash
# 1) one-time, interactive, account owner only (this is the current blocker):
~/.local/bin/cloudflared tunnel login          # browser flow -> ~/.cloudflared/cert.pem
# 2) everything else is scripted (idempotent, keeps the quick tunnels alive as fallback):
~/.broker-ops/setup-named-tunnel.sh <domain> [tunnel-name]
```

`setup-named-tunnel.sh` validates prerequisites, creates or reuses the tunnel, writes
`~/.cloudflared/config.yml` from `~/.broker-ops/cloudflared-config.template.yml`, routes DNS for
both hostnames, installs and starts `cloudflared-broker.service`, rewrites
`~/.broker-{m1,agent}-connector-url` (backup kept at `*.quick`), then re-runs `verify-entry.sh`
against the new hostnames.

Already validated without a domain: `bash -n` on both scripts, the not-logged-in guard (exit 2 with
instructions), `cloudflared tunnel ingress validate` on the generated config (`OK`, with
`agent.<domain>/mcp` correctly inferred as `http://127.0.0.1:8790`), and `systemd-analyze --user
verify` on the generated cloudflared unit (clean).

## Acceptance criteria (all four must hold before the quick tunnel is demoted)

```text
restart cloudflared        -> URL unchanged, both hostnames 200
restart a broker instance  -> URL unchanged, MCP handshake + tool call still work
restart WSL / the PC       -> services come back (linger) and the same URLs work
ChatGPT connectors         -> no config edit needed; ping / tools/list fine; one minimal run_agent
                              scratch write still lands on disk
```

## Rollback

```bash
cp ~/.broker-m1-connector-url.quick ~/.broker-m1-connector-url
cp ~/.broker-agent-connector-url.quick ~/.broker-agent-connector-url
systemctl --user disable --now cloudflared-broker.service
```

The quick-tunnel supervisors keep running throughout, so a rollback never leaves the entry dead.

## Still not solved by a stable endpoint

- The token still travels in the URL: ChatGPT connectors accept OAuth 2.1 or no auth, and this
  broker does not implement OAuth yet.
- No spend guard beyond request rate (see `docs/known-limitations.md`): a daily agent-run /
  input-token cap is the next piece of work after the endpoint.
- Restart recovery of in-flight tasks (v0.2 / `resumeThread`) is unchanged by any of this.
