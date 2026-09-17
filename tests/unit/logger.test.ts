import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../../src/core/logger.js";
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
describe("structured logger", () => {
  it("honors BROKER_LOG_LEVEL, merges child fields, and redacts every field", () => {
    vi.stubEnv("BROKER_LOG_LEVEL", "warn"); const lines: string[] = [];
    const logger = createLogger({ write: (line) => { lines.push(line); }, fields: { service: "broker", authorization: "opaque" } }).child({ task: "one", extra: { password: "opaque" } });
    logger.info("not emitted"); logger.warn("sk-hidden-key", { task: "two", nested: ["Cookie: session=hidden"] });
    expect(lines).toHaveLength(1); expect(lines[0]).not.toMatch(/opaque|hidden/);
    expect(JSON.parse(lines[0]!)).toMatchObject({ level: "warn", service: "broker", task: "two" });
  });
  it("writes JSON exclusively to stderr by default", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true); const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    createLogger({ level: "info" }).info("ready"); expect(stderr).toHaveBeenCalledOnce(); expect(stdout).not.toHaveBeenCalled();
    expect(JSON.parse(String(stderr.mock.calls[0]?.[0]))).toMatchObject({ message: "ready" });
  });
});
