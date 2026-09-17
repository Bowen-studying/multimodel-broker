import { BrokerError, httpStatusToErrorCode, retryableHttpStatus } from "../../core/errors.js";
import type { ProviderConfig, ProviderHealth, WorkerProvider, WorkerRequest, WorkerResult } from "../../core/types.js";
import { requireSecret } from "../../security/secrets.js";
import { classifyFetchError, healthModeOption, numberOption, recordOption, type ProviderOptionInput } from "../openai-compatible/index.js";

/**
 * Gemini via the official Google Generative Language API.
 *
 * Allowed: `https://generativelanguage.googleapis.com/v1beta/...` (or a Vertex
 * AI endpoint) with an API key / official credential chain.
 * Forbidden (task book 9.2): automating gemini.google.com, extracting OAuth
 * tokens from Gemini CLI / Antigravity, or calling undocumented endpoints.
 *
 * V1 scope: text tasks, configured model, official usage reporting, optional
 * structured output that is validated here. File/multimodal input is NOT
 * implemented, which is why the "multimodal" capability is not declared - a
 * worker must not advertise what it cannot do.
 */

export const GEMINI_CAPABILITIES = ["text", "long-context", "document-heavy"] as const;

const SYSTEM_PROMPT = "You are a worker invoked by the Multi-Model Broker. Answer the task directly and concisely. Do not ask clarifying questions.";

interface GeminiOptions {
  id: string;
  capabilities: readonly string[];
  apiKeyEnv: string;
  baseUrl: string;
  model?: string;
  apiVersion: string;
  responseMimeType?: string;
  responseSchema?: Record<string, unknown>;
  maxOutputTokens?: number;
  temperature?: number;
  healthCheckMode: "models" | "chat" | "none";
  healthTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export function geminiOptionsFrom(id: string, config: ProviderConfig, defaultBaseUrl = "https://generativelanguage.googleapis.com", defaultApiKeyEnv = "GEMINI_API_KEY"): GeminiOptions {
  const input: ProviderOptionInput = { id, capabilities: GEMINI_CAPABILITIES, config, defaultBaseUrl, defaultApiKeyEnv };
  const responseSchema = recordOption(config, "responseSchema");
  const declared = config.options?.capabilities;
  return {
    id,
    capabilities: Array.isArray(declared) && declared.every((value) => typeof value === "string") ? (declared as string[]) : GEMINI_CAPABILITIES,
    apiKeyEnv: config.apiKeyEnv ?? defaultApiKeyEnv,
    // Tolerant on purpose: a disabled provider may carry an unresolved ${ENV}
    // placeholder and must still be listed by `list_workers`.
    baseUrl: (config.baseUrl ?? input.defaultBaseUrl ?? "").trim(),
    model: config.model || undefined,
    apiVersion: (config.options?.apiVersion as string | undefined) ?? "v1beta",
    responseMimeType: config.options?.responseMimeType as string | undefined,
    responseSchema,
    maxOutputTokens: numberOption(config, "maxOutputTokens") ?? numberOption(config, "maxTokens"),
    temperature: numberOption(config, "temperature"),
    healthCheckMode: healthModeOption(config, "models"),
    healthTimeoutMs: numberOption(config, "healthTimeoutMs"),
  };
}

/** Minimal JSON Schema check (no new dependency): type + required + enum. */
export function validateAgainstSchema(value: unknown, schema: Record<string, unknown>, path = "response"): string | undefined {
  const type = schema.type;
  const typeOf = (input: unknown): string => (Array.isArray(input) ? "array" : input === null ? "null" : typeof input);
  if (typeof type === "string" && type !== "null" && typeOf(value) !== type) return `${path}: expected ${type}, received ${typeOf(value)}`;
  if (Array.isArray(schema.enum) && !schema.enum.some((allowed) => JSON.stringify(allowed) === JSON.stringify(value))) return `${path}: value is not one of the allowed enum members`;
  if (type === "object" || (type === undefined && value !== null && typeof value === "object" && !Array.isArray(value))) {
    const object = value as Record<string, unknown>;
    for (const key of Array.isArray(schema.required) ? (schema.required as string[]) : []) {
      if (!Object.hasOwn(object, key)) return `${path}: missing required key "${key}"`;
    }
    const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (Object.hasOwn(object, key)) {
        const nested = validateAgainstSchema(object[key], propertySchema, `${path}.${key}`);
        if (nested) return nested;
      }
    }
  }
  if (type === "array" && Array.isArray(value) && typeof schema.items === "object" && schema.items) {
    for (let index = 0; index < value.length; index++) {
      const nested = validateAgainstSchema(value[index], schema.items as Record<string, unknown>, `${path}[${index}]`);
      if (nested) return nested;
    }
  }
  return undefined;
}

export class GeminiProvider implements WorkerProvider {
  readonly capabilities: readonly string[];
  readonly authMode = "api-key" as const;
  private readonly options: GeminiOptions;
  private readonly fetchImpl: typeof fetch;

  constructor(idOrOptions: string | GeminiOptions, config?: ProviderConfig) {
    this.options = typeof idOrOptions === "string" ? geminiOptionsFrom(idOrOptions, config ?? { enabled: true, adapter: "gemini-api", maxConcurrency: 1, defaultTimeoutMs: 120_000 }) : idOrOptions;
    this.capabilities = this.options.capabilities;
    this.fetchImpl = this.options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  get id(): string {
    return this.options.id;
  }

  private endpoint(path: string): string {
    if (!this.options.baseUrl) throw new BrokerError("CONFIG_ERROR", `${this.options.id}: baseUrl is not configured (is the referenced environment variable set?)`);
    return `${this.options.baseUrl.replace(/\/+$/, "")}/${this.options.apiVersion}/${path.replace(/^\/+/, "")}`;
  }

  private requireModel(): string {
    if (!this.options.model) throw new BrokerError("CONFIG_ERROR", `${this.options.id}: no model configured`);
    return this.options.model;
  }

  private buildBody(prompt: string, maxOutputTokens: number): Record<string, unknown> {
    return {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      generationConfig: {
        maxOutputTokens,
        ...(this.options.temperature === undefined ? {} : { temperature: this.options.temperature }),
        ...(this.options.responseMimeType ? { responseMimeType: this.options.responseMimeType } : {}),
        ...(this.options.responseSchema ? { responseSchema: this.options.responseSchema } : {}),
      },
    };
  }

  async run(request: WorkerRequest, signal: AbortSignal): Promise<WorkerResult> {
    const key = requireSecret(this.options.apiKeyEnv);
    const model = this.requireModel();
    // Files are never uploaded implicitly (task book 13); multimodal is out of V1 scope.
    const prompt = [request.task, request.context ? `\nContext provided by the caller:\n${request.context}` : ""].join("");
    const timeout = AbortSignal.timeout(request.timeoutMs);
    const combined = AbortSignal.any([signal, timeout]);
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint(`models/${model}:generateContent`), {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify(this.buildBody(prompt, this.options.maxOutputTokens ?? 1024)),
        signal: combined,
      });
    } catch (error) {
      throw classifyFetchError(this.options.id, error, timeout, signal);
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new BrokerError(httpStatusToErrorCode(response.status), `${this.options.id}: HTTP ${response.status}${detail ? `: ${detail.replace(/\s+/g, " ").slice(0, 200)}` : ""}`, {
        retryable: retryableHttpStatus(response.status),
        httpStatus: response.status,
      });
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new BrokerError("PROVIDER_BAD_RESPONSE", `${this.options.id}: response was not valid JSON`, { retryable: false });
    }
    return this.parse(request, payload);
  }

  private parse(request: WorkerRequest, payload: unknown): WorkerResult {
    const body = payload as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }>;
      usageMetadata?: { promptTokenCount?: unknown; candidatesTokenCount?: unknown; cachedContentTokenCount?: unknown };
      modelVersion?: unknown;
    };
    const answer = (body?.candidates?.[0]?.content?.parts ?? [])
      .map((part) => (typeof part?.text === "string" ? part.text : ""))
      .join("")
      .trim();
    if (!answer) throw new BrokerError("PROVIDER_BAD_RESPONSE", `${this.options.id}: response contained no usable answer text`, { retryable: false });

    if (this.options.responseSchema || this.options.responseMimeType === "application/json") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(answer);
      } catch {
        throw new BrokerError("PROVIDER_BAD_RESPONSE", `${this.options.id}: expected JSON output but the answer was not valid JSON`, { retryable: false });
      }
      if (this.options.responseSchema) {
        const failure = validateAgainstSchema(parsed, this.options.responseSchema);
        if (failure) throw new BrokerError("PROVIDER_BAD_RESPONSE", `${this.options.id}: structured output did not match the requested schema (${failure})`, { retryable: false });
      }
    }

    const usage = body?.usageMetadata
      ? {
          inputTokens: typeof body.usageMetadata.promptTokenCount === "number" ? body.usageMetadata.promptTokenCount : undefined,
          outputTokens: typeof body.usageMetadata.candidatesTokenCount === "number" ? body.usageMetadata.candidatesTokenCount : undefined,
          cacheHitTokens: typeof body.usageMetadata.cachedContentTokenCount === "number" ? body.usageMetadata.cachedContentTokenCount : undefined,
        }
      : undefined;
    return {
      taskId: request.taskId,
      runId: request.runId,
      provider: this.options.id,
      model: typeof body?.modelVersion === "string" ? body.modelVersion : this.options.model,
      status: "completed",
      answer,
      evidence: typeof (body as { responseId?: unknown })?.responseId === "string" ? [{ type: "provider.response_id", content: (body as { responseId: string }).responseId, source: this.options.id }] : undefined,
      usage,
      traceId: "",
    };
  }

  async healthCheck(): Promise<ProviderHealth> {
    const checkedAt = new Date().toISOString();
    if (!this.options.baseUrl) {
      return { healthy: false, checkedAt, reason: `${this.options.id}: baseUrl is not configured (is the referenced environment variable set?)` };
    }
    if (this.options.healthCheckMode === "none") return { healthy: true, checkedAt, details: { mode: "none" } };
    const key = process.env[this.options.apiKeyEnv];
    if (!key) return { healthy: false, checkedAt, reason: `${this.options.apiKeyEnv} is not set` };
    const started = Date.now();
    try {
      const response = await this.fetchImpl(this.endpoint("models"), { method: "GET", headers: { "x-goog-api-key": key }, signal: AbortSignal.timeout(this.options.healthTimeoutMs ?? 5000) });
      const latencyMs = Date.now() - started;
      if (response.ok) return { healthy: true, checkedAt, details: { mode: "models", httpStatus: response.status, latencyMs, model: this.options.model } };
      return {
        healthy: false,
        checkedAt,
        reason: `${this.options.id}: health check returned HTTP ${response.status}`,
        details: { mode: "models", httpStatus: response.status, latencyMs },
      };
    } catch (error) {
      const failure = classifyFetchError(this.options.id, error, AbortSignal.timeout(5000), AbortSignal.timeout(5000));
      return { healthy: false, checkedAt, reason: failure.message, details: { mode: "models", latencyMs: Date.now() - started, code: failure.code } };
    }
  }
}
