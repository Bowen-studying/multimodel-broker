// Headless Claude Code runner used by the broker's `claude-code` worker.
//
// Runs Claude Code (DeepSeek backend) non-interactively, parses its stream-json events, and prints a
// single-line JSON summary on stdout so the broker can store a file-level audit trail:
//   { status, result, models[], usage{input_tokens,cache_read_input_tokens,output_tokens},
//     cost_estimate_usd, cost_reported_usd, duration_ms, num_turns,
//     files_touched:[{path, tool}], commands[]:[string], web_fetches[]:[string],
//     permission_denials[], session_id }
//
// cost_estimate_usd is OUR figure (tokens x DeepSeek's published prices, cache hits priced as hits).
// cost_reported_usd is Claude Code's own total_cost_usd, which uses Anthropic's price table and runs
// about 500x above the real DeepSeek charge - report the estimate, keep the other only as a label.
//
// Secrets never reach argv: the settings file is written 0600 from the env script and removed after.
//
// Usage:
//   node claude_code_run.mjs --prompt "..." [--model deepseek-flash] [--permission-mode auto]
//                            [--cwd DIR] [--timeout-ms 900000] [--claude-bin /abs/path/to/claude]
//                            [--json-only]
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const PROMPT = arg("prompt", "");
const MODEL = arg("model", "deepseek-flash");
const PERMISSION_MODE = arg("permission-mode", "auto");
const CWD = arg("cwd", process.cwd());
const TIMEOUT_MS = Number(arg("timeout-ms", "900000"));
/**
 * Where the backend endpoint/token come from, in order:
 *   1. `options.envScript` (this file's config),
 *   2. `$CLAUDE_ENV_SCRIPT`,
 *   3. `~/.config/multimodel-broker/claude-code.env` if it exists,
 *   4. otherwise the runner's own environment (export ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN).
 * Step 4 is what makes this portable: a single-user setup needs no script at all.
 */
function resolveEnvScript(explicit) {
  const candidates = [explicit, process.env.CLAUDE_ENV_SCRIPT, path.join(os.homedir(), ".config/multimodel-broker/claude-code.env")];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return "";
}
const ENV_SCRIPT = resolveEnvScript(arg("env-script", process.env.CLAUDE_ENV_SCRIPT ?? ""));

/**
 * Absolute path to the Claude Code CLI. A launcher with a minimal PATH (systemd, cron) cannot
 * resolve a bare "claude", and the failure is invisible until a run happens - so resolve it here:
 * an explicit --claude-bin wins, then the user's login shell, then a bare name as a last resort.
 */
function resolveClaudeBin(explicit) {
  if (explicit) return explicit;
  const found = spawnSync("bash", ["-lc", "command -v claude"], { encoding: "utf8" });
  const first = (found.stdout || "").trim().split("\n")[0];
  return first || "claude";
}
const CLAUDE_BIN = resolveClaudeBin(arg("claude-bin", process.env.CLAUDE_BIN ?? ""));

if (!PROMPT) {
  console.error("--prompt is required");
  process.exit(2);
}

// 1) Resolve the backend env without ever printing it. With a script we source it in a login shell;
//    without one we simply use our own environment, so a plain `export` is a complete setup.
const KEYS = ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "no_proxy"];
const pick = (source) => Object.fromEntries(KEYS.map((k) => [k, source[k] || ""]));
let backend = ENV_SCRIPT
  ? (() => {
      const dumped = spawnSync("bash", ["-lc",
        `source ${JSON.stringify(ENV_SCRIPT)} >/dev/null 2>&1; node -e 'const k=${JSON.stringify(KEYS)};process.stdout.write(JSON.stringify(Object.fromEntries(k.map(x=>[x,process.env[x]||""]))))'`],
        { encoding: "utf8" });
      try { return JSON.parse(dumped.stdout || "{}"); } catch { return {}; }
    })()
  : pick(process.env);
if (!backend.ANTHROPIC_BASE_URL || !backend.ANTHROPIC_AUTH_TOKEN) {
  console.error(JSON.stringify({
    status: "error",
    error: ENV_SCRIPT
      ? `backend env missing: ${ENV_SCRIPT} did not set ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN`
      : "backend env missing: export ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN, or point $CLAUDE_ENV_SCRIPT at a file that does",
  }));
  process.exit(3);
}

const settingsPath = fs.mkdtempSync(path.join(os.tmpdir(), "claude-run-")) + "/settings.json";
// Pin every model slot to the requested backend model: without this, Claude Code silently routes
// helper traffic (summaries/titles) to claude-haiku-*, which the DeepSeek endpoint cannot serve.
fs.writeFileSync(settingsPath, JSON.stringify({
  env: {
    ...backend,
    ANTHROPIC_MODEL: MODEL,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: MODEL,
    ANTHROPIC_DEFAULT_SONNET_MODEL: MODEL,
    ANTHROPIC_DEFAULT_OPUS_MODEL: MODEL,
  },
}), { mode: 0o600 });

const childArgs = ["-p", PROMPT, "--settings", settingsPath, "--output-format", "stream-json", "--verbose",
  "--permission-mode", PERMISSION_MODE, "--model", MODEL, "--add-dir", CWD];

const child = spawn(CLAUDE_BIN, childArgs, { cwd: CWD, stdio: ["ignore", "pipe", "pipe"] });

// A spawn failure (missing binary, no execute permission) must still produce a parseable summary,
// otherwise the broker can only report "no parseable summary" and the real cause is lost.
child.on("error", (error) => {
  clearTimeout(killTimer);
  console.log(JSON.stringify({
    status: "error",
    error: `cannot run ${CLAUDE_BIN}: ${error.message}`,
    claude_bin: CLAUDE_BIN,
    exit_code: null,
  }));
  process.exit(3);
});
let buf = "";
let stderrText = "";
const files = new Map();
const commands = [];
const webFetches = [];
let result = "";
let cost = 0;
let usageReported = {};
let durationMs = 0;
let numTurns = 0;
const models = new Set();
let permissionDenials = [];
let sessionId = "";
let timedOut = false;

const killTimer = setTimeout(() => {
  timedOut = true;
  child.kill("SIGKILL");
}, TIMEOUT_MS);

function handleEvent(ev) {
  const type = ev?.type;
  if (type === "assistant" || type === "user") {
    const content = ev?.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type !== "tool_use") continue;
        const input = block.input ?? {};
        const name = block.name ?? "?";
        if (input.file_path) {
          files.set(String(input.file_path), name);
        } else if (input.notebook_path) {
          files.set(String(input.notebook_path), name);
        }
        if (name === "Bash" && input.command) commands.push(String(input.command).slice(0, 500));
        if ((name === "WebFetch" || name === "WebSearch") && (input.url || input.query)) {
          webFetches.push(String(input.url ?? input.query).slice(0, 300));
        }
      }
    }
    if (ev?.message?.model) models.add(ev.message.model);
  }
  if (type === "result") {
    result = typeof ev.result === "string" ? ev.result : "";
    usageReported = ev.usage ?? {};
    cost = Number(ev.total_cost_usd ?? 0);
    durationMs = Number(ev.duration_ms ?? 0);
    numTurns = Number(ev.num_turns ?? 0);
    permissionDenials = Array.isArray(ev.permission_denials) ? ev.permission_denials : [];
    sessionId = ev.session_id ?? "";
    for (const m of Object.keys(ev.modelUsage ?? {})) models.add(m);
  }
}

const done = new Promise((resolve) => {
  child.stdout.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try { handleEvent(JSON.parse(line)); } catch { /* non-JSON line */ }
    }
  });
  child.stderr.on("data", (c) => { stderrText += c.toString("utf8"); });
  child.on("close", (code) => resolve(code ?? -1));
});

const exitCode = await done;
clearTimeout(killTimer);
fs.rmSync(path.dirname(settingsPath), { recursive: true, force: true });

// DeepSeek peak pricing, USD per 1M tokens: cache-miss input 0.30, cache-hit input 0.006,
// output 1.20. This is an UPPER BOUND: peak rates, and the harness counts every turn's context
// again. Calibrate against the account balance (GET /user/balance) before trusting it as a budget.
// Claude Code reports the whole prompt as input_tokens and the cached share separately, so the
// miss share is the difference - charging both at full price double-counts the same tokens.
const inputTotal = Number(usageReported.input_tokens ?? 0);
const inputHit = Number(usageReported.cache_read_input_tokens ?? 0);
const inputMiss = Math.max(0, inputTotal - inputHit);
const outputTokens = Number(usageReported.output_tokens ?? 0);
const costEstimate = (inputMiss * 0.30 + inputHit * 0.006 + outputTokens * 1.20) / 1e6;

const summary = {
  status: timedOut ? "timeout" : exitCode === 0 ? "ok" : "error",
  exit_code: exitCode,
  model_requested: MODEL,
  models: [...models],
  permission_mode: PERMISSION_MODE,
  cwd: CWD,
  result,
  usage: {
    // Convention: input_tokens is the WHOLE prompt (what the backend reports); the cached share is
    // reported separately, so a reader can recompute the bill as (input - cache_read) + cache_read.
    input_tokens: inputTotal,
    cache_read_input_tokens: inputHit,
    cache_creation_input_tokens: Number(usageReported.cache_creation_input_tokens ?? 0),
    output_tokens: outputTokens,
  },
  cost_estimate_usd: Number(costEstimate.toFixed(6)),
  cost_reported_usd: cost,
  duration_ms: durationMs,
  num_turns: numTurns,
  files_touched: [...files].map(([p, tool]) => ({ path: p, tool })),
  commands,
  web_fetches: webFetches,
  permission_denials: permissionDenials,
  session_id: sessionId,
  ...(stderrText ? { stderr_tail: stderrText.slice(-400) } : {}),
};

process.stdout.write(JSON.stringify(summary) + "\n");
if (!args.includes("--json-only")) {
  console.error(`[claude-code] ${summary.status} model=${summary.models.join(",")} `
    + `cost_est=$${costEstimate.toFixed(5)} (reported $${cost.toFixed(4)}) turns=${numTurns}`);
  console.error(`[claude-code] 触碰文件 ${summary.files_touched.length} 个, 命令 ${commands.length} 条, 网页 ${webFetches.length} 次, 权限拒绝 ${permissionDenials.length} 次`);
}
