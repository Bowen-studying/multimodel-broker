# Third-party notices

This repository contains no copied source code from third-party projects. The
optional LocalMCP fork described in `docs/localmcp-integration.md` (route 2) does not
exist yet; if it is ever created it must live in its own repository, keep the MIT
LICENSE and the original copyright notices, and add its upstream commit/version here.

Runtime dependencies (installed from npm, not vendored):

| Package | Purpose | License |
|---|---|---|
| `@modelcontextprotocol/sdk` | MCP server/client implementation (stdio transport, `registerTool`, JSON-RPC) | MIT |
| `zod` | input validation / schemas | MIT |
| `yaml` | configuration parsing | ISC |
| `@openai/codex-sdk` (optional) | Codex worker adapter | Apache-2.0 (see the package) |

Development dependencies: `typescript`, `vitest`, `tsx`, `@types/node`. Node's
built-in `node:sqlite` is used for persistence, so no native SQLite binding is
vendored or bundled.

Product names (ChatGPT, Codex, Gemini, DeepSeek, GLM, LocalMCP) are trademarks of
their respective owners and are referenced only to describe interoperability.
