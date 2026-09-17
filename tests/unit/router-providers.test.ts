import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/core/config.js";
import { Router } from "../../src/core/router.js";
import type { BrokerConfig } from "../../src/core/types.js";
import { createProviders, capabilitiesFor } from "../../src/providers/index.js";
import { ProviderRegistry } from "../../src/providers/provider.js";

/**
 * The routing table is only useful if it is driven by the capability
 * declarations that the real providers publish. These tests build the real
 * registry (no network calls: nothing here probes a provider) and check both the
 * declarations and the deterministic fallback order.
 */
async function configWithProviders(): Promise<{ config: BrokerConfig; registry: ProviderRegistry }> {
  const config = await loadConfig();
  config.providers = {
    codex: { enabled: true, adapter: "codex-sdk", model: "auto", authMode: "codex-local", maxConcurrency: 1, defaultTimeoutMs: 600_000, sandbox: "read-only" },
    deepseek: { enabled: true, adapter: "openai-compatible", model: "test-model", baseUrl: "http://127.0.0.1:1", apiKeyEnv: "BROKER_ROUTING_KEY", maxConcurrency: 4, defaultTimeoutMs: 1000 },
    glm: { enabled: true, adapter: "openai-compatible", model: "test-model", baseUrl: "http://127.0.0.1:1", apiKeyEnv: "BROKER_ROUTING_KEY", maxConcurrency: 4, defaultTimeoutMs: 1000 },
    gemini: { enabled: false, adapter: "gemini-api", model: "test-model", baseUrl: "http://127.0.0.1:1", apiKeyEnv: "BROKER_ROUTING_KEY", maxConcurrency: 2, defaultTimeoutMs: 1000 },
  };
  config.routing = {
    coding: { primary: "codex", fallback: ["deepseek", "gemini"] },
    long_context: { primary: "gemini", fallback: ["glm", "deepseek"] },
    low_cost: { primary: "deepseek", fallback: ["glm"] },
    chinese: { primary: "glm", fallback: ["deepseek", "gemini"] },
    general: { primary: "deepseek", fallback: [] },
  };
  process.env.BROKER_ROUTING_KEY = "sk-routing-0123456789abcdef";
  const registry = createProviders(config);
  return { config, registry };
}

describe("routing driven by real provider capabilities", () => {
  it("declares capabilities per provider without hardcoding models", async () => {
    const { config, registry } = await configWithProviders();
    expect([...registry.get("deepseek")!.provider.capabilities]).toEqual(["text", "low-cost", "structured", "batch", "second-opinion"]);
    expect([...registry.get("glm")!.provider.capabilities]).toEqual(["text", "chinese", "low-cost", "structured"]);
    const gemini = registry.get("gemini")!.provider.capabilities;
    expect([...gemini]).toEqual(["text", "long-context", "document-heavy"]);
    // A worker must not advertise multimodal while file input is unimplemented.
    expect([...gemini]).not.toContain("multimodal");
    // Unknown ids are generic unless the config declares capabilities explicitly.
    expect(capabilitiesFor("something-else", config.providers.deepseek!)).toEqual(["text"]);
    expect(capabilitiesFor("custom", { ...config.providers.deepseek!, options: { capabilities: ["text", "custom"] } })).toEqual(["text", "custom"]);
  });

  it("routes requirements to the configured primary worker", async () => {
    const { config, registry } = await configWithProviders();
    const router = new Router(config, registry);
    expect(router.route({ task: "t", requirements: { lowCost: true } })).toMatchObject({ worker: "deepseek", matchedRules: ["low_cost"] });
    expect(router.route({ task: "t", requirements: { chinesePriority: true } })).toMatchObject({ worker: "glm", matchedRules: ["chinese"] });
  });

  it("walks the fallback chain when the primary is unavailable", async () => {
    const { config, registry } = await configWithProviders();
    const router = new Router(config, registry);
    // Gemini is disabled -> long_context falls back to glm.
    expect(router.route({ task: "t", requirements: { longContext: true } })).toMatchObject({ worker: "glm", fallbackFrom: "gemini", candidates: ["gemini", "glm", "deepseek"] });
    // Codex is the configured coding primary, but it runs a local agent that can write files, so
    // automatic routing skips it: only the dedicated mutating tool (run_agent) may reach it.
    expect(router.route({ task: "t", requirements: { coding: true } })).toMatchObject({ worker: "deepseek", matchedRules: ["coding"], fallbackFrom: "codex" });
    // Naming it explicitly through a read-only tool is refused with a pointer to the right one.
    expect(() => router.route({ task: "t", worker: "codex" })).toThrowError(
      expect.objectContaining({ code: "INVALID_INPUT", message: expect.stringContaining("run_agent") }),
    );
  });

  it("reports an unhealthy worker as unavailable so the router skips it", async () => {
    const { config, registry } = await configWithProviders();
    registry.healthCache.set("deepseek", { healthy: false, checkedAt: new Date().toISOString(), reason: "HTTP 503" });
    const router = new Router(config, registry);
    expect(router.route({ task: "t", requirements: { lowCost: true } })).toMatchObject({ worker: "glm", fallbackFrom: "deepseek" });
    registry.healthCache.set("glm", { healthy: false, checkedAt: new Date().toISOString(), reason: "HTTP 503" });
    expect(() => router.route({ task: "t", requirements: { lowCost: true } })).toThrow(expect.objectContaining({ code: "WORKER_UNAVAILABLE" }));
    const workers = registry.workerInfo();
    expect(workers.find((worker) => worker.id === "deepseek")).toMatchObject({ healthy: false, reasonUnavailable: "HTTP 503" });
  });
});
