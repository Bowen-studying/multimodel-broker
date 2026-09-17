import { loadConfig } from "./config.js";
import { Broker } from "./broker.js";
import { createLogger } from "./logger.js";
import { Scheduler } from "./scheduler.js";
import { TaskManager } from "./task-manager.js";
import { TraceStore } from "./trace-store.js";
import type { BrokerConfig, Logger, Store } from "./types.js";
import { createProviders } from "../providers/index.js";
import { ProviderRegistry } from "../providers/provider.js";
import { MemoryStore } from "../storage/memory.js";
import { SqliteStore } from "../storage/sqlite.js";
import { access } from "node:fs/promises";
import path from "node:path";

/**
 * Assembles the whole Broker from configuration. This is the single wiring
 * point shared by the CLI, the stdio MCP server and any future harness entry
 * point - the Core itself stays transport-agnostic.
 */
export interface Runtime {
  config: BrokerConfig;
  logger: Logger;
  store: Store;
  providers: ProviderRegistry;
  scheduler: Scheduler;
  traceStore: TraceStore;
  taskManager: TaskManager;
  broker: Broker;
  close(): Promise<void>;
}

export interface RuntimeOptions {
  configPath?: string;
  logLevel?: string;
  /** Override the store (tests use a pre-seeded store). */
  store?: Store;
}

export function createStore(config: BrokerConfig, env: NodeJS.ProcessEnv = process.env): Store {
  if (config.storage.driver === "memory") return new MemoryStore();
  // BROKER_DB_PATH wins so a deployment can relocate the database without
  // editing the config file.
  return new SqliteStore(env.BROKER_DB_PATH || config.storage.sqlitePath);
}

/**
 * Where the configuration comes from, in order:
 *   1. an explicit --config path,
 *   2. $BROKER_CONFIG,
 *   3. ./config/providers.yaml when that file exists (the documented default),
 *   4. built-in defaults (no providers -> every delegation is WORKER_UNAVAILABLE).
 * Kept out of `loadConfig()` so tests and library users never pick up a local file
 * by accident.
 */
export async function resolveConfigPath(explicit?: string): Promise<string | undefined> {
  if (explicit) return explicit;
  if (process.env.BROKER_CONFIG) return process.env.BROKER_CONFIG;
  const candidate = path.resolve("config/providers.yaml");
  try {
    await access(candidate);
    return candidate;
  } catch {
    return undefined;
  }
}

export async function createRuntime(options: RuntimeOptions = {}): Promise<Runtime> {
  const configPath = await resolveConfigPath(options.configPath);
  const config = await loadConfig(configPath ? { path: configPath } : {});
  const logger = createLogger({ level: options.logLevel });
  const store = options.store ?? createStore(config);
  const providers = createProviders(config, logger);
  const scheduler = new Scheduler(config.concurrency, config.providers);
  const traceStore = new TraceStore(store, config.trace);
  const taskManager = new TaskManager(store, traceStore);
  const broker = new Broker({ config, store, logger, providers, scheduler, traceStore, taskManager });
  await broker.init();
  return {
    config,
    logger,
    store,
    providers,
    scheduler,
    traceStore,
    taskManager,
    broker,
    close: async () => {
      await store.close();
    },
  };
}
