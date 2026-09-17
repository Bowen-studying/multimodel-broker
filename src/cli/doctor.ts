import { toBrokerError } from "../core/errors.js";
import { redact } from "../security/redaction.js";
import type { BrokerConfig } from "../core/types.js";
import { createProviders } from "../providers/index.js";
import { describeSecret } from "../security/secrets.js";
import { loadConfig } from "../core/config.js";
import { mkdir, access, stat } from "node:fs/promises";
import path from "node:path";
import { constants } from "node:fs";
import { resolveConfigPath } from "../core/bootstrap.js";

/**
 * `doctor`: human + JSON readiness report.
 *
 * Secrets are reported as "set"/"missing" only - a resolved value is never
 * printed, not even truncated. Exit code is non-zero when a REQUIRED (i.e.
 * enabled) provider is unhealthy or when the configuration itself is invalid.
 */
export interface DoctorProviderReport {
  id: string;
  enabled: boolean;
  adapter: string;
  model?: string;
  authMode: string;
  capabilities: string[];
  maxConcurrency: number;
  secretEnv?: { name: string; state: "set" | "missing" };
  implemented: boolean;
  health: { healthy: boolean; reason?: string; details?: Record<string, unknown> };
}

export interface DoctorReport {
  ok: boolean;
  config: { path: string | null; loaded: boolean; error?: string };
  storage: { driver: string; target: string; writable: boolean | null; detail: string };
  workspaces: Array<{ name: string; path: string; exists: boolean }>;
  providers: DoctorProviderReport[];
  warnings: string[];
}

export interface DoctorOptions {
  configPath?: string;
  logger?: { warn(msg: string, fields?: Record<string, unknown>): void };
}

export async function collectDoctorReport(options: DoctorOptions = {}): Promise<{ report: DoctorReport; exitCode: number }> {
  const warnings: string[] = [];
  const configPath = (await resolveConfigPath(options.configPath)) ?? null;
  let config: BrokerConfig | undefined;
  let configError: string | undefined;
  try {
    config = await loadConfig(configPath ? { path: configPath } : {});
  } catch (error) {
    configError = toBrokerError(error, "CONFIG_ERROR").message;
  }

  if (!config) {
    return {
      report: {
        ok: false,
        config: { path: configPath, loaded: false, error: configError },
        storage: { driver: "unknown", target: "-", writable: null, detail: "not evaluated (invalid configuration)" },
        workspaces: [],
        providers: [],
        warnings: ["Configuration could not be loaded; nothing was probed."],
      },
      exitCode: 1,
    };
  }

  // Storage
  const storage = await describeStorage(config);

  // Workspaces (existence only; canonicalisation errors surface when used)
  const workspaces: DoctorReport["workspaces"] = [];
  for (const [name, target] of Object.entries(config.workspaces)) {
    let exists = false;
    try {
      exists = (await stat(target)).isDirectory();
    } catch {
      exists = false;
    }
    if (!exists) warnings.push(`workspace "${name}" points at a path that is not a readable directory`);
    workspaces.push({ name, path: target, exists });
  }

  // Providers
  const registry = createProviders(config, options.logger);
  const registered = new Set(registry.list().map((entry) => entry.id));
  const providers: DoctorProviderReport[] = [];
  for (const [id, providerConfig] of Object.entries(config.providers)) {
    const implemented = registered.has(id);
    if (!implemented) {
      providers.push({
        id,
        enabled: providerConfig.enabled,
        adapter: providerConfig.adapter,
        model: providerConfig.model,
        authMode: providerConfig.authMode ?? "unknown",
        capabilities: [],
        maxConcurrency: providerConfig.maxConcurrency,
        secretEnv: providerConfig.apiKeyEnv ? { name: providerConfig.apiKeyEnv, state: describeSecret(providerConfig.apiKeyEnv) } : undefined,
        implemented: false,
        health: { healthy: false, reason: `adapter "${providerConfig.adapter}" is not implemented in this build` },
      });
      if (providerConfig.enabled) warnings.push(`provider "${id}" is enabled but its adapter is not implemented in this build`);
      continue;
    }
    const health = providerConfig.enabled
      ? await registry.probe(id)
      : { healthy: false, checkedAt: new Date().toISOString(), reason: "provider disabled" };
    if (providerConfig.enabled && providerConfig.options?.["allowNetworkAccess"] === true) {
      warnings.push(
        `provider "${id}" enables network egress; the read-only annotations advertised to MCP clients no longer mean "spends compute and returns text only"`,
      );
    }
    if (providerConfig.enabled && providerConfig.options?.["allowWebSearch"] === true) {
      warnings.push(`provider "${id}" enables web search; results leave the machine and the read-only annotation is weakened`);
    }
    const missingKey = providerConfig.apiKeyEnv !== undefined && describeSecret(providerConfig.apiKeyEnv) === "missing";
    providers.push({
      id,
      enabled: providerConfig.enabled,
      adapter: providerConfig.adapter,
      model: providerConfig.model,
      // The live provider is the source of truth for how it authenticates.
      authMode: registry.get(id)?.provider.authMode ?? providerConfig.authMode ?? "unknown",
      capabilities: [...(registry.get(id)?.provider.capabilities ?? [])],
      maxConcurrency: config.concurrency[id] ?? providerConfig.maxConcurrency,
      secretEnv: providerConfig.apiKeyEnv ? { name: providerConfig.apiKeyEnv, state: describeSecret(providerConfig.apiKeyEnv) } : undefined,
      implemented: true,
      health: {
        healthy: providerConfig.enabled && !missingKey && health.healthy,
        reason: missingKey ? `environment variable ${providerConfig.apiKeyEnv} is not set` : health.reason,
        details: health.details,
      },
    });
  }

  const required = providers.filter((provider) => provider.enabled);
  if (!required.length) warnings.push("no provider is enabled; the broker would answer every delegation with WORKER_UNAVAILABLE");
  const unhealthyRequired = required.filter((provider) => !provider.health.healthy);
  const ok = !unhealthyRequired.length && storage.writable !== false;

  return {
    report: { ok, config: { path: configPath, loaded: true }, storage, workspaces, providers, warnings },
    exitCode: ok ? 0 : 1,
  };
}

async function describeStorage(config: BrokerConfig): Promise<DoctorReport["storage"]> {
  if (config.storage.driver === "memory") {
    return { driver: "memory", target: "-", writable: true, detail: "in-memory store: task/trace history is lost on exit" };
  }
  const file = path.resolve(config.storage.sqlitePath);
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await access(path.dirname(file), constants.W_OK);
    return { driver: "sqlite", target: file, writable: true, detail: "directory is writable" };
  } catch {
    return { driver: "sqlite", target: file, writable: false, detail: "directory is not writable" };
  }
}

function formatHuman(report: DoctorReport): string {
  const lines: string[] = [];
  const mark = (value: boolean | null) => (value === true ? "ok" : value === false ? "FAIL" : "n/a");
  lines.push(`multimodel-broker doctor`);
  lines.push(`config        : ${report.config.loaded ? report.config.path ?? "built-in defaults" : `INVALID (${report.config.error})`}`);
  lines.push(`storage       : ${report.storage.driver} -> ${report.storage.target} [${mark(report.storage.writable)}] ${report.storage.detail}`);
  if (report.workspaces.length) {
    for (const workspace of report.workspaces) lines.push(`workspace     : ${workspace.name} -> ${workspace.path} [${mark(workspace.exists)}]`);
  } else {
    lines.push(`workspace     : (none configured)`);
  }
  lines.push("providers:");
  for (const provider of report.providers) {
    const secret = provider.secretEnv ? ` ${provider.secretEnv.name}=${provider.secretEnv.state}` : "";
    lines.push(
      `  - ${provider.id} [${provider.enabled ? "enabled" : "disabled"}] adapter=${provider.adapter} auth=${provider.authMode} model=${provider.model ?? "-"} concurrency=${provider.maxConcurrency}${secret}`,
    );
    lines.push(`      implemented=${provider.implemented} healthy=${mark(provider.health.healthy)}${provider.health.reason ? ` (${provider.health.reason})` : ""}`);
    if (provider.health.details && Object.keys(provider.health.details).length) lines.push(`      details=${JSON.stringify(provider.health.details)}`);
    lines.push(`      capabilities=${provider.capabilities.length ? provider.capabilities.join(",") : "-"}`);
  }
  for (const warning of report.warnings) lines.push(`warning       : ${warning}`);
  lines.push(`RESULT        : ${report.ok ? "ok" : "not ready"}`);
  return `${lines.join("\n")}\n`;
}

export async function runDoctor(options: { configPath?: string; json?: boolean; logger?: DoctorOptions["logger"] } = {}): Promise<number> {
  const { report, exitCode } = await collectDoctorReport({ configPath: options.configPath, logger: options.logger });
  const safe = redact(report);
  if (options.json) process.stdout.write(`${JSON.stringify(safe, null, 2)}\n`);
  else process.stdout.write(formatHuman(safe));
  return exitCode;
}

/** Shared by the CLI so `doctor` and the running broker agree on wiring. */
