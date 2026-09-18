// Cost accounting for the headless Claude Code runner.
//
// Claude Code's `result` event carries CUMULATIVE usage for the whole run, and its fields mean:
//   input_tokens                 fresh (uncached) input  -> billed at the MISS price
//   cache_creation_input_tokens  tokens written to cache  -> also billed at the MISS price
//   cache_read_input_tokens      tokens served from cache -> billed at the HIT price
// so the miss share is fresh + cache_creation, NOT (input_tokens - cache_read). Assuming the latter
// silently swallowed a whole turn's fresh input: a two-turn run reports input_tokens ~24.7k and
// cache_read ~24.6k (turn 2 reading what turn 1 wrote), and the old formula clamped the miss to 0.
//
// DeepSeek peak pricing, USD per 1M tokens: miss 0.30, hit 0.006, output 1.20. This stays an
// UPPER BOUND (peak rates); calibrate against the account balance before treating it as a budget.
export const PRICES_PER_MILLION = { miss: 0.30, hit: 0.006, output: 1.20 };

/**
 * @param {Record<string, unknown> | null | undefined} usage the harness's reported usage
 * @returns {{fresh:number, cacheWrite:number, cacheHit:number, output:number, miss:number, total:number,
 *   costEstimate:number, note?:string}} the parts plus the DeepSeek-priced estimate
 */
export function usageParts(usage) {
  const fresh = Number(usage?.input_tokens ?? 0);
  const cacheWrite = Number(usage?.cache_creation_input_tokens ?? 0);
  const cacheHit = Number(usage?.cache_read_input_tokens ?? 0);
  const output = Number(usage?.output_tokens ?? 0);
  const miss = fresh + cacheWrite;
  const total = miss + cacheHit;
  const costEstimate =
    (miss * PRICES_PER_MILLION.miss + cacheHit * PRICES_PER_MILLION.hit + output * PRICES_PER_MILLION.output) / 1e6;
  // With miss = fresh + cacheWrite there is no way for the parts to contradict the total any more, so
  // the old "cache_read > input_tokens" clamp (and the 15x under-report it hid) cannot come back. What
  // is still worth flagging is garbage input: a negative or non-numeric figure from the harness.
  const bad = [fresh, cacheWrite, cacheHit, output].some((value) => !Number.isFinite(value) || value < 0);
  const note = bad
    ? "harness reported a negative or non-numeric usage field; token figures are passed through as-is and the cost estimate may be wrong"
    : undefined;
  return { fresh, cacheWrite, cacheHit, output, miss, total, costEstimate, ...(note ? { note } : {}) };
}
