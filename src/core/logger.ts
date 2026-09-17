import { redact } from "../security/redaction.js";
import type { Logger } from "./types.js";

const levels = { debug: 10, info: 20, warn: 30, error: 40, silent: Infinity };
export function createLogger(options: { level?: string; fields?: Record<string, unknown>; write?: (line: string) => void } = {}): Logger {
  const level = options.level ?? process.env.BROKER_LOG_LEVEL ?? "info";
  const threshold = levels[level as keyof typeof levels] ?? levels.info;
  const write = options.write ?? ((line: string) => { process.stderr.write(line); });
  const log = (severity: keyof Logger, msg: string, fields?: Record<string, unknown>) => {
    if (severity === "child" || levels[severity] < threshold) return;
    write(`${JSON.stringify(redact({ ...options.fields, ...fields, timestamp: new Date().toISOString(), level: severity, message: msg }))}\n`);
  };
  return {
    debug: (msg, fields) => log("debug", msg, fields),
    info: (msg, fields) => log("info", msg, fields),
    warn: (msg, fields) => log("warn", msg, fields),
    error: (msg, fields) => log("error", msg, fields),
    child: (fields) => createLogger({ ...options, level, fields: { ...options.fields, ...fields } }),
  };
}
