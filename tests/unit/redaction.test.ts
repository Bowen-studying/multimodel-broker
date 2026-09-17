import { describe, expect, it } from "vitest";
import { redact, redactString, registerSecret } from "../../src/security/redaction.js";

/** The mask the redactor must always leave behind. */
const MASK_PROBE = "[REDACTED]";

describe("redaction", () => {
  it("removes known secrets, sk keys, environment references, and long tokens", () => {
    registerSecret("known-private-value");
    for (const secret of ["known-private-value", "sk-fake-private-key", "${ENV_SECRET}", "a".repeat(64), Buffer.from("example private token bytes repeated many times".repeat(3)).toString("base64")]) {
      expect(redactString(`before ${secret} after`)).not.toContain(secret);
    }
  });
  it.each([
    ["Authorization: Bearer abcdefghijklmnop", "abcdefghijklmnop"],
    ["Authorization=Basic aGlkZGVu", "aGlkZGVu"],
    ["Cookie: session=hidden; other=hidden", "hidden"],
    ["Set-Cookie: session=hidden; HttpOnly", "hidden"],
    ["sessionid=hidden", "hidden"],
    ["api_key=hidden", "hidden"],
    ["https://host/mcp/hidden", "hidden"],
    ["https://user:hidden@host/path", "hidden"],
    ["https://host/path?access_token=hidden", "hidden"],
  ])("scrubs headers, cookies, and credential URLs: %s", (input, secret) => {
    const output = redactString(input);
    expect(output).not.toContain(secret);
    expect(output).toContain(MASK_PROBE);
  });
  it("scrubs nested objects, arrays, sensitive keys, and JSON strings without mutating inputs", () => {
    const input = { nested: [{ apiKey: "opaque", Authorization: "opaque", cookie: "opaque", okay: "hello" }], json: JSON.stringify({ password: "opaque" }) };
    const output = redact(input);
    expect(JSON.stringify(output)).not.toContain("opaque");
    expect(output.nested[0]?.okay).toBe("hello");
    expect(input.nested[0]?.apiKey).toBe("opaque");
  });
  it("handles circular data and error messages", () => {
    const object: Record<string, unknown> = { error: new Error("sk-hidden-key") };
    object.self = object;
    expect(JSON.stringify(redact(object))).not.toContain("sk-hidden-key");
    expect(redact(object).self).toBe("[Circular]");
  });
});
