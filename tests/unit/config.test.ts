import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/core/config.js";
import { loadEnvFile, resolveEnvRefs, describeSecret, requireSecret } from "../../src/security/secrets.js";
let directory: string;
beforeEach(async () => { directory = await mkdtemp(path.join(os.tmpdir(), "broker-config-")); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); delete process.env.BROKER_TEST_ENV; delete process.env.BROKER_TEST_NEW; });
describe("config and secrets", () => {
  it("loads the full example and applies every default to empty nested objects", async () => {
    const example = await loadConfig({ path: "config/providers.example.yaml", env: {} });
    expect(example.providers.gemini?.enabled).toBe(false); expect(example.trace.storePrompts).toBe(false);
    const file = path.join(directory, "config.yaml");
    await writeFile(file, "providers:\n  test: {}\nlimits: {}\ntrace: {}\nstorage: {}\nserver: {}\nconcurrency: {}\n");
    const config = await loadConfig({ path: file });
    expect(config.providers.test).toMatchObject({ enabled: false, adapter: "mock", maxConcurrency: 1, defaultTimeoutMs: 60000 });
    expect(config.limits).toEqual((await loadConfig()).limits); expect(config.concurrency.global).toBe(5);
  });
  it("resolves scalar placeholders without allowing YAML injection", async () => {
    const file = path.join(directory, "config.yaml");
    await writeFile(file, 'providers:\n  test:\n    model: "${MODEL}"\n');
    expect((await loadConfig({ path: file, env: { MODEL: "x\nenabled: true" } })).providers.test?.model).toBe("x\nenabled: true");
    expect(resolveEnvRefs("${MISSING}", {})).toBe("");
  });
  it.each(["limits:\n  maxFiles: -1", "providers:\n  test:\n    maxConcurrency: 0", "limits:\n  maxWaitMs: 50000", "routing:\n  coding:\n    primary: missing"])("reports a readable config path: %s", async (yaml) => {
    const file = path.join(directory, "bad.yaml"); await writeFile(file, yaml);
    await expect(loadConfig({ path: file })).rejects.toMatchObject({ code: "CONFIG_ERROR", message: expect.stringMatching(/limits|providers|routing/) });
  });
  it("parses env values without overwriting existing variables or exposing secret values", async () => {
    const file = path.join(directory, ".env"); process.env.BROKER_TEST_ENV = "existing";
    await writeFile(file, '# ignored\nBROKER_TEST_ENV=replacement\nexport BROKER_TEST_NEW="a=b # value"\nnot an assignment\n');
    await loadEnvFile(file);
    expect(process.env.BROKER_TEST_ENV).toBe("existing"); expect(process.env.BROKER_TEST_NEW).toBe("a=b # value");
    expect(describeSecret("BROKER_TEST_NEW")).toBe("set"); expect(describeSecret("ABSENT", {})).toBe("missing");
    expect(requireSecret("X", { X: "private-value" })).toBe("private-value");
    expect(() => requireSecret("ABSENT", {})).toThrow(expect.objectContaining({ code: "SECRET_MISSING" }));
    await expect(loadEnvFile(path.join(directory, "missing.env"))).resolves.toBeUndefined();
  });
  it("rejects an enabled provider whose placeholder never resolved, but still allows a disabled one", async () => {
    const enabled = path.join(directory, "enabled.yaml");
    await writeFile(
      enabled,
      [
        "providers:",
        "  deepseek:",
        "    enabled: true",
        "    adapter: openai-compatible",
        "    baseUrl: ${BROKER_TEST_UNSET_BASE_URL}",
        "    model: some-model",
        "    apiKeyEnv: BROKER_TEST_KEY",
        "",
      ].join("\n"),
    );
    await expect(loadConfig({ path: enabled, env: {} })).rejects.toMatchObject({ code: "CONFIG_ERROR", message: expect.stringMatching(/baseUrl/) });

    // The same provider disabled still loads, so list_workers can report it.
    const disabled = path.join(directory, "disabled.yaml");
    await writeFile(disabled, (await readFile(enabled, "utf8")).replace("enabled: true", "enabled: false"));
    expect((await loadConfig({ path: disabled, env: {} })).providers.deepseek?.enabled).toBe(false);
  });
  it("accepts every profile from the canonical list and rejects anything else", async () => {
    // Regression: adding a profile to the registry without the config enum made
    // `server.defaultProfile: chatgpt-agent` a CONFIG_ERROR at startup.
    const ok = path.join(directory, "profile-ok.yaml");
    await writeFile(ok, "server:\n  defaultProfile: chatgpt-agent\n");
    expect((await loadConfig({ path: ok, env: {} })).server.defaultProfile).toBe("chatgpt-agent");

    const bad = path.join(directory, "profile-bad.yaml");
    await writeFile(bad, "server:\n  defaultProfile: chatgpt-pro-write\n");
    await expect(loadConfig({ path: bad, env: {} })).rejects.toMatchObject({ code: "CONFIG_ERROR" });
  });

  it("requires a model id for an enabled API provider and never hardcodes one", async () => {
    const file = path.join(directory, "nomodel.yaml");
    await writeFile(file, "providers:\n  glm:\n    enabled: true\n    adapter: openai-compatible\n    baseUrl: https://example.invalid\n");
    await expect(loadConfig({ path: file, env: {} })).rejects.toMatchObject({ code: "CONFIG_ERROR", message: expect.stringMatching(/model/) });
  });
});
