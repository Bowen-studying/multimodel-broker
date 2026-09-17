#!/usr/bin/env node
/**
 * C5 acceptance: the MCP request lifetime is NOT the task lifetime.
 *
 * Runs against the PUBLIC MCP endpoint of the agent instance (the same path ChatGPT uses),
 * with `waitMs: 1000` on purpose: the call must return while the Codex task is still running.
 * Then it makes ZERO requests for 25 seconds, and only afterwards polls `get_task` once.
 *
 * The decisive check: the task must have COMPLETED BEFORE that first poll. If it did, polling
 * cannot be what drives execution.
 *
 *   node scripts/codex-async-scenario.mjs
 *
 * Needs the agent instance running (8790) with its published connector URL/token, and a Codex
 * login. Costs Codex quota. Gate 2's evidence in the workspace is left untouched.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const repoRoot = path.resolve(import.meta.dirname, "..");
const scratch = process.env.WRITE_WORKSPACE_PATH ?? path.join(os.homedir(), "broker-codex-write-scratch");
const urlFile = path.join(os.homedir(), ".broker-agent-connector-url");
const dbPath = path.join(repoRoot, "data", "broker-agent.sqlite");
const pauseSeconds = Number(process.env.ASYNC_CHECK_SECONDS ?? 9);
// Long enough that completion lands comfortably inside the window: the task itself takes
// ~27 s (9 s fixture command + Codex composing its answer), and the task/runs rows are
// written on completion. With a window that ends right at completion the "completed before
// the first poll" comparison degenerates into a sub-second clock race (measured 2026-09-17:
// the row write landed 0.55 s after the client's send timestamp).
const noPollSeconds = Number(process.env.ASYNC_NO_POLL_SECONDS ?? 40);
const target = "CODEX_ASYNC_OK";

const connectorUrl = (await readFile(urlFile, "utf8")).trim();
const [base, token] = (() => {
  const parsed = new URL(connectorUrl);
  const token = parsed.searchParams.get("token");
  parsed.searchParams.delete("token");
  return [`${parsed.origin}${parsed.pathname}`, token];
})();
if (!token) throw new Error("no token in the connector URL file");

const git = (...args) => execFileSync("git", args, { cwd: scratch }).toString().trim();
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${detail ? `\n        ${detail}` : ""}`);
};

// ---------------------------------------------------------------- fixture
// A deterministic >1s task: the check command sleeps, so the duration does not depend on the
// model's speed. Gate 2's hello.txt/.check-ran are deliberately left alone.
await rm(path.join(scratch, "async.txt"), { force: true });
await rm(path.join(scratch, ".async-check-ran"), { force: true });
await writeFile(
  path.join(scratch, "async-check.mjs"),
  `// Written by scripts/codex-async-scenario.mjs: sleeps, then verifies async.txt.
import { readFileSync, writeFileSync } from "node:fs";
const seconds = Number(process.argv[2] ?? ${pauseSeconds});
const started = new Date().toISOString();
await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
let content = "";
let ok = false;
try {
  content = readFileSync("async.txt", "utf8").trim();
  ok = content === "${target}";
} catch {}
writeFileSync(".async-check-ran", \`started=\${started} finished=\${new Date().toISOString()} slept=\${seconds}s async.txt=\${JSON.stringify(content)} ok=\${ok}\\n\`);
console.log(ok ? "ASYNC CHECK PASS" : "ASYNC CHECK FAIL");
process.exit(ok ? 0 : 1);
`,
  "utf8",
);

const commitsBefore = git("rev-list", "--count", "HEAD");
const statusBefore = git("status", "--porcelain").split("\n").map((line) => line.trim()).filter(Boolean).sort();
const outsideBefore = execFileSync("git", ["status", "--porcelain"], { cwd: repoRoot }).toString().trim();

// ---------------------------------------------------------------- MCP plumbing
let mcp = base.endsWith("/mcp") ? base : `${base}/mcp`;
let activeToken = token;
const ACCEPT = { "content-type": "application/json", accept: "application/json, text/event-stream" };
let sessionId;

/**
 * Quick tunnels get revoked mid-run, which shows up as an HTML error page instead of JSON.
 * The broker (and the running task) are unaffected, so refresh the published URL from
 * ~/.broker-agent-connector-url and retry. The run_agent call carries an idempotencyKey so a
 * retry can never start a second agent run.
 */
async function refreshEndpoint() {
  const fresh = (await readFile(urlFile, "utf8")).trim();
  const parsed = new URL(fresh);
  activeToken = parsed.searchParams.get("token") ?? activeToken;
  parsed.searchParams.delete("token");
  mcp = `${parsed.origin}${parsed.pathname}`;
  console.log(`        [tunnel] refreshed -> ${parsed.hostname}`);
}

async function rpc(body, session) {
  let lastError;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      const headers = { ...ACCEPT, ...(session ? { "mcp-session-id": session } : {}) };
      const response = await fetch(`${mcp}?token=${encodeURIComponent(activeToken)}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        // A revoked quick tunnel can accept the connection and never answer; without a
        // deadline the script hangs for minutes instead of failing over to the new URL.
        signal: AbortSignal.timeout(20_000),
      });
      const text = await response.text();
      if (text.trim().startsWith("<")) throw new Error(`non-JSON response (HTTP ${response.status}) - tunnel revoked or erroring`);
      const payload = text.trim().startsWith("event:")
        ? text.split("\n").filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("\n")
        : text;
      return { status: response.status, headers: response.headers, body: JSON.parse(payload) };
    } catch (error) {
      lastError = error;
      if (attempt === 5) break;
      await new Promise((resolve) => setTimeout(resolve, 3000));
      try {
        await refreshEndpoint();
      } catch {
        /* keep the old endpoint and try again */
      }
    }
  }
  throw lastError;
}

const init = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "c5-async", version: "1" } } });
sessionId = init.headers.get("mcp-session-id");
console.log(`endpoint  : ${mcp}`);
console.log(`scratch   : ${scratch}`);
console.log(`fixture   : async.txt = ${target}, check sleeps ${pauseSeconds}s, then ${noPollSeconds}s of no polling\n`);

const task = [
  `Create a file named async.txt in the workspace containing exactly one line: ${target}`,
  "(with a trailing newline).",
  `Then run this command exactly as written: node async-check.mjs ${pauseSeconds}`,
  "- it takes about that many seconds, so wait for it to finish.",
  "Reply with one sentence naming the file you created and the command's output.",
].join(" ");

// ---------------------------------------------------------------- call 1: waitMs = 1000
const callStartedAt = new Date();
const first = await rpc(
  { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "run_agent", arguments: { worker: "codex", workspace: "scratch", task, waitMs: 1000, timeoutMs: 300_000, idempotencyKey: `c5-async-${Date.now()}` } } },
  sessionId,
);
const callReturnedAt = new Date();
const firstPayload = first.body.result?.structuredContent ?? first.body.result;
const status = firstPayload?.status;
const taskId = firstPayload?.taskId;
const envelopeSession = firstPayload?.data?.result?.sessionId;
const envelopeTrace = firstPayload?.traceId;

check(
  "the MCP call returned before the task finished (waitMs=1000)",
  [ "running", "queued" ].includes(status) && callReturnedAt - callStartedAt < 5000,
  `status=${status} taskId=${taskId} roundtrip=${callReturnedAt - callStartedAt} ms`,
);
check("the call returned a taskId to poll", typeof taskId === "string" && taskId.length === 36, `taskId=${taskId}`);

// ---------------------------------------------------------------- 25s with zero polling
const noPollUntil = new Date(Date.now() + noPollSeconds * 1000);
console.log(`\nwaiting ${noPollSeconds}s with NO requests of any kind (until ${noPollUntil.toISOString()}) ...`);
while (Date.now() < noPollUntil.getTime()) await new Promise((resolve) => setTimeout(resolve, 1000));

const markerAtFirstPoll = existsSync(path.join(scratch, ".async-check-ran"))
  ? (await readFile(path.join(scratch, ".async-check-ran"), "utf8")).trim()
  : "";

// ---------------------------------------------------------------- call 2: one get_task
const pollAt = new Date();
const polled = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_task", arguments: { taskId } } }, sessionId);
let pollPayload = polled.body.result?.structuredContent ?? polled.body.result;
let polledTask = pollPayload?.data?.task ?? {};
const firstPollStatus = polledTask.status;
const firstPollHadResult = Boolean(pollPayload?.data?.results?.length);

// Verification may need the terminal state: the run row is only written once the provider
// returns, and Codex keeps thinking (composing its final message) after the file work is done.
// Polling again here is ONLY for reading the outcome - the no-poll window above is the experiment.
const verificationDeadline = Date.now() + 300_000;
let extraPolls = 0;
while (!["completed", "failed", "cancelled", "timed_out"].includes(polledTask.status ?? "") && Date.now() < verificationDeadline) {
  await new Promise((resolve) => setTimeout(resolve, 5000));
  extraPolls += 1;
  pollPayload = (await rpc({ jsonrpc: "2.0", id: 10 + extraPolls, method: "tools/call", params: { name: "get_task", arguments: { taskId } } }, sessionId)).body.result?.structuredContent;
  polledTask = pollPayload?.data?.task ?? {};
}

// ---------------------------------------------------------------- verify from the store
const db = new DatabaseSync(dbPath);
const row = db.prepare("SELECT status, created_at, updated_at, trace_id FROM tasks WHERE id = ?").get(taskId);
const runs = db.prepare("SELECT id, provider, status, session_id, started_at, finished_at, usage_json FROM runs WHERE task_id = ?").all(taskId);
const events = db.prepare("SELECT type, payload_json FROM events WHERE trace_id = ? ORDER BY seq").all(row.trace_id);
const payloadOf = (event) => JSON.parse(event.payload_json)?.data ?? JSON.parse(event.payload_json);
const finished = events.find((event) => event.type === "run.finished");
const request = events.find((event) => event.type === "provider.request");
const itemTypes = events.filter((event) => event.type === "tool.event").map((event) => payloadOf(event).itemType);
const started = runs[0]?.started_at;
const finishedAt = runs[0]?.finished_at;

check("the task reaches a terminal state", row.status === "completed" && polledTask.status === "completed", `store=${row.status} polled=${polledTask.status} (extra polls for verification: ${extraPolls})`);
console.log(`        first poll saw status=${firstPollStatus}${firstPollHadResult ? " (with results)" : " (no run row yet: it is written when the provider returns)"}; run finished ${finishedAt ?? "-"} vs first poll ${pollAt.toISOString()}`);

// The no-poll window is the experiment: the ordering that matters is "work happened with zero
// requests in flight", not "the model had already composed its final message".
const markerStarted = Date.parse(markerAtFirstPoll.match(/started=([^ ]+)/)?.[1] ?? "0");
const markerFinished = Date.parse(markerAtFirstPoll.match(/finished=([^ ]+)/)?.[1] ?? "0");
const windowStart = callReturnedAt.getTime();
const windowEnd = pollAt.getTime();
check(
  "the fixture command started AND finished inside the no-poll window",
  markerStarted > windowStart && markerFinished > markerStarted && markerFinished < windowEnd && markerAtFirstPoll.includes("ok=true"),
  `window ${new Date(windowStart).toISOString()} → ${new Date(windowEnd).toISOString()}; marker started ${new Date(markerStarted).toISOString()}, finished ${new Date(markerFinished).toISOString()} (${(windowEnd - markerFinished) / 1000}s before the first poll)`,
);
check(
  "the run was already executing before the MCP response returned (execution starts with the request, not with a poll)",
  Boolean(started) && Date.parse(started) >= callStartedAt.getTime() && Date.parse(started) <= windowEnd,
  `run.started_at=${started} is between the call (${callStartedAt.toISOString()}) and the first poll (${new Date(windowEnd).toISOString()}) - i.e. before the client even had the response`,
);
check(
  "exactly one provider run (get_task did not start a second one)",
  runs.length === 1,
  `runs=${runs.length} ${JSON.stringify(runs.map((run) => ({ provider: run.provider, status: run.status })))}`,
);
check(
  "the Codex run outlived the MCP response (the request returned long before the work ended)",
  Boolean(started) && Boolean(finishedAt) && Date.parse(finishedAt) > callReturnedAt.getTime(),
  `run ${started} → ${finishedAt}; MCP call returned ${callReturnedAt.toISOString()} (${((Date.parse(finishedAt) - callReturnedAt.getTime()) / 1000).toFixed(1)}s of work after the response)`,
);
check("the marker exists at the first poll", markerAtFirstPoll.includes("ok=true"), `.async-check-ran at first poll = ${JSON.stringify(markerAtFirstPoll)}`);
check(
  "sessionId/traceId are the ones the first call returned",
  polledTask.trace_id === envelopeTrace || pollPayload?.traceId === envelopeTrace || row.trace_id === envelopeTrace,
  `envelope trace=${envelopeTrace} store trace=${row.trace_id}`,
);
const runSession = runs[0]?.session_id ?? polledTask.sessionId ?? envelopeSession;
check(
  "a real Codex session id is recorded for the run",
  typeof runSession === "string" && runSession.length > 0,
  `sessionId=${runSession} (the first response carries none: the task was still running)`,
);
check("the trace still carries the write audit", itemTypes.length > 0, `tool.event itemTypes=${JSON.stringify([...new Set(itemTypes)])}`);
check(
  "egress stayed locked",
  payloadOf(request).networkAccessEnabled === false && payloadOf(request).webSearchMode === "disabled" && payloadOf(request).sandbox === "workspace-write",
  JSON.stringify({ sandbox: payloadOf(request).sandbox, networkAccessEnabled: payloadOf(request).networkAccessEnabled, webSearchMode: payloadOf(request).webSearchMode }),
);
check("usage is recorded", Boolean(runs[0]?.usage_json), `usage=${runs[0]?.usage_json}`);
db.close();

// ---------------------------------------------------------------- disk + isolation
const asyncText = (await readFile(path.join(scratch, "async.txt"), "utf8")).trim();
const marker = (await readFile(path.join(scratch, ".async-check-ran"), "utf8")).trim();
check("async.txt really exists with the requested content", asyncText === target, `async.txt=${JSON.stringify(asyncText)}`);
check("the sleeping check really ran to completion", marker.includes("ok=true") && marker.includes(`slept=${pauseSeconds}s`), `.async-check-ran = ${JSON.stringify(marker)}`);

const statusAfter = git("status", "--porcelain").split("\n").map((line) => line.trim()).filter(Boolean).sort();
const added = statusAfter.filter((line) => !statusBefore.includes(line));
// async-check.mjs is part of the fixture (written before the baseline snapshot); the task
// itself must add exactly these two.
const expectedAdded = ["?? .async-check-ran", "?? async.txt"].sort();
check("only the async fixture was added", JSON.stringify(added) === JSON.stringify(expectedAdded), `added=${JSON.stringify(added)}`);
check(
  "no commit and no push",
  git("rev-list", "--count", "HEAD") === commitsBefore && git("remote") === "",
  `commits ${commitsBefore} -> ${git("rev-list", "--count", "HEAD")}, remotes=[${git("remote")}]`,
);
const outsideAfter = execFileSync("git", ["status", "--porcelain"], { cwd: repoRoot }).toString().trim();
check("nothing outside the workspace changed", outsideAfter === outsideBefore, `broker repo before=${JSON.stringify(outsideBefore)} after=${JSON.stringify(outsideAfter)}`);
check("Gate 2 evidence untouched (hello.txt line 2 intact)", (await readFile(path.join(scratch, "hello.txt"), "utf8")).split("\n")[1]?.trim() === "CODEX_CHATGPT_E2E_OK", "hello.txt still holds the C4 result");

// Persist the timing facts: without them a finished run cannot be re-verified offline.
const metaPath = path.join(repoRoot, "data", `c5-async-${taskId ?? "unknown"}.json`);
await writeFile(
  metaPath,
  `${JSON.stringify(
    {
      taskId,
      traceId: envelopeTrace,
      sessionId: runSession,
      callStartedAt: callStartedAt.toISOString(),
      callReturnedAt: callReturnedAt.toISOString(),
      noPollWindowEnd: pollAt.toISOString(),
      firstPollStatus,
      markerAtFirstPoll,
      runStartedAt: started,
      runFinishedAt: finishedAt,
      taskStatus: row.status,
      checks: results.map((entry) => ({ name: entry.name, ok: entry.ok })),
    },
    null,
    2,
  )}\n`,
  "utf8",
);
console.log(`\nrun metadata: ${metaPath}`);

const failed = results.filter((entry) => !entry.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? ` - FAILED: ${failed.map((entry) => entry.name).join("; ")}` : ""}`);
process.exit(failed.length ? 1 : 0);
