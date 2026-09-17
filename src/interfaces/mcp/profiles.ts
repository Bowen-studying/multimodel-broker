import { BrokerError } from "../../core/errors.js";
import { PROFILE_NAMES, type ProfileName } from "../../core/types.js";

/**
 * MCP tool profiles.
 *
 * `chatgpt-pro-readonly` is the narrow profile used by the ChatGPT Pro bridge:
 * read/compute tools only. `cancel_task` is deliberately absent because it
 * mutates broker state and is therefore not a read-only capability.
 *
 * `local-full` is for a local harness (Codex / Claude Code / Hermes / MCP
 * Inspector on this machine) which is allowed to cancel its own tasks.
 */
export const TOOL_NAMES = [
  "ping",
  "list_workers",
  "run_worker",
  "run_agent",
  "run_claude_code",
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
  "chatgpt-pro-readonly": {
    description: "Read/compute tools only. No cancel_task. Used by the ChatGPT Pro bridge.",
    tools: READ_ONLY_TOOLS,
  },
  "chatgpt-agent": {
    description:
      "Cloud agent profile: the read/compute tools plus run_agent (local Codex) and run_claude_code (local Claude Code on DeepSeek). Both drive a local agent that CAN write files, so this profile is mutating by design - never use it where a read-only surface is required.",
    tools: [...READ_ONLY_TOOLS, "run_agent", "run_claude_code"],
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
