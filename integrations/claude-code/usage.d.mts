// Type declarations for the runner-side usage accounting (shared with the runner and its test).
export declare const PRICES_PER_MILLION: { miss: number; hit: number; output: number };

export declare function usageParts(usage: Record<string, unknown> | null | undefined): {
  /** Fresh (uncached) input tokens. */
  fresh: number;
  /** Tokens written to the cache this run. */
  cacheWrite: number;
  /** Tokens served from the cache this run. */
  cacheHit: number;
  output: number;
  /** Billed-at-miss tokens: fresh + cacheWrite. */
  miss: number;
  /** Everything the run sent: miss + cacheHit. */
  total: number;
  costEstimate: number;
  /** Set when the harness reports something physically impossible, so it is never swallowed. */
  note?: string;
};
