#!/usr/bin/env node
/**
 * Real-provider smoke test (task book §18, scenarios A/B/C/D/E).
 *
 * Spends a small amount of money: it calls the providers configured in
 * `$BROKER_CONFIG` (default: config/providers.local.yaml) with trivial prompts
 * and a unique random token, so the result can be reconciled against the
 * provider's own billing/dashboard. Never put private code or papers through it.
 *
 *   node scripts/smoke.mjs                 # default config file
 *   BROKER_CONFIG=... node scripts/smoke.mjs
 *
 * Exit code 0 = every mandatory check passed; 1 = at least one failed (the
 * report says which, and `skipped` is used when a provider is not configured).
 */
import { randomBytes } from "node:crypto";
import path from "node:path";
import { existsSync } from "node:fs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const configPath = process.env.BROKER_CONFIG ?? path.join(repoRoot, "config", "providers.local.yaml");
if (!existsSync(configPath)) {
  console.error(`smoke: config file not found: ${configPath} (copy config/providers.example.yaml and fill in the environment)`);
  process.exit(1);
}

const { createRuntime } = await import(path.join(repoRoot, "dist", "core", "bootstrap.js"));

const results = [];
const token = (prefix) => `${prefix}-${randomBytes(4).toString("hex")}`;
const record = (id, status, detail) => {
  results.push({ id, status, detail });
  console.log(`${status === "pass" ? "PASS" : status === "skip" ? "SKIP" : "FAIL"} ${id} ${detail ? `- ${detail}` : ""}`);
};

const runtime = await createRuntime({ configPath, logLevel: "silent" });
const workers = runtime.broker.listWorkers();
const ids = new Set(workers.map((worker) => worker.id));
const answerOf = (envelope) => envelope?.data?.result?.answer ?? "";

try {
  // ---------------------------------------------------------------- scenario A
  if (ids.has("deepseek")) {
    const marker = token("DSPROBE");
    const result = await runtime.broker.runWorker({ worker: "deepseek", task: `Reply with exactly this token and nothing else: ${marker}`, timeoutMs: 60_000 });
    const answer = answerOf(result);
    record(
      "A run_worker(deepseek)",
      result.status === "completed" && answer.includes(marker) ? "pass" : "fail",
      `status=${result.status} model=${result.data?.result?.model} responseId=${result.data?.result?.evidence?.[0]?.content ?? "-"} answer=${JSON.stringify(answer.slice(0, 60))}`,
    );
  } else {
    record("A run_worker(deepseek)", "skip", "worker not configured/enabled");
  }

  // ---------------------------------------------------------------- scenario B
  const routed = await runtime.broker.delegate({ task: "Say OK.", requirements: { lowCost: true }, timeoutMs: 60_000 });
  record(
    "B delegate(lowCost) -> configured primary",
    routed.status === "completed" ? "pass" : "fail",
    `worker=${routed.data?.selectedWorker} reason=${routed.data?.routeReason}`,
  );

  // ---------------------------------------------------------------- scenario C
  const failing = ids.has("mock") ? { worker: "mock", task: "fail: engineered failure" } : undefined;
  const children = [
    { id: "one", worker: ids.has("deepseek") ? "deepseek" : "mock", task: `Reply with exactly: ${token("CHILD1")}` },
    { id: "two", ...(failing ?? { worker: ids.has("deepseek") ? "deepseek" : "mock", task: "Reply with exactly: CHILD2" }) },
    { id: "three", worker: ids.has("deepseek") ? "deepseek" : "mock", task: `Reply with exactly: ${token("CHILD3")}` },
  ];
  const batch = await runtime.broker.delegateBatch({ mode: "parallel", tasks: children, waitMs: 40_000, maxConcurrency: 3 });
  let batchFinal = batch;
  for (let attempt = 0; attempt < 60 && ["running", "queued"].includes(batchFinal.status); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    batchFinal = await runtime.broker.getTask(batch.taskId);
    // get_task returns the task record, not child envelopes; read the parent's stored result instead.
    if (["running", "queued"].includes(batchFinal.status)) continue;
    batchFinal = { ...batch, status: batchFinal.status, data: batchFinal.data?.task?.resultJson ? JSON.parse(batchFinal.data.task.resultJson) : batch.data };
  }
  const statuses = (batchFinal.data?.children ?? []).map((child) => child.status);
  const expected = failing ? ["completed", "failed", "completed"] : ["completed", "completed", "completed"];
  record(
    "C delegate_batch (1 engineered failure)",
    JSON.stringify(statuses) === JSON.stringify(expected) ? "pass" : "fail",
    `parent=${batchFinal.status} children=${JSON.stringify(statuses)}`,
  );

  // ---------------------------------------------------------------- scenario D
  if (ids.has("mock")) {
    const started = await runtime.broker.runWorker({ worker: "mock", task: "slow: long running work", waitMs: 500 });
    const taskId = started.taskId;
    let finished = started;
    for (let attempt = 0; attempt < 40 && ["running", "queued"].includes(finished.status); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      finished = await runtime.broker.getTask(taskId);
    }
    record(
      "D long task returns a taskId then completes",
      started.status === "running" && finished.status === "completed" && started.taskId === finished.taskId ? "pass" : "fail",
      `first=${started.status} final=${finished.status} sameTaskId=${started.taskId === finished.taskId}`,
    );
  }

  // ---------------------------------------------------------------- scenario E
  const trace = await runtime.broker.getTrace(routed.traceId, "verbose");
  const serialised = JSON.stringify(trace);
  const types = trace.events.map((event) => event.type);
  const leaks = /sk-[A-Za-z0-9]{10,}|Authorization:|Bearer [A-Za-z0-9]{8,}|api[-_]?key["':=]/i.test(serialised);
  record(
    "E trace has route/provider/usage facts and no secret-shaped value",
    types.includes("route.selected") && types.includes("run.finished") && !leaks ? "pass" : "fail",
    `events=${types.join(",")}`,
  );
} catch (error) {
  record("smoke run", "fail", error?.message ?? String(error));
} finally {
  await runtime.close();
}

const failed = results.filter((result) => result.status === "fail");
const passed = results.filter((result) => result.status === "pass");
console.log(`\n${passed.length} passed, ${failed.length} failed, ${results.filter((r) => r.status === "skip").length} skipped`);
process.exit(failed.length ? 1 : 0);
