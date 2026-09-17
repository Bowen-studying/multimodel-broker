import path from "node:path";
import { realpath, stat } from "node:fs/promises";
import { BrokerError } from "../core/errors.js";
import type { BrokerConfig } from "../core/types.js";

export interface ValidatedFile { absolutePath: string; relativePath: string; size: number }

/**
 * Locations that stay refused even when any absolute workspace is allowed: credentials, agent
 * configs and OS/system trees. The write path is reachable from a URL token, so these are the
 * things a leaked token must not be able to rewrite.
 */
export function sensitivePrefixes(home = process.env.HOME ?? "/root"): string[] {
  return [
    path.join(home, ".ssh"), path.join(home, ".aws"), path.join(home, ".gnupg"), path.join(home, ".docker"),
    path.join(home, ".config/gcloud"), path.join(home, ".config/gh"), path.join(home, ".hermes"),
    path.join(home, ".codex"), path.join(home, ".wrangler"), path.join(home, ".cloudflared"),
    "/etc", "/boot", "/proc", "/sys", "/dev", "/root", "/var/lib", "/usr",
    "/mnt/c/Windows", "/mnt/c/Program Files", "/mnt/c/Program Files (x86)", "/mnt/c/ProgramData",
  ];
}

function isUnder(candidate: string, prefix: string): boolean {
  const p = path.resolve(prefix);
  return candidate === p || candidate.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

export async function canonicalize(input: string): Promise<string> {
  let ancestor = path.resolve(input);
  const suffix: string[] = [];
  for (;;) {
    try { return path.resolve(await realpath(ancestor), ...suffix); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new BrokerError("PATH_NOT_ALLOWED", "Cannot canonicalize workspace path");
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw new BrokerError("PATH_NOT_ALLOWED", "Cannot resolve workspace root");
      suffix.unshift(path.basename(ancestor));
      ancestor = parent;
    }
  }
}

export class WorkspaceGuard {
  constructor(private readonly workspaces: BrokerConfig["workspaces"], private readonly limits: Pick<BrokerConfig["limits"], "maxFiles" | "maxFileBytes">, private readonly options: { allowAnyWorkspace?: boolean } = {}) {}

  async resolveWorkspace(name: string): Promise<string> {
    if (!name || name.includes("..")) throw new BrokerError("PATH_NOT_ALLOWED", "Only allowlisted workspace names are accepted");
    if (Object.hasOwn(this.workspaces, name)) return canonicalize(this.workspaces[name]!);
    // "Whatever the local Codex CLI can reach" mode: an absolute path is accepted, minus credentials
    // and system trees. Relative names still have to be allowlisted, so a typo cannot silently
    // resolve to an unexpected directory.
    const absolute = path.isAbsolute(name) || /^[A-Za-z]:[\\/]/.test(name);
    if (!this.options.allowAnyWorkspace || !absolute)
      throw new BrokerError("PATH_NOT_ALLOWED", "Only allowlisted workspace names are accepted");
    const resolved = await canonicalize(name.replace(/\\/g, "/"));
    for (const prefix of sensitivePrefixes())
      if (isUnder(resolved, prefix)) throw new BrokerError("PATH_NOT_ALLOWED", "That location is never writable through the broker");
    return resolved;
  }

  async validateFiles(workspace: string, files: string[]): Promise<ValidatedFile[]> {
    if (files.length > this.limits.maxFiles) throw new BrokerError("LIMIT_EXCEEDED", "files exceeds maxFiles");
    const root = await this.resolveWorkspace(workspace);
    const result: ValidatedFile[] = [];
    let total = 0;
    for (const name of files) {
      if (!name || name.includes("..") || path.isAbsolute(name) || path.win32.isAbsolute(name) || name.includes(":")) {
        throw new BrokerError("PATH_NOT_ALLOWED", "Files must be relative paths without '..'");
      }
      const absolutePath = await canonicalize(path.resolve(root, name.replace(/\\/g, "/")));
      const relativePath = path.relative(root, absolutePath);
      if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
        throw new BrokerError("PATH_NOT_ALLOWED", "File escapes the allowlisted workspace");
      }
      let info;
      try { info = await stat(absolutePath); }
      catch { throw new BrokerError("FILE_NOT_FOUND", "Workspace file does not exist or cannot be read"); }
      if (!info.isFile()) throw new BrokerError("PATH_NOT_ALLOWED", "Only regular files may be submitted");
      total += info.size;
      if (info.size > this.limits.maxFileBytes || total > this.limits.maxFileBytes) throw new BrokerError("FILE_TOO_LARGE", "Files exceed maxFileBytes (total bytes)");
      result.push({ absolutePath, relativePath: relativePath.split(path.sep).join("/"), size: info.size });
    }
    return result;
  }
}
