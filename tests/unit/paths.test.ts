import { mkdtemp, mkdir, symlink, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkspaceGuard, canonicalize } from "../../src/security/paths.js";

let directory: string;
let guard: WorkspaceGuard;
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "broker-paths-"));
  await mkdir(path.join(directory, "workspace"));
  await writeFile(path.join(directory, "workspace", "a.txt"), "12345");
  await writeFile(path.join(directory, "outside.txt"), "outside");
  guard = new WorkspaceGuard({ allowed: path.join(directory, "workspace") }, { maxFiles: 2, maxFileBytes: 8 });
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
describe("WorkspaceGuard", () => {
  it.each(["../outside.txt", "nested/../a.txt", "/etc/passwd", "C:\\Windows\\secret", "C:relative", "\\\\host\\share", "a..txt"])("rejects unsafe path %s", async (file) => {
    await expect(guard.validateFiles("allowed", [file])).rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });
  });
  it.each(["unknown", "..", "allowed/child", "C:\\workspace", "/tmp"])("rejects nonallowlisted workspace %s", async (workspace) => {
    await expect(guard.validateFiles(workspace, [])).rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });
  });
  it("rejects a real symlink escape, including a missing descendant", async () => {
    await symlink(directory, path.join(directory, "workspace", "escape"), "dir");
    await expect(guard.validateFiles("allowed", ["escape/outside.txt"])).rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });
    await expect(guard.validateFiles("allowed", ["escape/missing/deep.txt"])).rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });
    expect(await canonicalize(path.join(directory, "workspace", "escape", "missing"))).toBe(path.join(directory, "missing"));
  });
  it("returns canonical paths, portable relative names, and sizes", async () => {
    expect(await guard.validateFiles("allowed", ["a.txt"])).toEqual([{ absolutePath: path.join(directory, "workspace", "a.txt"), relativePath: "a.txt", size: 5 }]);
  });
  it("enforces file count and combined size", async () => {
    await expect(guard.validateFiles("allowed", ["a.txt", "a.txt", "a.txt"])).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
    await expect(guard.validateFiles("allowed", ["a.txt", "a.txt"])).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
    await writeFile(path.join(directory, "workspace", "large"), "123456789");
    await expect(guard.validateFiles("allowed", ["large"])).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
  });
  it("rejects missing files and directories", async () => {
    await expect(guard.validateFiles("allowed", ["missing"])).rejects.toMatchObject({ code: "FILE_NOT_FOUND" });
    await mkdir(path.join(directory, "workspace", "folder"));
    await expect(guard.validateFiles("allowed", ["folder"])).rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });
  });
});
describe("WorkspaceGuard with allowAnyWorkspace", () => {
  const permissive = () => new WorkspaceGuard({ allowed: path.join(directory, "workspace") }, { maxFiles: 2, maxFileBytes: 8 }, { allowAnyWorkspace: true });
  it("follows what the local Codex CLI can reach: any non-sensitive absolute path", async () => {
    const guardAny = permissive();
    await expect(guardAny.resolveWorkspace(directory)).resolves.toBe(await canonicalize(directory));
    await expect(guardAny.resolveWorkspace(path.join(directory, "workspace"))).resolves.toBe(await canonicalize(path.join(directory, "workspace")));
  });
  it("still refuses relative names, traversal and unknown names", async () => {
    const guardAny = permissive();
    await expect(guardAny.resolveWorkspace("somewhere")).rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });
    // note: path.join() would normalise ".." away, so build the raw string on purpose
    await expect(guardAny.resolveWorkspace(`${directory}/..`)).rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });
    await expect(guardAny.resolveWorkspace("")).rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });
  });
  it("never allows credentials or system trees, even in that mode", async () => {
    const guardAny = permissive();
    for (const target of ["/etc", "/etc/hosts", "/root", "/usr/bin", "/mnt/c/Windows", path.join(os.homedir(), ".ssh"), path.join(os.homedir(), ".hermes"), path.join(os.homedir(), ".codex"), path.join(os.homedir(), ".gnupg")]) {
      await expect(guardAny.resolveWorkspace(target)).rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });
    }
  });
  it("keeps the strict allowlist when the switch is off", async () => {
    await expect(guard.resolveWorkspace(directory)).rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });
    await expect(guard.resolveWorkspace(path.join(directory, "workspace"))).rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });
    await expect(guard.resolveWorkspace("allowed")).resolves.toBe(await canonicalize(path.join(directory, "workspace")));
  });
});
