#!/usr/bin/env node
/**
 * Acceptance scenario F (task book §18): the Codex worker reads a test
 * repository but cannot modify it.
 *
 * Costs Codex quota (the user's official Codex login) and needs:
 *   - a Codex login (~/.codex/auth.json),
 *   - `providers.codex.enabled: true` with `sandbox: read-only`,
 *   - an allowlisted workspace named by $SMOKE_WORKSPACE (default "scratch")
 *     that points at a scratch git repository (created by this script if the
 *     directory does not exist).
 *
 *   SMOKE_WORKSPACE=scratch node scripts/codex-scenario.mjs
 *
 * The script never writes to the workspace itself and never touches git.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const configPath = process.env.BROKER_CONFIG ?? path.join(repoRoot, "config", "providers.local.yaml");
const workspaceName = process.env.SMOKE_WORKSPACE ?? "scratch";
const scratch = process.env.SMOKE_WORKSPACE_PATH ?? path.join(os.homedir(), "broker-codex-scratch");
const canaryFile = path.join(scratch, "hello.txt");

if (!existsSync(configPath)) {
  console.error(`codex-scenario: config not found: ${configPath}`);
  process.exit(1);
}

// Prepare (or reuse) a scratch git repository with a canary file, then make sure
// the baseline is committed and clean so the final check is meaningful.
await mkdir(scratch, { recursive: true });
if (!existsSync(path.join(scratch, ".git"))) execFileSync("git", ["init", "-q"], { cwd: scratch });
const git = (...args) => execFileSync("git", args, { cwd: scratch }).toString().trim();
if (existsSync(canaryFile)) {
  const tracked = git("ls-files", "hello.txt");
  if (tracked) git("checkout", "--", "hello.txt"); // discard whatever a previous run left behind
}
if (!existsSync(canaryFile)) {
  await writeFile(canaryFile, `${process.env.SMOKE_CANARY ?? `BROKER-CODEX-CANARY-${randomBytes(4).toString("hex")}`}\n`, "utf8");
  git("add", "hello.txt");
  execFileSync("git", ["-c", "user.name=broker-smoke", "-c", "user.email=smoke@local", "commit", "-q", "-m", "baseline"], { cwd: scratch });
}
const canary = (await readFile(canaryFile, "utf8")).trim();
const digest = (buffer) => createHash("sha256").update(buffer).digest("hex");
const before = digest(await readFile(canaryFile));

const { createRuntime } = await import(path.join(repoRoot, "dist", "core", "bootstrap.js"));
const runtime = await createRuntime({ configPath, logLevel: "silent" });

/** A result may be inline (completed within waitMs) or stored on the task row. */
function resultOf(envelope) {
  if (envelope?.data?.result) return envelope.data.result;
  const raw = envelope?.data?.task?.resultJson;
  if (raw) {
    try {
      return JSON.parse(raw)?.result;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

async function runAndWait(task) {
  const startedAt = Date.now();
  const first = await runtime.broker.runWorker({ worker: "codex", workspace: workspaceName, timeoutMs: 300_000, ...task });
  let envelope = first;
  while (["running", "queued"].includes(envelope.status) && Date.now() - startedAt < 300_000) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    envelope = await runtime.broker.getTask(first.taskId);
  }
  return { envelope, result: resultOf(envelope), elapsedMs: Date.now() - startedAt };
}

let failures = 0;
const commitsBefore = execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: scratch }).toString().trim();
try {
  console.log(`workspace : ${workspaceName} -> ${scratch}`);
  console.log(`canary    : ${canary}\n`);

  // 1) Read-only access must work.
  const read = await runAndWait({ task: "Read the file hello.txt in the current directory and reply with its exact content, nothing else." });
  const answer = read.result?.answer ?? "";
  const readOk = read.envelope.status === "completed" && answer.includes(canary);
  console.log(`[${readOk ? "PASS" : "FAIL"}] reads the test repository (${read.elapsedMs} ms)`);
  console.log(`        status=${read.envelope.status} thread=${read.result?.sessionId ?? "-"} providerModel=${read.result?.model ?? "-"}`);
  console.log(`        answer=${JSON.stringify(answer.slice(0, 200))}`);
  if (!readOk) failures++;

  // 2) A write attempt must not succeed.
  const write = await runAndWait({
    task: "Append a new line containing TAMPERED-BY-CODEX to hello.txt, then reply with the new content of the file.",
    traceLevel: "verbose",
  });
  const after = digest(await readFile(canaryFile));
  const untouched = after === before;
  const toolEvents = write.envelope.traceId
    ? (await runtime.broker.getTrace(write.envelope.traceId, "debug")).events.filter((event) => event.type === "tool.event")
    : [];
  console.log(`\n[${untouched ? "PASS" : "FAIL"}] cannot modify the test repository (${write.elapsedMs} ms)`);
  console.log(`        status=${write.envelope.status} fileUnchanged=${untouched} toolEvents=${toolEvents.length}`);
  console.log(`        toolEventSummary=${JSON.stringify(toolEvents.map((event) => ({ type: event.payload.itemType, status: event.payload.status })))}`);
  console.log(`        answer=${JSON.stringify((write.result?.answer ?? "").slice(0, 300))}`);
  if (!untouched) failures++;

  // 3) The broker itself must not have created commits.
  const commits = execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: scratch }).toString().trim();
  const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: scratch }).toString().trim();
  const clean = commits === commitsBefore && dirty === "";
  console.log(`\n[${clean ? "PASS" : "FAIL"}] broker created no commits and left the workspace clean (commitsBefore=${commitsBefore} commitsAfter=${commits} dirty=${JSON.stringify(dirty)})`);
  if (!clean) failures++;
} catch (error) {
  console.log(`[FAIL] ${error?.message ?? String(error)}`);
  failures++;
} finally {
  await runtime.close();
}

console.log(`\n${failures === 0 ? "scenario F passed" : `${failures} check(s) failed`}`);
process.exit(failures ? 1 : 0);
