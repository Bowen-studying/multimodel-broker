/**
 * Cost accounting for the Claude Code runner.
 *
 * The reason this has its own test: the harness reports `input_tokens` as the FRESH input, not as the
 * whole prompt, and cache writes are billed at the miss price too. Reading `input_tokens` as a total
 * and subtracting the cache share (the obvious-looking formula) silently swallows a whole turn's
 * fresh input - measured on a real two-turn run it under-reported the bill by ~15x. The numbers in
 * these cases are the harness's own reported usage from real runs on this machine (2026-09-18).
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { usageParts } from "../../integrations/claude-code/usage.mjs";

describe("claude-code usage accounting", () => {
  it("prices a one-turn run, where nothing could be cached yet", () => {
    // Real observed values: a single-turn task ("reply ok") with no file edits.
    const parts = usageParts({ input_tokens: 24466, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 2 });

    expect(parts).toMatchObject({ fresh: 24466, cacheWrite: 0, cacheHit: 0, miss: 24466, total: 24466 });
    // 24466 x 0.30/1M + 2 x 1.20/1M ; the runner reported exactly 0.007342 for this run.
    expect(parts.costEstimate).toBeCloseTo(0.0073422, 6);
    expect(parts.note).toBeUndefined();
  });

  it("counts the first turn's fresh input on a two-turn run instead of hiding it behind the cache read", () => {
    // Real observed values: a two-turn run that wrote a file (turn 2 read turn 1's cache write).
    const parts = usageParts({ input_tokens: 24690, cache_read_input_tokens: 24576, cache_creation_input_tokens: 0, output_tokens: 276 });

    expect(parts).toMatchObject({ fresh: 24690, cacheHit: 24576, miss: 24690, total: 49266 });
    // The old formula clamped miss to 0 and reported 0.000513 - 15x below the real token cost.
    expect(parts.costEstimate).toBeCloseTo(0.0078857, 6);
    expect(parts.costEstimate).toBeGreaterThan(0.000513 * 15);
  });

  it("bills cache writes as misses, because that is how the backend charges them", () => {
    const parts = usageParts({ input_tokens: 100, cache_read_input_tokens: 1000, cache_creation_input_tokens: 24000, output_tokens: 10 });

    expect(parts).toMatchObject({ fresh: 100, cacheWrite: 24000, cacheHit: 1000, miss: 24100, total: 25100 });
    expect(parts.costEstimate).toBeCloseTo((24100 * 0.30 + 1000 * 0.006 + 10 * 1.20) / 1e6, 9);
  });

  it("cannot report a cache read larger than the total input any more", () => {
    // This pair is what production actually reported (cache_read 24704 > input_tokens 24693) and what
    // the old formula clamped into "free tokens". Now the total is built from the parts, so the
    // contradiction is unreachable: the read is part of the total.
    const parts = usageParts({ input_tokens: 24693, cache_read_input_tokens: 24704, cache_creation_input_tokens: 0, output_tokens: 388 });

    expect(parts.cacheHit).toBeLessThanOrEqual(parts.total);
    expect(parts.total).toBe(49397);
    expect(parts.note).toBeUndefined();
  });

  it("keeps the runner-side .mjs files parseable as plain JavaScript", () => {
    // Twice now a TypeScript-only construct (an interface, then an `as unknown as` cast) slipped into
    // these .mjs files: `tsc` is happy, the unit tests are happy, and the runner dies at run time with
    // "Unexpected token" - the failure only shows up as a failed run on the live instance.
    for (const file of ["integrations/claude-code/runner.mjs", "integrations/claude-code/usage.mjs"]) {
      const checked = spawnSync(process.execPath, ["--check", path.join(process.cwd(), file)], { encoding: "utf8" });
      expect(checked.status, `${file} is not valid JavaScript: ${checked.stderr}`).toBe(0);
    }
  });

  it("flags garbage usage instead of quietly pricing it", () => {
    const parts = usageParts({ input_tokens: -5, cache_read_input_tokens: 10, cache_creation_input_tokens: 0, output_tokens: 1 });

    expect(parts.note).toContain("negative or non-numeric");
  });
});
