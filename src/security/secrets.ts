import { readFile } from "node:fs/promises";
import { BrokerError } from "../core/errors.js";
import { isSecretName, registerSecret } from "./redaction.js";

export async function loadEnvFile(path: string): Promise<void> {
  let text: string;
  try { text = await readFile(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new BrokerError("CONFIG_ERROR", "Unable to read environment file");
  }
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    const name = match[1]!;
    let value = match[2]!;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, "").trim();
    if (process.env[name] === undefined) process.env[name] = value;
    if (isSecretName(name) && process.env[name]) registerSecret(process.env[name]!);
  }
}

export function requireSecret(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const value = env[name];
  if (!value) throw new BrokerError("SECRET_MISSING", `Required environment variable ${/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : '(invalid name)'} is not set`);
  registerSecret(value);
  return value;
}

export function describeSecret(name: string, env: NodeJS.ProcessEnv = process.env): "set" | "missing" {
  return env[name] ? "set" : "missing";
}

export function resolveEnvRefs(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
    const resolved = env[name] ?? "";
    if (isSecretName(name)) registerSecret(resolved);
    return resolved;
  });
}
