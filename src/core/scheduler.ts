import { BrokerError } from "./errors.js";
import type { BrokerConfig } from "./types.js";

export class Semaphore {
  private active = 0;
  private readonly queue: Array<(release: () => void) => void> = [];
  constructor(readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new BrokerError("CONFIG_ERROR", "Semaphore capacity must be a positive integer");
  }
  acquire(): Promise<() => void> {
    return new Promise((resolve) => {
      if (this.active < this.capacity) { this.active++; resolve(this.releaseHandle()); }
      else this.queue.push(resolve);
    });
  }
  private releaseHandle(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.queue.shift();
      if (next) next(this.releaseHandle());
      else this.active--;
    };
  }
  stats(): { capacity: number; active: number; queued: number } { return { capacity: this.capacity, active: this.active, queued: this.queue.length }; }
}

export class Scheduler {
  private readonly global: Semaphore;
  private readonly providers = new Map<string, Semaphore>();
  constructor(concurrency: BrokerConfig["concurrency"], providers: BrokerConfig["providers"] = {}) {
    this.global = new Semaphore(concurrency.global);
    for (const id of new Set([...Object.keys(providers), ...Object.keys(concurrency).filter((id) => id !== "global")])) {
      this.providers.set(id, new Semaphore(concurrency[id] ?? providers[id]?.maxConcurrency ?? 1));
    }
  }
  async run<T>(providerId: string, fn: () => Promise<T>): Promise<T> {
    let provider = this.providers.get(providerId);
    if (!provider) { provider = new Semaphore(1); this.providers.set(providerId, provider); }
    const releaseGlobal = await this.global.acquire();
    try {
      const releaseProvider = await provider.acquire();
      try { return await fn(); } finally { releaseProvider(); }
    } finally { releaseGlobal(); }
  }
  stats(): { global: ReturnType<Semaphore["stats"]>; providers: Record<string, ReturnType<Semaphore["stats"]>> } {
    return { global: this.global.stats(), providers: Object.fromEntries([...this.providers].map(([id, semaphore]) => [id, semaphore.stats()])) };
  }
}
