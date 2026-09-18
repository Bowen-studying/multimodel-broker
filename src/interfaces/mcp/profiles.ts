import { BrokerError } from "../../core/errors.js";
import { PROFILE_NAMES, type ProfileName } from "../../core/types.js";

/**
 * MCP tool profiles.
 *
 * There are exactly two, and the difference is *what a caller may do on this machine*, not which
 * tools exist:
 *
 * - `chatgpt-agent` (default): the read/compute tools plus `run_agent`, which drives a local agent
 *   that CAN write files and run commands. It is mutating by design, so it is only safe where the
 *   caller is trusted; whether a write actually lands is still decided locally by each worker's own
 *   configuration (sandbox / permission mode / enabled workers).
 * - `local-full`: the read/compute tools plus `cancel_task`, for a local harness (Codex / Claude
 *   Code / MCP Inspector on this machine) that is allowed to cancel its own tasks. It exposes no
 *   write tool.
 *
 * The read-only guarantee comes from the *instance*, not from a third profile: run a separate
 * process with its own token and database and simply do not enable any write-capable worker in its
 * config (then `run_agent` fails with "needs an enabled write-capable worker" instead of writing).
 */
export const TOOL_NAMES = [
  "ping",
  "list_workers",
  "run_worker",
  "run_agent",
  "delegate",
  "delegate_batch",
  "get_task",
  "get_trace",
  "cancel_task",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export { PROFILE_NAMES, type ProfileName };

const READ_ONLY_TOOLS: readonly ToolName[] = [
  "ping",
  "list_workers",
  "run_worker",
  "delegate",
  "delegate_batch",
  "get_task",
  "get_trace",
];

export const PROFILES: Record<ProfileName, { description: string; tools: readonly ToolName[] }> = {
  "chatgpt-agent": {
    description:
      "Default profile: the read/compute tools plus run_agent, which drives a local agent (Codex, the Windows Codex build, or local Claude Code) that CAN write files and run commands. Mutating by design. A read-only surface is an INSTANCE decision: run a separate process whose config enables no write-capable worker.",
    tools: [...READ_ONLY_TOOLS, "run_agent"],
  },
  "local-full": {
    description: "Local harness profile: read/compute tools plus cancel_task.",
    tools: [...READ_ONLY_TOOLS, "cancel_task"],
  },
};

export function isProfileName(value: string): value is ProfileName {
  return (PROFILE_NAMES as readonly string[]).includes(value);
}

/** Resolve a profile name; an unknown name is a startup-time configuration error. */
export function resolveProfile(value: string): ProfileName {
  if (!isProfileName(value)) {
    throw new BrokerError("CONFIG_ERROR", `Unknown MCP profile; expected one of: ${PROFILE_NAMES.join(", ")}`);
  }
  return value;
}

export function toolsForProfile(profile: ProfileName): readonly ToolName[] {
  return PROFILES[profile].tools;
}
