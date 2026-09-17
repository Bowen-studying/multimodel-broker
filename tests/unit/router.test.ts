import { beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/core/config.js";
import { Router } from "../../src/core/router.js";
import type { BrokerConfig, Requirements } from "../../src/core/types.js";
import { ProviderRegistry } from "../../src/providers/provider.js";
import { MockProvider } from "../../src/providers/mock/index.js";
let config: BrokerConfig;
let registry: ProviderRegistry;
let router: Router;
beforeEach(async () => {
  config = await loadConfig(); registry = new ProviderRegistry();
  for (const id of ["code", "long", "cheap", "zh", "default"]) {
    const pc = { enabled: true, adapter: "mock" as const, maxConcurrency: 1, defaultTimeoutMs: 1000 };
    config.providers[id] = pc; registry.register(id, new MockProvider(id), pc);
  }
  config.routing = { coding: { primary: "code", fallback: ["cheap", "long"] }, long_context: { primary: "long" }, low_cost: { primary: "cheap" }, chinese: { primary: "zh" }, general: { primary: "default" } };
  router = new Router(config, registry);
});
describe("deterministic routing", () => {
  it.each<[keyof Requirements, string]>([["coding", "code"], ["repository", "code"], ["tests", "code"], ["longContext", "long"], ["multimodal", "long"], ["lowCost", "cheap"], ["structured", "cheap"], ["batch", "cheap"], ["independentReview", "cheap"], ["chinesePriority", "zh"]])("routes %s to %s", (flag, worker) => {
    const decision = router.route({ task: "test", requirements: { [flag]: true } });
    expect(decision.worker).toBe(worker); expect(decision.reason.length).toBeGreaterThan(10);
  });
  it("uses stable rule precedence and audits all matches", () => {
    expect(router.route({ task: "test", requirements: { coding: true, longContext: true, lowCost: true, chinesePriority: true } })).toMatchObject({ worker: "code", matchedRules: ["coding", "long_context", "low_cost", "chinese"] });
  });
  it("uses general or first enabled provider", () => {
    expect(router.route({ task: "test" }).worker).toBe("default");
    config.routing = {}; config.providers.code!.enabled = false;
    expect(router.route({ task: "test" }).worker).toBe("long");
  });
  it("never rewrites an explicit worker", () => {
    expect(router.route({ task: "test", worker: "zh", requirements: { coding: true } }).worker).toBe("zh");
    config.providers.zh!.enabled = false;
    expect(() => router.route({ task: "test", worker: "zh" })).toThrow(expect.objectContaining({ code: "WORKER_UNAVAILABLE" }));
  });
  it("falls back in configured order for disabled and unhealthy workers", () => {
    config.providers.code!.enabled = false;
    expect(router.route({ task: "test", requirements: { coding: true } })).toMatchObject({ worker: "cheap", fallbackFrom: "code", candidates: ["code", "cheap", "long"] });
    registry.healthCache.set("cheap", { healthy: false, checkedAt: new Date().toISOString() });
    expect(router.route({ task: "test", requirements: { coding: true } }).worker).toBe("long");
    config.providers.code!.enabled = true;
    registry.healthCache.set("code", { healthy: false, checkedAt: new Date().toISOString() });
    expect(router.route({ task: "test", requirements: { coding: true } }).worker).toBe("long");
  });
  it("reports no available candidate", () => {
    for (const pc of Object.values(config.providers)) pc.enabled = false;
    expect(() => router.route({ task: "test", requirements: { coding: true } })).toThrow(expect.objectContaining({ code: "WORKER_UNAVAILABLE" }));
  });
});
