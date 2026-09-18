import { describe, expect, it } from "vitest";
import { TOOL_ANNOTATIONS, annotationsFor } from "../../src/interfaces/mcp/annotations.js";
import { PROFILES, PROFILE_NAMES, resolveProfile, toolsForProfile } from "../../src/interfaces/mcp/profiles.js";
import { toolMetadata } from "../../src/interfaces/mcp/tools.js";

/** Task book section 7: the annotation table is contractual, not a hint. */
const EXPECTED = {
  list_workers: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  run_worker: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  delegate: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  delegate_batch: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  get_task: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  get_trace: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
} as const;

describe("MCP tool annotations", () => {
  it.each(Object.entries(EXPECTED))("%s matches the task book table exactly", (name, expected) => {
    const { annotations } = annotationsFor(name as keyof typeof TOOL_ANNOTATIONS);
    expect(annotations).toMatchObject(expected);
  });

  it("marks the compute tools as non-idempotent (they bill a model per call)", () => {
    for (const name of ["run_worker", "delegate", "delegate_batch"] as const) {
      expect(annotationsFor(name).annotations.idempotentHint).toBe(false);
    }
  });

  it("never claims a delegation tool is closed-world", () => {
    for (const name of ["run_worker", "delegate", "delegate_batch"] as const) {
      expect(annotationsFor(name).annotations.openWorldHint).toBe(true);
    }
  });

  it("annotates cancel_task honestly: not read-only, destructive", () => {
    expect(annotationsFor("cancel_task").annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: false });
  });

  it("annotates run_agent honestly: it changes files on disk", () => {
    expect(annotationsFor("run_agent").annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
      idempotentHint: false,
    });
  });

  it("keeps every tool read-only except the one tool that is allowed to write", () => {
    // The invariant: a writing capability must never be smuggled into a tool that is advertised as
    // read-only. Exactly one tool may mutate, and it must say so.
    for (const profile of PROFILE_NAMES) {
      for (const name of toolsForProfile(profile)) {
        const readOnly = annotationsFor(name).annotations.readOnlyHint;
        // Exactly two tools may be advertised as mutating: run_agent (it changes the machine) and
        // cancel_task (it changes broker state). Everything else stays read-only.
        if (name === "run_agent" || name === "cancel_task") {
          expect(readOnly).toBe(false);
        } else {
          expect(readOnly).toBe(true);
        }
      }
    }
  });
});

describe("MCP profiles", () => {
  it("keeps cancel_task local: the agent profile does not expose it", () => {
    expect(toolsForProfile("chatgpt-agent")).not.toContain("cancel_task");
    expect(toolsForProfile("local-full")).toContain("cancel_task");
  });

  it("has exactly two profiles, and only the agent profile carries the write tool", () => {
    expect([...PROFILE_NAMES]).toEqual(["chatgpt-agent", "local-full"]);
    expect(toolsForProfile("chatgpt-agent")).toContain("run_agent");
    expect(toolsForProfile("local-full")).not.toContain("run_agent");
  });

  it("exposes the documented tool set per profile", () => {
    expect([...toolsForProfile("chatgpt-agent")]).toEqual([
      "ping",
      "list_workers",
      "run_worker",
      "delegate",
      "delegate_batch",
      "get_task",
      "get_trace",
      "run_agent",
    ]);
    expect([...toolsForProfile("local-full")]).toEqual([
      "ping",
      "list_workers",
      "run_worker",
      "delegate",
      "delegate_batch",
      "get_task",
      "get_trace",
      "cancel_task",
    ]);
  });

  it("every tool of every profile has annotations and a description", () => {
    for (const profile of PROFILE_NAMES) {
      for (const meta of toolMetadata(profile)) {
        expect(meta.description.length).toBeGreaterThan(30);
        expect(meta.title.length).toBeGreaterThan(2);
        expect(meta.annotations.readOnlyHint).toBeTypeOf("boolean");
      }
    }
  });

  it("rejects an unknown profile at startup", () => {
    expect(() => resolveProfile("chatgpt-pro-readonly-please")).toThrow(expect.objectContaining({ code: "CONFIG_ERROR" }));
    expect(resolveProfile("local-full")).toBe("local-full");
    expect(resolveProfile("chatgpt-agent")).toBe("chatgpt-agent");
    expect(Object.keys(PROFILES)).toHaveLength(2);
  });
});
