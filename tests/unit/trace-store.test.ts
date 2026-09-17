import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MemoryStore } from "../../src/storage/memory.js";
import { TraceStore } from "../../src/core/trace-store.js";
describe("TraceStore", () => {
  it("stores prompt lengths/hashes and orders concurrent events monotonically", async () => {
    const store = new MemoryStore(); const traces = new TraceStore(store, { storePrompts: false, retentionDays: 30 }); const id = traces.startTrace("task");
    await Promise.all(Array.from({ length: 10 }, () => traces.emit(id, "prompt.sent", { task: "private prompt", context: "private context" })));
    const trace = await traces.getTrace(id, "verbose");
    expect(trace.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(trace.events[0]?.payload.task).toEqual({ chars: 14, sha256: createHash("sha256").update("private prompt").digest("hex") });
    expect(JSON.stringify(await store.listEvents(id, "debug"))).not.toMatch(/private prompt|private context/);
  });
  it("filters levels and scrubs nested provider prompts and secrets", async () => {
    const traces = new TraceStore(new MemoryStore(), { storePrompts: false, retentionDays: 30 }); const id = traces.startTrace("task");
    await traces.emit(id, "route.selected", { worker: "mock" });
    await traces.emit(id, "provider.request", { body: { messages: [{ content: "sensitive prompt" }] }, Authorization: "opaque" });
    await traces.emit(id, "tool.event", { command: "reported by provider" });
    expect((await traces.getTrace(id, "summary")).events.map((e) => e.type)).toEqual(["route.selected"]);
    expect((await traces.getTrace(id, "verbose")).events).toHaveLength(2);
    expect((await traces.getTrace(id, "debug")).events).toHaveLength(3);
    expect(JSON.stringify(await traces.getTrace(id, "debug"))).not.toMatch(/sensitive prompt|opaque/);
  });
  it("stores opted-in prompts while still removing secrets", async () => {
    const traces = new TraceStore(new MemoryStore(), { storePrompts: true, retentionDays: 30 }); const id = traces.startTrace("task");
    await traces.emit(id, "prompt.sent", { task: "public instruction sk-hidden-key" });
    expect((await traces.getTrace(id, "verbose")).events[0]?.payload.task).toBe("public instruction [REDACTED]");
    await expect(traces.getTrace("unknown")).rejects.toMatchObject({ code: "TRACE_NOT_FOUND" });
  });
});
