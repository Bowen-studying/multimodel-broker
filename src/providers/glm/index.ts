import type { ProviderConfig } from "../../core/types.js";
import { OpenAiCompatibleProvider, openAiCompatibleOptions } from "../openai-compatible/index.js";

/**
 * GLM / Zhipu (official API, OpenAI-compatible surface).
 *
 * Kept as its own config + capability declaration even though it shares the
 * adapter: GLM is the Chinese-first worker, and its base URL, model and body
 * extras are independent of DeepSeek's.
 */
export const GLM_CAPABILITIES = ["text", "chinese", "low-cost", "structured"] as const;

export class GlmProvider extends OpenAiCompatibleProvider {
  constructor(id: string, config: ProviderConfig) {
    super(
      openAiCompatibleOptions({
        id,
        capabilities: GLM_CAPABILITIES,
        config,
        defaultBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
        defaultApiKeyEnv: "GLM_API_KEY",
        // BigModel v4 exposes /chat/completions under the versioned base path;
        // /models is not guaranteed, so the health check falls back to a chat probe.
        defaultChatPath: "/chat/completions",
        defaultModelsPath: "/models",
      }),
    );
  }
}
