import type { BrokerConfig, Logger, ProviderConfig, WorkerProvider } from "../core/types.js";
import { BrokerError } from "../core/errors.js";
import { ClaudeCodeProvider } from "./claude-code/index.js";
import { CodexProvider } from "./codex/index.js";
import { DeepSeekProvider, DEEPSEEK_CAPABILITIES } from "./deepseek/index.js";
import { GeminiProvider, GEMINI_CAPABILITIES } from "./gemini/index.js";
import { GlmProvider, GLM_CAPABILITIES } from "./glm/index.js";
import { MockProvider } from "./mock/index.js";
import { OpenAiCompatibleProvider, openAiCompatibleOptions } from "./openai-compatible/index.js";
import { ProviderRegistry } from "./provider.js";

/** Minimal logging surface a provider factory needs. */
export type FactoryLogger = Pick<Logger, "warn">;

/** Default capability declarations, keyed by provider id (never by model id). */
const KNOWN_CAPABILITIES: Record<string, readonly string[]> = {
  deepseek: DEEPSEEK_CAPABILITIES,
  glm: GLM_CAPABILITIES,
  gemini: GEMINI_CAPABILITIES,
};

export function capabilitiesFor(id: string, config: ProviderConfig): readonly string[] {
  const declared = config.options?.capabilities;
  if (Array.isArray(declared) && declared.every((value) => typeof value === "string")) return declared as string[];
  return KNOWN_CAPABILITIES[id] ?? ["text"];
}

/**
 * Build the provider registry from configuration.
 *
 * - `mock` -> MockProvider (used by tests and M0)
 * - `openai-compatible` -> DeepSeekProvider / GlmProvider by id, otherwise a
 *   generic OpenAI-compatible provider with config-declared capabilities
 * - `gemini-api` -> GeminiProvider (official Generative Language API only)
 * - `codex-sdk` -> registered by the Codex milestone; until then it is reported
 *   as unavailable instead of silently disappearing.
 *
 * Providers whose adapter this build cannot serve are NOT registered, so the
 * router can never select a stub worker.
 */
export function createProviders(config: BrokerConfig, logger?: FactoryLogger): ProviderRegistry {
  const registry = new ProviderRegistry();
  const unregistered: string[] = [];
  for (const [id, providerConfig] of Object.entries(config.providers)) {
    const provider = buildProvider(id, providerConfig);
    if (!provider) {
      unregistered.push(`${id}:${providerConfig.adapter}`);
      continue;
    }
    registry.register(id, provider, providerConfig);
  }
  if (unregistered.length) {
    logger?.warn("Configured providers without an implementation in this build were not registered", { providers: unregistered });
  }
  return registry;
}

export function buildProvider(id: string, config: ProviderConfig): WorkerProvider | undefined {
  switch (config.adapter) {
    case "mock":
      return new MockProvider(id, config);
    case "openai-compatible":
      if (id === "deepseek") return new DeepSeekProvider(id, config);
      if (id === "glm") return new GlmProvider(id, config);
      return new OpenAiCompatibleProvider(
        openAiCompatibleOptions({ id, capabilities: capabilitiesFor(id, config), config }),
      );
    case "gemini-api":
      return new GeminiProvider(id, config);
    case "codex-sdk":
      // Codex relies on the user's official Codex login; a missing SDK is
      // reported as "codex sdk not installed" by healthCheck instead of crashing.
      return new CodexProvider(id, config);
    case "claude-code":
      // Local Claude Code CLI on the DeepSeek backend, run headlessly. Write-capable: it is only
      // reachable through `run_agent(worker="claude-code")`, never through the read-only ones.
      return new ClaudeCodeProvider(id, config);
    default:
      throw new BrokerError("CONFIG_ERROR", `provider ${id}: unknown adapter`);
  }
}
