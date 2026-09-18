import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { loadEnvFile, resolveEnvRefs } from "../security/secrets.js";
import { BrokerError } from "./errors.js";
import { PROFILE_NAMES, type BrokerConfig } from "./types.js";

const positive = z.number().int().positive();
const nonnegative = z.number().int().nonnegative();
const behavior = z.enum(["success", "fail", "timeout", "hang"]);
const usage = z.object({ inputTokens: nonnegative.optional(), outputTokens: nonnegative.optional(), cost: z.number().nonnegative().optional() }).strict();
const provider = z.object({
  enabled: z.boolean().default(false),
  adapter: z.enum(["codex-sdk", "claude-code", "gemini-api", "openai-compatible", "mock"]).default("mock"),
  model: z.string().optional(), baseUrl: z.string().optional(),
  apiKeyEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional(),
  maxConcurrency: positive.default(1), defaultTimeoutMs: positive.max(2_147_483_647).default(60_000),
  authMode: z.enum(["codex-local", "api-key", "vertex", "unknown"]).optional(),
  sandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]).optional(),
  mock: z.object({ delayMs: nonnegative.optional(), behavior: behavior.optional(), answer: z.string().optional(), usage: usage.optional(), failFirstAttempts: nonnegative.optional(),
    rules: z.array(z.object({ match: z.string(), behavior: behavior.optional(), delayMs: nonnegative.optional(), answer: z.string().optional(), errorCode: z.string().optional() }).strict()).optional(),
  }).strict().optional(),
  options: z.record(z.string(), z.unknown()).optional(),
}).strict();
const rule = z.object({ primary: z.string().min(1), fallback: z.array(z.string().min(1)).default([]) }).strict();
const schema = z.object({
  providers: z.record(z.string().regex(/^[A-Za-z0-9_-]+$/), provider).default({}),
  routing: z.object({ coding: rule.optional(), long_context: rule.optional(), low_cost: rule.optional(), chinese: rule.optional(), general: rule.optional() }).strict().prefault({}),
  concurrency: z.object({ global: positive.default(5) }).catchall(positive).prefault({}),
  limits: z.object({
    maxTaskChars: positive.default(100_000), maxContextChars: positive.default(500_000),
    defaultWaitMs: nonnegative.max(45_000).default(15_000), maxWaitMs: nonnegative.max(45_000).default(45_000),
    maxBatchTasks: positive.max(8).default(8), maxFiles: nonnegative.default(20), maxFileBytes: positive.default(10_485_760),
    maxRetries: nonnegative.max(10).default(2), retryBaseDelayMs: nonnegative.max(60_000).default(250),
  }).strict().prefault({}),
  workspaces: z.record(z.string().regex(/^(?!.*\.\.)[A-Za-z0-9_-]+$/), z.string().min(1)).default({}),
  trace: z.object({ storePrompts: z.boolean().default(false), retentionDays: positive.default(30) }).strict().prefault({}),
  storage: z.object({ driver: z.enum(["memory", "sqlite"]).default("memory"), sqlitePath: z.string().min(1).default("data/broker.sqlite") }).strict().prefault({}),
  server: z.object({ defaultProfile: z.enum(PROFILE_NAMES).default("chatgpt-agent"), allowAnyWorkspace: z.boolean().default(false) }).strict().prefault({}),
}).strict();

export async function loadConfig(options: { path?: string; env?: NodeJS.ProcessEnv } = {}): Promise<BrokerConfig> {
  await loadEnvFile(path.resolve(".env"));
  const env = options.env ?? process.env;
  const configPath = options.path ?? env.BROKER_CONFIG;
  let raw: unknown = {};
  if (configPath) {
    try { raw = parse(await readFile(configPath, "utf8")) ?? {}; }
    catch { throw new BrokerError("CONFIG_ERROR", "config: unable to read or parse YAML configuration"); }
  }
  // Resolve scalar values after YAML parsing so environment values cannot inject YAML.
  const resolve = (value: unknown): unknown => {
    if (typeof value === "string") return resolveEnvRefs(value, env);
    if (Array.isArray(value)) return value.map(resolve);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, val]) => [key, resolve(val)]));
    return value;
  };
  let resolved: unknown;
  try { resolved = resolve(raw); }
  catch { throw new BrokerError("CONFIG_ERROR", "config: cyclic or invalid configuration"); }
  const result = schema.safeParse(resolved);
  if (!result.success) {
    const paths = result.error.issues.map((issue) => `${issue.path.join('.') || 'config'}: ${issue.code}`).join("; ");
    throw new BrokerError("CONFIG_ERROR", paths);
  }
  const config: BrokerConfig = result.data;
  if (config.limits.defaultWaitMs > config.limits.maxWaitMs) throw new BrokerError("CONFIG_ERROR", "limits.defaultWaitMs must not exceed limits.maxWaitMs");
  for (const [name, routingRule] of Object.entries(config.routing)) {
    for (const id of [routingRule.primary, ...routingRule.fallback ?? []]) {
      if (!Object.hasOwn(config.providers, id)) throw new BrokerError("CONFIG_ERROR", `routing.${name}: references an unknown provider`);
    }
  }
  // An enabled provider must be fully configured: an ${ENV} placeholder that
  // resolved to nothing must fail loudly here instead of producing a provider
  // that silently talks to the wrong (or no) endpoint.
  for (const [id, provider] of Object.entries(config.providers)) {
    if (!provider.enabled) continue;
    if (provider.baseUrl !== undefined && !provider.baseUrl.trim()) {
      throw new BrokerError("CONFIG_ERROR", `providers.${id}.baseUrl resolved to an empty value - is the referenced environment variable set?`);
    }
    if (
      (provider.adapter === "openai-compatible" || provider.adapter === "gemini-api" || provider.adapter === "claude-code")
      && !provider.model?.trim()
    ) {
      throw new BrokerError("CONFIG_ERROR", `providers.${id}.model must be configured (set the model id or its environment variable) for adapter ${provider.adapter}`);
    }
  }
  return config;
}
