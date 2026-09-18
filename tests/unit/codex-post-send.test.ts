/**
 * A failure that arrives AFTER the prompt was delivered must not be auto-retried: the local agent may
 * already have edited files, and the broker's retry loop re-runs the whole task. Observed in
 * production: a `codex-win` run whose SDK gave up with "Reconnecting... 2/5 (request timed out)" was
 * retried twice (3 attempts, 2m23s, each re-sending the prompt). Rate limits stay retryable - they are
 * refused before any work happens.
 */
import { describe, expect, it } from "vitest";
import type { ProviderConfig } from "../../src/core/types.js";
import { CodexProvider, type CodexSdkModule } from "../../src/providers/codex/index.js";

const SIGNAL = new AbortController().signal;

const config = (): ProviderConfig =>
  ({
    enabled: true,
    adapter: "codex-sdk",
    model: "auto",
    authMode: "codex-local",
    maxConcurrency: 1,
    defaultTimeoutMs: 5000,
    sandbox: "read-only",
    options: { requireWorkspace: true },
  }) as ProviderConfig;

/** A fake SDK whose stream ends with the given failure, so the post-send path is exercised. */
function failingSdk(event: { type: "error"; message?: string } | { type: "turn.failed" }): CodexSdkModule {
  return {
    Codex: class {
      startThread() {
        return {
          id: "thread-1",
          async run() {
            return { items: [], finalResponse: "", usage: null };
          },
          async runStreamed() {
            return {
              events: (async function* () {
                yield { type: "thread.started" as const };
                yield event;
              })(),
            };
          },
        };
      }
    },
  } as unknown as CodexSdkModule;
}

async function failureOf(event: { type: "error"; message?: string } | { type: "turn.failed" }) {
  const provider = new CodexProvider("codex", config(), { loadSdk: async () => failingSdk(event), authFileExists: async () => true });
  try {
    await provider.run(
      { taskId: "t1", runId: "r1", task: "do something", workspace: "/tmp", timeoutMs: 5000, traceLevel: "summary" },
      SIGNAL,
    );
    throw new Error("expected the run to fail");
  } catch (error) {
    return error as { code?: string; retryable?: boolean; message?: string };
  }
}

describe("post-send failures are not retried", () => {
  it("treats a transport give-up after delivery as CONNECTION_LOST_AFTER_SEND", async () => {
    const failure = await failureOf({ type: "error", message: "Reconnecting... 2/5 (request timed out)" });

    expect(failure.code).toBe("CONNECTION_LOST_AFTER_SEND");
    expect(failure.retryable).toBe(false);
    expect(failure.message).toContain("timed out");
  });

  it("keeps rate limits retryable, because they are refused before any work happens", async () => {
    const failure = await failureOf({ type: "error", message: "429 Too Many Requests" });

    expect(failure.code).toBe("PROVIDER_RATE_LIMITED");
    expect(failure.retryable).toBe(true);
  });

  it("still reports other in-stream failures as plain provider errors", async () => {
    const failure = await failureOf({ type: "turn.failed" });

    expect(failure.code).toBe("PROVIDER_ERROR");
  });
});
