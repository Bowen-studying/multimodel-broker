import { BrokerError } from "./errors.js";
import { mutatingToolFor, WRITE_CAPABLE_ADAPTERS, type BrokerConfig, type RouterDecision, type TaskSubmission } from "./types.js";
import { ProviderRegistry } from "../providers/provider.js";

export class Router {
  constructor(private readonly config: BrokerConfig, private readonly providers: ProviderRegistry) {}

  /**
   * Automatic routing may only land on a worker that the read-only tools may honestly run, i.e. not
   * on a local agent (those are reached explicitly through run_agent, with its worker named). The
   * configured chain is still walked in order - a write-capable primary is skipped, not rewritten.
   */
  private selectable(id: string): boolean {
    const provider = this.config.providers[id];
    if (!provider?.enabled || WRITE_CAPABLE_ADAPTERS.has(provider.adapter)) return false;
    return this.providers.available(id);
  }

  private isAvailable(id: string): boolean {
    const provider = this.config.providers[id];
    return Boolean(provider?.enabled) && this.providers.available(id);
  }
  /**
   * @param options.allowWriteCapable set by the mutating tool (run_agent) for
   * their own run. Everywhere else a write-capable adapter is refused, because those tools are
   * advertised as read-only and must stay true to that.
   * @param options.rememberedWorker the worker was filled in from the caller's sticky choice, not
   * named in this request. The audit text must say so - "explicit" would be a lie about why this
   * worker was picked, and the caller needs to know that passing `worker` is how you switch.
   */
  route(request: TaskSubmission, options: { allowWriteCapable?: boolean; rememberedWorker?: boolean } = {}): RouterDecision {
    const allowWrite = options.allowWriteCapable === true;
    if (request.worker !== undefined) {
      // A local agent that can write files has its own tool; naming it here would smuggle a
      // file-modifying run through a tool the caller was told is read-only.
      const explicit = this.config.providers[request.worker];
      if (!allowWrite && explicit && WRITE_CAPABLE_ADAPTERS.has(explicit.adapter)) {
        throw new BrokerError(
          "INVALID_INPUT",
          `worker "${request.worker}" runs a local agent that can write files; use ${mutatingToolFor(explicit.adapter)} instead - this tool does not touch the machine`,
        );
      }
      if (!this.providers.available(request.worker)) throw new BrokerError("WORKER_UNAVAILABLE", "Explicit worker is disabled, unhealthy, or unavailable; it was not rewritten");
      return {
        worker: request.worker,
        reason: options.rememberedWorker
          ? `Remembered choice reused: "${request.worker}" was named for this tool in an earlier call - pass worker to switch`
          : "Explicit worker requested by caller",
        candidates: [request.worker],
        matchedRules: options.rememberedWorker ? ["remembered"] : ["explicit"],
      };
    }
    const r = request.requirements ?? {};
    const matchedRules: Array<keyof BrokerConfig["routing"]> = [];
    if (r.coding || r.repository || r.tests) matchedRules.push("coding");
    if (r.longContext || r.multimodal) matchedRules.push("long_context");
    if (r.lowCost || r.structured || r.batch || r.independentReview) matchedRules.push("low_cost");
    if (r.chinesePriority) matchedRules.push("chinese");
    const selected = matchedRules[0] ?? "general";
    const rule = this.config.routing[selected] ?? this.config.routing.general;
    const candidates = [...new Set(rule ? [rule.primary, ...rule.fallback ?? []] : Object.entries(this.config.providers).filter(([, p]) => p.enabled).map(([id]) => id))];
    const worker = candidates.find((id) => (allowWrite ? this.isAvailable(id) : this.selectable(id)));
    if (!worker) throw new BrokerError("WORKER_UNAVAILABLE", `No available worker for ${selected} routing rule or its fallback chain`);
    const fallbackFrom = candidates[0] !== worker ? candidates[0] : undefined;
    return { worker, candidates, matchedRules: matchedRules.length ? matchedRules : ["general"], fallbackFrom,
      reason: `${selected} requirements selected ${worker}${!rule ? ' as the first available enabled worker' : ''}${fallbackFrom ? `; ${fallbackFrom} unavailable, using configured fallback` : ''}` };
  }
}
