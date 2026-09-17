import { createHash, randomUUID } from "node:crypto";
import { redact } from "../security/redaction.js";
import { BrokerError } from "./errors.js";
import type { BrokerConfig, Clock, Store, TraceEvent, TraceEventType, TraceLevel, TraceSummary } from "./types.js";

export class TraceStore {
  private readonly pending = new Map<string, Promise<unknown>>();
  private readonly taskIds = new Map<string, string>();
  constructor(private readonly store: Store, private readonly config: BrokerConfig["trace"], private readonly clock: Clock = { now: () => new Date() }) {}
  startTrace(taskId: string): string {
    const traceId = randomUUID();
    this.taskIds.set(traceId, taskId);
    return traceId;
  }
  /** Hash task/context/prompt fields wherever provider metadata nests them. */
  protectPrompts(payload: Record<string, unknown>, allStrings = false): Record<string, unknown> {
    const visit = (value: unknown, isBody: boolean): unknown => {
      if (typeof value === "string" && isBody && !this.config.storePrompts) return { chars: value.length, sha256: createHash("sha256").update(value).digest("hex") };
      if (Array.isArray(value)) return value.map((v) => visit(v, isBody));
      if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, val]) => [key, visit(val, isBody || /^(task|context|prompt|prompts|messages|content|body|input|text)$/i.test(key))]));
      return redact(value);
    };
    return visit(payload, allStrings) as Record<string, unknown>;
  }
  emit(traceId: string, type: TraceEventType, payload: Record<string, unknown>, ids: { taskId?: string; runId?: string } = {}): Promise<void> {
    const safe = this.protectPrompts(redact(payload), type === "prompt.sent");
    const previous = this.pending.get(traceId) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      const events = await this.store.listEvents(traceId, "debug");
      const event: TraceEvent = { id: randomUUID(), traceId, taskId: ids.taskId ?? this.taskIds.get(traceId), runId: ids.runId, seq: (events.at(-1)?.seq ?? 0) + 1, timestamp: this.clock.now().toISOString(), type, payload: safe };
      await this.store.appendEvent(event);
    });
    this.pending.set(traceId, operation);
    void operation.then(() => { if (this.pending.get(traceId) === operation) this.pending.delete(traceId); }, () => { if (this.pending.get(traceId) === operation) this.pending.delete(traceId); });
    return operation;
  }
  async getTrace(traceId: string, level: TraceLevel = "summary"): Promise<TraceSummary> {
    if (!["summary", "verbose", "debug"].includes(level)) throw new BrokerError("INVALID_INPUT", "Invalid trace level");
    await this.pending.get(traceId);
    const events = await this.store.listEvents(traceId, "debug");
    if (!events.length && !this.taskIds.has(traceId)) throw new BrokerError("TRACE_NOT_FOUND", "Trace does not exist");
    const filtered = events.filter((e) => level === "debug" || /^(task\.|route\.|run\.|usage$|provider\.(error|retry)$|policy\.)/.test(e.type) || (level === "verbose" && ["prompt.sent", "provider.request", "provider.response"].includes(e.type)));
    return { traceId, taskId: events[0]?.taskId ?? this.taskIds.get(traceId), events: filtered };
  }
}
