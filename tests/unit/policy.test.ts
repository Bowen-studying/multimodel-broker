import { beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/core/config.js";
import { RequestPolicy } from "../../src/core/policy.js";
import type { TaskSubmission } from "../../src/core/types.js";
let policy: RequestPolicy;
beforeEach(async () => { policy = new RequestPolicy({ ...(await loadConfig()).limits, maxTaskChars: 10, maxContextChars: 12, maxFiles: 2, maxBatchTasks: 3 }); });
describe("request policy", () => {
  it("defaults wait to 15s, clamps to 45s, and accepts zero", () => {
    expect(policy.validate({ task: "hello" }).waitMs).toBe(15_000);
    expect(policy.clampWaitMs(100_000)).toBe(45_000);
    expect(policy.clampWaitMs(0)).toBe(0);
  });
  it.each([-1, Infinity, NaN])("rejects invalid wait %s", (wait) => { expect(() => policy.clampWaitMs(wait)).toThrow(/waitMs/); });
  it("enforces task, context, files, and batch limits", () => {
    for (const input of [{ task: "x".repeat(11) }, { task: "okay", context: "x".repeat(13) }, { task: "okay", workspace: "work", files: ["a", "b", "c"] }]) expect(() => policy.validate(input)).toThrow(expect.objectContaining({ code: "LIMIT_EXCEEDED" }));
    expect(() => policy.validateBatch(Array.from({ length: 4 }, () => ({ task: "okay" })))).toThrow(expect.objectContaining({ code: "LIMIT_EXCEEDED" }));
    expect(() => policy.validateBatch([])).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
  });
  it("validates trace level, idempotency shape, timeout, and workspace requirements", () => {
    expect(policy.validate({ task: "okay", idempotencyKey: "valid:abc_1-2.3" }).traceLevel).toBe("summary");
    for (const input of [{ task: "okay", traceLevel: "debug" }, { task: "okay", idempotencyKey: "has spaces" }, { task: "okay", idempotencyKey: "a".repeat(129) }, { task: "okay", timeoutMs: 0 }, { task: "okay", files: ["a"] }, { task: "" }]) expect(() => policy.validate(input as TaskSubmission)).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
    expect(policy.validateTraceLevel("debug", true)).toBe("debug");
  });
});
