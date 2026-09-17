import { BrokerError, toBrokerError } from "../core/errors.js";
import type { Clock, ProviderConfig, ProviderHealth, WorkerInfo, WorkerProvider } from "../core/types.js";
import { redact, redactString } from "../security/redaction.js";
export type { WorkerProvider, WorkerRequest, WorkerResult, ProviderHealth } from "../core/types.js";

export interface RegisteredProvider { id: string; provider: WorkerProvider; config: ProviderConfig }
export class ProviderRegistry {
  private readonly entries = new Map<string, RegisteredProvider>();
  readonly healthCache = new Map<string, ProviderHealth>();
  private readonly pending = new Map<string, Promise<ProviderHealth>>();
  constructor(private readonly ttlMs = 60_000, private readonly clock: Clock = { now: () => new Date() }) {}
  register(id: string, provider: WorkerProvider, config: ProviderConfig): void {
    if (this.entries.has(id)) throw new BrokerError("CONFIG_ERROR", "Provider is already registered");
    this.entries.set(id, { id, provider, config });
  }
  get(id: string): RegisteredProvider | undefined { return this.entries.get(id); }
  list(): RegisteredProvider[] { return [...this.entries.values()]; }
  cachedHealth(id: string): ProviderHealth | undefined {
    const health = this.healthCache.get(id);
    return health && this.clock.now().getTime() - Date.parse(health.checkedAt) < this.ttlMs ? health : undefined;
  }
  probe(id: string): Promise<ProviderHealth> {
    const entry = this.entries.get(id);
    if (!entry) return Promise.reject(new BrokerError("WORKER_NOT_FOUND", "Worker does not exist"));
    const cached = this.cachedHealth(id);
    if (cached) return Promise.resolve(cached);
    const pending = this.pending.get(id);
    if (pending) return pending;
    const probe = Promise.resolve().then(() => entry.provider.healthCheck()).catch((error: unknown) => ({ healthy: false, checkedAt: this.clock.now().toISOString(), reason: redactString(toBrokerError(error).message) })).then((health) => {
      const safe = redact({ ...health, checkedAt: this.clock.now().toISOString() });
      this.healthCache.set(id, safe);
      this.pending.delete(id);
      return safe;
    });
    this.pending.set(id, probe);
    return probe;
  }
  refresh(): void { for (const entry of this.entries.values()) if (entry.config.enabled) void this.probe(entry.id).catch(() => {}); }
  /**
   * Probe every enabled provider and WAIT for the answers.
   *
   * `refresh()` is fire-and-forget, which is right for initialization (a probe must
   * never block startup) but wrong for a tool that reports health: the caller would
   * read an empty cache and be told "Health check pending" for a worker that is
   * perfectly healthy. Probes are cached and de-duplicated, so repeated calls within
   * the TTL cost nothing.
   */
  async refreshAll(): Promise<void> {
    await Promise.all(
      this.list()
        .filter((entry) => entry.config.enabled)
        .map((entry) => this.probe(entry.id).catch(() => undefined)),
    );
  }
  workerInfo(): WorkerInfo[] {
    return this.list().map(({ id, provider, config }) => {
      const health = this.cachedHealth(id);
      const missingKey = config.apiKeyEnv && !process.env[config.apiKeyEnv];
      return redact({ id, enabled: config.enabled, healthy: config.enabled && !missingKey && health?.healthy === true,
        provider: config.adapter, model: config.model, authMode: provider.authMode ?? config.authMode ?? (config.adapter === "codex-sdk" ? "codex-local" : config.adapter === "mock" ? "unknown" : "api-key"), capabilities: [...provider.capabilities], maxConcurrency: config.maxConcurrency,
        reasonUnavailable: missingKey ? `${config.apiKeyEnv} not set` : !config.enabled ? "Worker disabled" : !health ? "Health check pending" : !health.healthy ? health.reason ?? "Health check failed" : undefined,
      });
    });
  }
  available(id: string): boolean {
    const entry = this.entries.get(id);
    // Unknown health is optimistic so initialization never blocks on a probe.
    return !!entry?.config.enabled && !(entry.config.apiKeyEnv && !process.env[entry.config.apiKeyEnv]) && this.cachedHealth(id)?.healthy !== false;
  }
}
