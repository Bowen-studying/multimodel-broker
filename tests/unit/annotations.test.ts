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

  it("keeps every tool of the read-only profile genuinely read-only", () => {
    // The invariant the task book demands: a writing capability must never be
    // smuggled into a profile that is advertised as read-only.
    for (const name of toolsForProfile("chatgpt-pro-readonly")) {
      expect(annotationsFor(name).annotations.readOnlyHint).toBe(true);
    }
  });
});

describe("MCP profiles", () => {
  it("hides cancel_task from the ChatGPT Pro profile", () => {
    expect(toolsForProfile("chatgpt-pro-readonly")).not.toContain("cancel_task");
    expect(toolsForProfile("local-full")).toContain("cancel_task");
    expect(toolsForProfile("chatgpt-agent")).not.toContain("cancel_task");
  });

  it("keeps run_agent out of every read-only profile and in the agent profile", () => {
    expect(toolsForProfile("chatgpt-pro-readonly")).not.toContain("run_agent");
    expect(toolsForProfile("local-full")).not.toContain("run_agent");
    expect(toolsForProfile("chatgpt-agent")).toContain("run_agent");
  });

  it("exposes exactly the read-only set to ChatGPT Pro", () => {
    expect([...toolsForProfile("chatgpt-pro-readonly")]).toEqual([
      "ping",
      "list_workers",
      "run_worker",
      "delegate",
      "delegate_batch",
      "get_task",
      "get_trace",
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
    expect(Object.keys(PROFILES)).toHaveLength(3);
  });
});
