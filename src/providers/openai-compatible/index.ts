import { readFile } from "node:fs/promises";
import { BrokerError, httpStatusToErrorCode, isBrokerError, retryableHttpStatus, toBrokerError } from "../../core/errors.js";
import type { ProviderConfig, ProviderHealth, WorkerProvider, WorkerRequest, WorkerResult } from "../../core/types.js";
import { requireSecret } from "../../security/secrets.js";

/**
 * Shared base for OpenAI-compatible chat-completions APIs (DeepSeek, GLM, ...).
 *
 * Design rules (task book 9.3, 9.4):
 * - Nothing here assumes full OpenAI compatibility: everything provider-specific
 *   lives in `config.options` (`chatPath`, `healthCheck`, `extraBody`, ...).
 * - A provider never orchestrates retries: it throws a classified `BrokerError`
 *   and the Broker decides whether a retry is safe and affordable.
 * - Reasoning/thinking fields (`reasoning_content`, `reasoning`, `thinking`) are
 *   dropped on the floor: hidden chain-of-thought is never stored, traced or
 *   returned.
 * - The API key is resolved at call time, never stored on the instance, and never
 *   appears in an error message, a log line, a trace or a result.
 */

export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

export interface OpenAiCompatibleOptions {
  id: string;
  capabilities: readonly string[];
  /** Environment variable that holds the API key. */
  apiKeyEnv?: string;
  /** Base URL without the chat path, e.g. https://api.deepseek.com. */
  baseUrl: string;
  model?: string;
  authMode?: "api-key" | "vertex" | "unknown";
  /** Defaults to "/v1/chat/completions". */
  chatPath?: string;
  /** Defaults to "/models". */
  modelsPath?: string;
  /** "models" (default) | "chat" | "none". */
  healthCheckMode?: "models" | "chat" | "none";
  /** Extra body keys merged into every chat request (provider-specific knobs). */
  extraBody?: Record<string, unknown>;
  maxTokens?: number;
  temperature?: number;
  /** Health probe budget. */
  healthTimeoutMs?: number;
  /** Test seam; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Optional system prompt prefix override. */
  systemPrompt?: string;
}

export interface ChatRequestOptions {
  signal?: AbortSignal;
  /** Overrides `maxTokens` (used by the 1-token health probe). */
  maxTokens?: number;
  /** Overrides the chat path (used by health probes). */
  body?: Record<string, unknown>;
}

export interface ProviderOptionInput {
  id: string;
  capabilities: readonly string[];
  config: ProviderConfig;
  defaultBaseUrl?: string;
  defaultApiKeyEnv?: string;
  /** Provider-specific endpoint defaults (never assumed to be OpenAI's paths). */
  defaultChatPath?: string;
  defaultModelsPath?: string;
}

function stringOption(config: ProviderConfig, key: string): string | undefined {
  const value = config.options?.[key];
  return typeof value === "string" && value ? value : undefined;
}

export function numberOption(config: ProviderConfig, key: string): number | undefined {
  const value = config.options?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function recordOption(config: ProviderConfig, key: string): Record<string, unknown> | undefined {
  const value = config.options?.[key];
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export function healthModeOption(config: ProviderConfig, fallback: "models" | "chat" | "none" = "models"): "models" | "chat" | "none" {
  const value = config.options?.healthCheck;
  return value === "models" || value === "chat" || value === "none" ? value : fallback;
}

/** Build the base options for an OpenAI-compatible provider from its config entry. */
export function openAiCompatibleOptions(input: ProviderOptionInput): OpenAiCompatibleOptions {
  const { config } = input;
  // NOTE: construction is deliberately tolerant about a missing base URL. A
  // *disabled* provider may legitimately carry an unresolved ${ENV} placeholder,
  // and it must still be constructible so `list_workers` can report it. An
  // *enabled* provider with a missing/empty base URL is rejected by the config
  // loader, and `run()`/`healthCheck()` fail loudly if it slips through.
  return {
    id: input.id,
    capabilities: input.capabilities,
    apiKeyEnv: config.apiKeyEnv ?? input.defaultApiKeyEnv,
    baseUrl: (config.baseUrl ?? input.defaultBaseUrl ?? "").trim(),
    model: config.model || undefined,
    authMode: config.authMode === "vertex" ? "vertex" : "api-key",
    chatPath: stringOption(config, "chatPath") ?? input.defaultChatPath,
    modelsPath: stringOption(config, "modelsPath") ?? input.defaultModelsPath,
    healthCheckMode: healthModeOption(config, "models"),
    extraBody: recordOption(config, "extraBody"),
    maxTokens: numberOption(config, "maxTokens"),
    temperature: numberOption(config, "temperature"),
    healthTimeoutMs: numberOption(config, "healthTimeoutMs"),
    systemPrompt: stringOption(config, "systemPrompt"),
  };
}

const DEFAULT_SYSTEM_PROMPT =
  "You are a worker invoked by the Multi-Model Broker. Answer the task directly and concisely. Do not ask clarifying questions.";

const CONNECT_ERROR_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_DNS_RESOLVE_FAILED"]);
const POST_SEND_ERROR_CODES = new Set(["ECONNRESET", "EPIPE", "UND_ERR_SOCKET", "ERR_STREAM_PREMATURE_CLOSE"]);

function errorCodeOf(error: unknown): string | undefined {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const candidate = current as { code?: unknown; cause?: unknown; message?: unknown };
    if (typeof candidate.code === "string") return candidate.code;
    current = candidate.cause;
  }
  return undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class OpenAiCompatibleProvider implements WorkerProvider {
  readonly capabilities: readonly string[];
  readonly authMode: "api-key" | "vertex" | "unknown";
  protected readonly options: OpenAiCompatibleOptions;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAiCompatibleOptions) {
    this.options = options;
    this.capabilities = options.capabilities;
    this.authMode = options.authMode ?? "api-key";
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  /** An empty base URL means the config placeholder was never resolved. */
  private requireBaseUrl(): string {
    if (!this.options.baseUrl) throw new BrokerError("CONFIG_ERROR", `${this.options.id}: baseUrl is not configured (is the referenced environment variable set?)`);
    return this.options.baseUrl;
  }

  get id(): string {
    return this.options.id;
  }

  get model(): string | undefined {
    return this.options.model;
  }

  private endpoint(path: string): string {
    if (!this.options.baseUrl) throw new BrokerError("CONFIG_ERROR", `${this.options.id}: baseUrl is not configured (is the referenced environment variable set?)`);
    return `${this.options.baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
  }

  /** Resolve the key at call time; a missing key is a non-retryable configuration error. */
  protected apiKey(required = true): string | undefined {
    const name = this.options.apiKeyEnv;
    if (!name) {
      if (required) throw new BrokerError("CONFIG_ERROR", `${this.options.id}: apiKeyEnv is not configured`);
      return undefined;
    }
    if (!required) return process.env[name];
    return requireSecret(name);
  }

  protected authHeaders(key: string | undefined): Record<string, string> {
    return key ? { Authorization: `Bearer ${key}` } : {};
  }

  /** Build the chat messages. Never uploads files unless the provider declares "files". */
  protected async buildMessages(request: WorkerRequest): Promise<ChatMessage[]> {
    const messages: ChatMessage[] = [{ role: "system", content: this.options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT }];
    const parts: string[] = [request.task];
    if (request.context) parts.push(`\nContext provided by the caller:\n${request.context}`);
    if (this.capabilities.includes("files") && request.resolvedFiles?.length) {
      for (const file of request.resolvedFiles) {
        let content: string;
        try {
          content = await readFile(file, "utf8");
        } catch {
          throw new BrokerError("FILE_NOT_FOUND", "Attached workspace file could not be read");
        }
        parts.push(`\n--- file: ${file} ---\n${content}`);
      }
    }
    messages.push({ role: "user", content: parts.join("\n") });
    return messages;
  }

  /** POST a chat completion. Throws classified `BrokerError`s only. */
  protected async chat(messages: ChatMessage[], timeoutMs: number, signal: AbortSignal, options: ChatRequestOptions = {}): Promise<{ status: number; json: unknown }> {
    const body: Record<string, unknown> = {
      model: this.options.model,
      messages,
      max_tokens: options.maxTokens ?? this.options.maxTokens ?? 1024,
      stream: false,
      ...(this.options.temperature === undefined ? {} : { temperature: this.options.temperature }),
      ...(this.options.extraBody ?? {}),
      ...(options.body ?? {}),
    };
    const key = this.apiKey();
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = options.signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint(this.options.chatPath ?? "/v1/chat/completions"), {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", ...this.authHeaders(key) },
        body: JSON.stringify(body),
        signal: combined,
      });
    } catch (error) {
      throw this.translateNetworkError(error, timeout, signal);
    }
    if (!response.ok) {
      // Read (and drop) the body so the socket can be reused; never surface it raw.
      const detail = await response.text().catch(() => "");
      throw new BrokerError(httpStatusToErrorCode(response.status), `${this.options.id}: HTTP ${response.status}${summariseProviderError(detail)}`, {
        retryable: retryableHttpStatus(response.status),
        httpStatus: response.status,
      });
    }
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new BrokerError("PROVIDER_BAD_RESPONSE", `${this.options.id}: response was not valid JSON`, { retryable: false });
    }
    return { status: response.status, json };
  }

  /**
   * Connection failures are classified by whether the request can have been
   * received: a refused/resolved-failed connection never reached the provider
   * (safe to retry), a socket reset after send may already have been processed
   * and billed (never retried automatically).
   */
  private translateNetworkError(error: unknown, timeout: AbortSignal, callerSignal: AbortSignal): BrokerError {
    return classifyFetchError(this.options.id, error, timeout, callerSignal);
  }

  /** Extract the answer, usage and model, ignoring any reasoning field. */
  protected parseCompletion(payload: unknown): { answer: string; model?: string; usage: WorkerResult["usage"]; responseId?: string } {
    const body = payload as {
      id?: unknown;
      model?: unknown;
      choices?: Array<{ message?: { content?: unknown } }>;
      usage?: {
        prompt_tokens?: unknown;
        completion_tokens?: unknown;
        total_tokens?: unknown;
        prompt_cache_hit_tokens?: unknown;
        prompt_tokens_details?: { cached_tokens?: unknown } | null;
        completion_tokens_details?: { reasoning_tokens?: unknown } | null;
      } | null;
    };
    const raw = body?.choices?.[0]?.message?.content;
    const answer = typeof raw === "string" ? raw : Array.isArray(raw) ? raw.map((part) => (typeof part === "string" ? part : (part as { text?: string })?.text ?? "")).join("") : "";
    if (!answer.trim()) {
      // Deliberately no fallback to `reasoning_content`: hidden chain-of-thought
      // is not an answer and must never leak into a result or a trace.
      throw new BrokerError("PROVIDER_BAD_RESPONSE", `${this.options.id}: response contained no usable answer text`, { retryable: false });
    }
    const usage = body?.usage
      ? {
          inputTokens: typeof body.usage.prompt_tokens === "number" ? body.usage.prompt_tokens : undefined,
          outputTokens: typeof body.usage.completion_tokens === "number" ? body.usage.completion_tokens : undefined,
          // Reasoning models bill hidden reasoning inside completion_tokens (DeepSeek
          // reported 341 completion tokens for a 165-character answer, 249 of them
          // reasoning). Recording it separately is what makes a cross-provider cost or
          // efficiency comparison honest instead of apples-to-oranges.
          reasoningTokens:
            typeof body.usage.completion_tokens_details?.reasoning_tokens === "number"
              ? body.usage.completion_tokens_details.reasoning_tokens
              : undefined,
          cacheHitTokens:
            typeof body.usage.prompt_cache_hit_tokens === "number"
              ? body.usage.prompt_cache_hit_tokens
              : typeof body.usage.prompt_tokens_details?.cached_tokens === "number"
                ? body.usage.prompt_tokens_details.cached_tokens
                : undefined,
        }
      : undefined;
    return { answer, model: typeof body?.model === "string" ? body.model : this.options.model, usage, responseId: typeof body?.id === "string" ? body.id : undefined };
  }

  async run(request: WorkerRequest, signal: AbortSignal): Promise<WorkerResult> {
    const messages = await this.buildMessages(request);
    const { json } = await this.chat(messages, request.timeoutMs, signal);
    const parsed = this.parseCompletion(json);
    return {
      taskId: request.taskId,
      runId: request.runId,
      provider: this.options.id,
      model: parsed.model,
      status: "completed",
      answer: parsed.answer,
      // The provider's own request id, when it returns one: the auditable handle
      // a human can use to reconcile a real (billed) call.
      evidence: parsed.responseId ? [{ type: "provider.response_id", content: parsed.responseId, source: this.options.id }] : undefined,
      usage: parsed.usage,
      traceId: "",
    };
  }

  async healthCheck(): Promise<ProviderHealth> {
    const checkedAt = new Date().toISOString();
    if (!this.options.baseUrl) {
      return { healthy: false, checkedAt, reason: `${this.options.id}: baseUrl is not configured (is the referenced environment variable set?)` };
    }
    const mode = this.options.healthCheckMode ?? "models";
    if (mode === "none") return { healthy: true, checkedAt, details: { mode } };
    const key = this.apiKey(false);
    if (this.options.apiKeyEnv && !key) {
      return { healthy: false, checkedAt, reason: `${this.options.apiKeyEnv} is not set` };
    }
    const started = Date.now();
    const timeout = AbortSignal.timeout(this.options.healthTimeoutMs ?? 5000);
    const attempt = async (which: "models" | "chat"): Promise<ProviderHealth> => {
      try {
        const response =
          which === "models"
            ? await this.fetchImpl(this.endpoint(this.options.modelsPath ?? "/models"), { method: "GET", headers: { Accept: "application/json", ...this.authHeaders(key) }, signal: timeout })
            : await this.fetchImpl(this.endpoint(this.options.chatPath ?? "/v1/chat/completions"), {
                method: "POST",
                headers: { "Content-Type": "application/json", ...this.authHeaders(key) },
                body: JSON.stringify({ model: this.options.model, messages: [{ role: "user", content: "ping" }], max_tokens: 1, stream: false }),
                signal: timeout,
              });
        const latencyMs = Date.now() - started;
        if (response.ok) return { healthy: true, checkedAt, details: { mode: which, httpStatus: response.status, latencyMs } };
        if (which === "models" && [404, 405, 501].includes(response.status)) return attempt("chat");
        return {
          healthy: false,
          checkedAt,
          reason: `${this.options.id}: health check returned HTTP ${response.status}`,
          details: { mode: which, httpStatus: response.status, latencyMs },
        };
      } catch (error) {
        const failure = this.translateNetworkError(error, timeout, timeout);
        const latencyMs = Date.now() - started;
        if (which === "models" && failure.code === "PROVIDER_ERROR") return attempt("chat");
        return { healthy: false, checkedAt, reason: failure.message, details: { mode: which, latencyMs, code: failure.code } };
      }
    };
    return attempt(mode === "chat" ? "chat" : "models");
  }
}

/**
 * Connection failures are classified by whether the request can have been
 * received: a refused / unresolvable connection never reached the provider
 * (safe to retry), a socket reset after send may already have been processed
 * and billed (never retried automatically). Shared with the Gemini adapter so
 * every provider classifies transport failures identically.
 */
export function classifyFetchError(providerId: string, error: unknown, timeout: AbortSignal, callerSignal: AbortSignal): BrokerError {
  if (isBrokerError(error)) return error;
  const name = (error as { name?: string })?.name;
  if (name === "AbortError" || name === "TimeoutError") {
    if (callerSignal.aborted) {
      const reason = callerSignal.reason;
      return isBrokerError(reason) ? reason : new BrokerError("CANCELLED", "Caller aborted the request", { retryable: false });
    }
    return new BrokerError("TIMEOUT", `${providerId}: request exceeded its deadline`, { retryable: true, cause: error });
  }
  const code = errorCodeOf(error);
  if (code && POST_SEND_ERROR_CODES.has(code)) {
    return new BrokerError("CONNECTION_LOST_AFTER_SEND", `${providerId}: connection lost after the request was sent (${code}); not retried automatically`, {
      retryable: false,
      cause: error,
    });
  }
  if (code && CONNECT_ERROR_CODES.has(code)) {
    return new BrokerError("CONNECTION_FAILED", `${providerId}: could not connect (${code})`, { retryable: true, cause: error });
  }
  // Unknown transport failure: treat as "may have been delivered" - never retry.
  return new BrokerError("CONNECTION_LOST_AFTER_SEND", `${providerId}: transport failure (${code ?? messageOf(error).slice(0, 120)}); not retried automatically`, {
    retryable: false,
    cause: error,
  });
}

/** Provider error bodies are summarised, truncated and flushed through redaction. */
function summariseProviderError(body: string): string {
  const text = body.replace(/\s+/g, " ").trim();
  if (!text) return "";
  return `: ${text.slice(0, 200)}`;
}
