import { Broker } from "../../src/core/broker.js";
import { loadConfig } from "../../src/core/config.js";
import { createLogger } from "../../src/core/logger.js";
import { Scheduler } from "../../src/core/scheduler.js";
import { TaskManager } from "../../src/core/task-manager.js";
import { TraceStore } from "../../src/core/trace-store.js";
import type { BrokerConfig, ProviderConfig, Store } from "../../src/core/types.js";
import { createProviders } from "../../src/providers/index.js";
import { ProviderRegistry } from "../../src/providers/provider.js";
import { MemoryStore } from "../../src/storage/memory.js";

/**
 * Wires a real Broker around real providers (used with the fake HTTP server) so
 * retry/timeout/routing behaviour is exercised end to end, not in isolation.
 */
export interface Harness {
  config: BrokerConfig;
  store: Store;
  providers: ProviderRegistry;
  scheduler: Scheduler;
  traceStore: TraceStore;
  taskManager: TaskManager;
  broker: Broker;
}

export async function createHarness(options: {
  providers: Record<string, ProviderConfig>;
  routing?: BrokerConfig["routing"];
  retryBaseDelayMs?: number;
  maxRetries?: number;
  store?: Store;
  /** Pre-built registry (used to inject instrumented or fake-SDK providers). */
  registry?: ProviderRegistry;
  /** Allowlisted workspaces (name -> path). */
  workspaces?: Record<string, string>;
}): Promise<Harness> {
  const config = await loadConfig();
  config.providers = options.providers;
  if (options.workspaces) config.workspaces = options.workspaces;
  if (options.routing) config.routing = options.routing;
  config.limits.retryBaseDelayMs = options.retryBaseDelayMs ?? 5;
  if (options.maxRetries !== undefined) config.limits.maxRetries = options.maxRetries;
  const store = options.store ?? new MemoryStore();
  const logger = createLogger({ level: "silent" });
  const providers = options.registry ?? createProviders(config, undefined);
  const scheduler = new Scheduler(config.concurrency, config.providers);
  const traceStore = new TraceStore(store, config.trace);
  const taskManager = new TaskManager(store, traceStore);
  const broker = new Broker({ config, store, logger, providers, scheduler, traceStore, taskManager });
  await broker.init();
  return { config, store, providers, scheduler, traceStore, taskManager, broker };
}
