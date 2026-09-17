import type { ProviderConfig } from "../../core/types.js";
import { OpenAiCompatibleProvider, openAiCompatibleOptions } from "../openai-compatible/index.js";

/**
 * DeepSeek (official API, OpenAI-compatible surface).
 *
 * Provider-specific knobs live in `config.options` and are never assumed to be
 * shared with GLM: `chatPath`, `modelsPath`, `healthCheck`, `extraBody`,
 * `maxTokens`, `temperature`. The model id comes from configuration
 * (`DEEPSEEK_MODEL`) and is never hardcoded in business logic.
 */
export const DEEPSEEK_CAPABILITIES = ["text", "low-cost", "structured", "batch", "second-opinion"] as const;

export class DeepSeekProvider extends OpenAiCompatibleProvider {
  constructor(id: string, config: ProviderConfig) {
    super(
      openAiCompatibleOptions({
        id,
        capabilities: DEEPSEEK_CAPABILITIES,
        config,
        defaultBaseUrl: "https://api.deepseek.com",
        defaultApiKeyEnv: "DEEPSEEK_API_KEY",
        // Verified against the official docs (2026-09): base https://api.deepseek.com,
        // chat endpoint /chat/completions, models list /models.
        defaultChatPath: "/chat/completions",
        defaultModelsPath: "/models",
      }),
    );
  }
}
