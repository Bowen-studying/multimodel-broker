const MASK = "[REDACTED]";
const secrets = new Set<string>();
const sensitiveName = /(?:authorization|cookie|password|passwd|secret|credential|api[-_]?key|(?:^|[_-])token(?:$|[_-]))/i;

export function registerSecret(value: string): void {
  if (value) secrets.add(value);
}

export function isSecretName(name: string): boolean {
  return sensitiveName.test(name) && !/(?:Env|Name)$/i.test(name);
}

export function redactString(value: string, knownSecrets: Iterable<string> = []): string {
  let result = value;
  // JSON strings are common at storage boundaries; redact their keys as well.
  if (/^\s*[\[{]/.test(value)) {
    try { return JSON.stringify(redact(JSON.parse(value), knownSecrets)); } catch { /* ordinary text */ }
  }
  result = result.replace(/https?:\/\/[^\s<>"']+/gi, (url) => {
    if (/\/mcp(?:[/?#]|$)|[?&#](?:[^=&#]*(?:token|key|secret|auth|credential)[^=&#]*)=|https?:\/\/[^/]*@/i.test(url)) return MASK;
    return url;
  });
  const values = new Set([...secrets, ...knownSecrets]);
  for (const [name, secret] of Object.entries(process.env)) {
    if (isSecretName(name) && secret) values.add(secret);
  }
  for (const secret of [...values].sort((a, b) => b.length - a.length)) {
    if (secret) result = result.split(secret).join(MASK);
  }
  return result
    .replace(/\$\{[A-Za-z_][A-Za-z0-9_]*\}/g, MASK)
    .replace(/\bsk-[A-Za-z0-9_-]+/g, MASK)
    .replace(/\b(?:Authorization|Proxy-Authorization)\s*[:=]\s*[^\r\n]+/gi, `Authorization: ${MASK}`)
    .replace(/\b(?:Set-Cookie|Cookie)\s*[:=]\s*[^\r\n]+/gi, `Cookie: ${MASK}`)
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi, `Bearer ${MASK}`)
    .replace(/\b(?:session(?:id)?|access_token|refresh_token|api_key|password)\s*=\s*[^;\s]+/gi, (s) => `${s.slice(0, s.indexOf("="))}=${MASK}`)
    .replace(/\b[a-f0-9]{40,}\b/gi, MASK)
    .replace(/(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{48,}={0,2}(?![A-Za-z0-9+/_-])/g, MASK);
}

/** Sanitizes without mutating caller-owned data, including cyclic error details. */
export function redact<T>(value: T, knownSecrets: Iterable<string> = []): T {
  const known = [...knownSecrets];
  const seen = new WeakSet<object>();
  const visit = (item: unknown): unknown => {
    if (typeof item === "string") return redactString(item, known);
    if (typeof item === "bigint") return item.toString();
    if (!item || typeof item !== "object") return item;
    if (seen.has(item)) return "[Circular]";
    seen.add(item);
    let result: unknown;
    if (Array.isArray(item)) result = item.map(visit);
    else if (item instanceof Date) result = item.toISOString();
    else {
      const entries = item instanceof Error ? { ...item, name: item.name, message: item.message } : item;
      result = Object.fromEntries(Object.entries(entries).map(([key, val]) => [
        redactString(key, known),
        isSecretName(key) ? MASK : key === "sha256" && typeof val === "string" && /^[a-f0-9]{64}$/.test(val)
          ? val : visit(val),
      ]));
    }
    seen.delete(item);
    return result;
  };
  return visit(value) as T;
}

export const sanitize = redact;
