import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { collectDoctorReport } from "../../src/cli/doctor.js";

/**
 * Doctor is the operator-facing truth reporter. These tests cover the warnings it
 * adds for configurations that weaken the read-only promise the MCP tools make.
 * They never touch the network: the only provider configured is Codex, whose
 * probe is an SDK import plus an auth-file existence check.
 */
let tempDir: string | undefined;

afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

async function reportFor(providerYaml: string) {
  tempDir = await mkdtemp(path.join(tmpdir(), "broker-doctor-"));
  const configPath = path.join(tempDir, "broker.yaml");
  await writeFile(configPath, `providers:\n${providerYaml}`, "utf8");
  return collectDoctorReport({ configPath });
}

const CODEX_HEADER = `  codex:
    enabled: true
    adapter: codex-sdk
    model: auto
    authMode: codex-local
    maxConcurrency: 1
    defaultTimeoutMs: 5000
    sandbox: read-only
`;

describe("doctor warnings", () => {
  it("stays quiet about egress for a default read-only Codex worker", async () => {
    const { report } = await reportFor(`${CODEX_HEADER}    options: { requireWorkspace: false }\n`);
    expect(report.warnings.join("\n")).not.toContain("network egress");
    expect(report.warnings.join("\n")).not.toContain("web search");
  });

  it("warns when network egress is allowed, because the read-only annotation no longer holds", async () => {
    const { report } = await reportFor(`${CODEX_HEADER}    options: { requireWorkspace: false, allowNetworkAccess: true, networkAccessEnabled: true }\n`);
    expect(report.warnings.join("\n")).toContain("network egress");
  });

  it("warns when web search is allowed", async () => {
    const { report } = await reportFor(`${CODEX_HEADER}    options: { requireWorkspace: false, allowWebSearch: true, webSearchMode: live }\n`);
    expect(report.warnings.join("\n")).toContain("web search");
  });
});
