# Plugin wrapper (Codex / ChatGPT plugin surfaces)

This directory tree is a **thin packaging layer** around the broker. It contains no broker
code: the MCP server, the tools and the routing all stay where they were.

```
.agents/plugins/marketplace.json          <- repo marketplace index (Codex reads this)
plugins/multimodel-broker/
├─ .codex-plugin/plugin.json              <- plugin manifest
└─ .app.json                              <- binds the plugin to an existing ChatGPT app/connector
```

## Where the structure comes from (verified, not invented)

- `openai/plugins` (the official example repo) keeps exactly this layout:
  `.agents/plugins/marketplace.json`, plus `plugins/<name>/.codex-plugin/plugin.json`,
  optional `.app.json`, `.mcp.json`, `skills/`, `assets/`. Real examples read while building
  this: `plugins/figma/.app.json` → `{"apps":{"figma":{"id":"connector_68df038e0ba48191908c8434991bbac2"}}}`,
  `plugins/figma/.codex-plugin/plugin.json`, `plugins/airtable/.mcp.json`.
- The official `plugin-creator` skill (`openai/plugins/.agents/skills/plugin-creator/SKILL.md`)
  documents the marketplace rules used here: repo marketplaces live at
  `<repo-root>/.agents/plugins/marketplace.json`, every entry needs
  `policy.installation` (`NOT_AVAILABLE` | `AVAILABLE` | `INSTALLED_BY_DEFAULT`),
  `policy.authentication` (`ON_INSTALL` | `ON_USE`) and a `category`; `displayName` belongs to
  the marketplace `interface`, not to the entry.
- The scaffold in this repository was generated with the official script
  (`create_basic_plugin.py multimodel-broker --path ./plugins --with-apps --with-marketplace`)
  and then filled in, so the field names are not guesses.

`node scripts/check-plugin.mjs` re-checks all of the above on every CI run, including the rule
that matters most here: **the wrapper must never contain the MCP endpoint URL, its token, or a
provider key.**

## Why `.app.json` and not `.mcp.json`

- `.app.json` binds the plugin to the app/connector that already exists in your account, so the
  plugin adds no new endpoint, no new secret and no new credential to store.
- `.mcp.json` would have to carry a **reachable** MCP URL. Today that URL is a rotating
  `trycloudflare.com` quick tunnel with the token in the query string: committing it would leak a
  credential and break on the next restart. If a stable, authenticated endpoint ever exists
  (Secure MCP Tunnel or the project's own relay), `.mcp.json` becomes an option - with the URL
  and credentials kept out of git.
- OpenAI's docs also note that local/repo marketplaces are authoring and team-distribution
  sources whose availability varies by surface, while public listing goes through the plugin
  directory. So this wrapper is the Codex-side route; the ChatGPT web route is the developer-mode
  App/connector itself.

## Fill this in before installing

`plugins/multimodel-broker/.app.json` still holds `REPLACE_WITH_CONNECTOR_ID`. Replace it with the
id of the MCP app/connector created in ChatGPT (developer mode). The official examples use the
form `connector_<32 hex chars>`; use whatever your account shows. `npm run check:plugin` prints a
WARN - not an error - while the placeholder is still there.

If the ChatGPT UI does not expose an id, the plugin cannot bind yet: use the connector directly in
ChatGPT, and treat the wrapper as preparation for the Codex surface.

## Adding the repo marketplace (the dialog in Codex)

| Field | Value |
|---|---|
| 来源 / Source | `Bowen-studying/multimodel-broker` |
| Git 引用 / Ref | `master` |
| 稀疏路径 / Sparse paths | leave empty (the repo is small; no sparse checkout needed) |

Then: the marketplace lists **Multimodel Broker** → install it → the plugin reads `.app.json` →
the app's tools (`ping`, `list_workers`, `run_worker`, `delegate`, `delegate_batch`, `get_task`,
`get_trace`) become callable.

## Honest status

- The wrapper files and their schema are verified against the official repo and skill.
- Installing this plugin in Codex, and using the bound app from ChatGPT, has **not** been done
  yet by a human; nothing here claims that path works.
- The broker's own MCP surface is verified separately (`docs/remote-mcp.md`,
  `docs/remote-mcp.md`).
