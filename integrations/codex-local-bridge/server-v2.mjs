// C4: manual-paste backend — Codex talks to this local Responses bridge, the bridge renders the
// conversation into a prompt file, the human pastes it into chatgpt.com (any web model, including
// ones with no API route), then saves the answer into a reply file. The bridge streams that answer
// back to Codex as an assistant message. No browser automation, no third-party binary, no login
// material handled by us.
//
// Run:
//   BRIDGE_DIR=~/.codex-bridge SPIKE_PORT=8799 node server-v2.mjs
//
// Env:
//   BRIDGE_BACKEND=manual|fixed   (default manual)
//   BRIDGE_TIMEOUT_MS=1800000     how long to wait for the reply file
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const PORT = Number(process.env.SPIKE_PORT ?? 8799);
const DIR = (process.env.BRIDGE_DIR ?? path.join(os.homedir(), ".codex-bridge")).replace(/^~/, os.homedir());
const OUTBOX = path.join(DIR, "outbox");
const REPLY = path.join(DIR, "reply");
const LOG_PATH = process.env.SPIKE_LOG ?? path.join(DIR, "bridge.log");
const BACKEND = process.env.BRIDGE_BACKEND ?? "manual";
const FIXED_TEXT = process.env.SPIKE_TEXT ?? "BRIDGE_FIXED_OK";
const TIMEOUT_MS = Number(process.env.BRIDGE_TIMEOUT_MS ?? 1_800_000);
const MODEL_SLUG = process.env.BRIDGE_MODEL ?? "web-manual";
const CONTEXT_WINDOW = Number(process.env.BRIDGE_CONTEXT_WINDOW ?? 128_000);

for (const d of [DIR, OUTBOX, REPLY]) fs.mkdirSync(d, { recursive: true });

const uuid = () => crypto.randomUUID();
const log = (entry) => fs.appendFileSync(LOG_PATH, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Codex's own model-catalog shape (learned from the reference implementation): a `models` array whose
// rows carry slug/display_name/visibility/supported_in_api/tool_mode/supported_reasoning_levels.
const modelCatalog = () => ({
  models: [
    {
      slug: MODEL_SLUG,
      display_name: "ChatGPT Web (manual paste)",
      description: "Rendered locally; you paste the prompt into chatgpt.com and save the reply back.",
      visibility: "list",
      supported_in_api: true,
      tool_mode: "none",
      input_modalities: ["text"],
      multi_agent_version: "v1",
      max_context_window: CONTEXT_WINDOW,
      supported_reasoning_levels: [
        { effort: "low", description: "ChatGPT Web effort is chosen by you in the browser" },
        { effort: "medium", description: "ChatGPT Web effort is chosen by you in the browser" },
      ],
    },
  ],
});

const snapshot = (id, status, output, endTurn) => ({
  id, object: "response", created_at: Math.floor(Date.now() / 1000),
  status, model: MODEL_SLUG, output, usage: null,
  ...(endTurn === undefined ? {} : { end_turn: endTurn }),
});

function textOf(item) {
  const c = item?.content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  return c.map((p) => p?.text ?? p?.input_text ?? "").filter(Boolean).join("\n");
}

function renderTranscript(input) {
  const lines = [];
  for (const item of input) {
    const t = item?.type;
    if (t === "message" || t === "user_message" || t === "assistant_message") {
      const role = item.role ?? (t === "user_message" ? "user" : "assistant");
      const text = textOf(item);
      if (text) lines.push(`### ${role}\n${text}`);
    } else if (t === "custom_tool_call" || t === "function_call") {
      lines.push(`### tool_call (${item.name ?? "unknown"})\n${typeof item.input === "string" ? item.input : JSON.stringify(item.arguments ?? {})}`);
    } else if (t === "custom_tool_call_output" || t === "function_call_output") {
      const out = typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? "");
      lines.push(`### tool_result\n${out.length > 4000 ? out.slice(0, 4000) + "\n…[truncated]" : out}`);
    }
  }
  return lines.join("\n\n");
}

function writePrompt(instructions, input, tools) {
  const id = `${Date.now()}-${uuid().slice(0, 8)}`;
  const promptPath = path.join(OUTBOX, `${id}.prompt.md`);
  const replyPath = path.join(REPLY, `${id}.reply.md`);
  const toolNote = tools.length
    ? `\n## 可用工具（本轮为纯文本后端，请只用文字回答；若需要工具，请明确说明你要调用哪个工具及其参数）\n${tools.map((t) => `- ${t?.name ?? t?.type}`).join("\n")}\n`
    : "";
  const body = `# 交给 ChatGPT 网页版的提示（由本地 Codex 桥生成）

请把下面整段贴进 chatgpt.com（模型随你选，例如 GPT-5.6 Sol 或 GPT-6 Astra），
然后把它的**完整回答**保存到：

    ${replyPath}

## Codex 侧系统指令（供参考，已由 Codex 提供）
${instructions.slice(0, 2000)}
${toolNote}
## 对话与工具记录
${renderTranscript(input)}
`;
  fs.writeFileSync(promptPath, body, { mode: 0o600 });
  fs.writeFileSync(replyPath + ".waiting", "", { mode: 0o600 });
  return { id, promptPath, replyPath };
}

async function waitForReply(replyPath) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (fs.existsSync(replyPath)) {
      const text = fs.readFileSync(replyPath, "utf8").trim();
      if (text) return text;
    }
    await sleep(1000);
  }
  return "";
}

function sse(res) {
  res.writeHead(200, {
    "content-type": "text/event-stream", "cache-control": "no-cache",
    connection: "keep-alive", "x-request-id": `bridge-${uuid()}`,
  });
  let seq = 0;
  const emit = (name, data) => res.write(`event: ${name}\ndata: ${JSON.stringify({ type: name, sequence_number: seq++, ...data })}\n\n`);
  return { emit, done: () => res.end("data: [DONE]\n\n") };
}

function streamText(res, text) {
  const responseId = `resp_${uuid()}`;
  const itemId = `msg_${uuid()}`;
  const out = sse(res);
  out.emit("response.created", { response: snapshot(responseId, "in_progress", []) });
  out.emit("response.output_item.added", { output_index: 0, item: { type: "message", id: itemId, status: "in_progress", role: "assistant", content: [] } });
  out.emit("response.output_text.delta", { item_id: itemId, output_index: 0, content_index: 0, delta: text });
  out.emit("response.output_text.done", { item_id: itemId, output_index: 0, content_index: 0, text });
  out.emit("response.content_part.done", { item_id: itemId, output_index: 0, content_index: 0, part: { type: "output_text", text, annotations: [] } });
  const item = { type: "message", id: itemId, status: "completed", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] };
  out.emit("response.output_item.done", { output_index: 0, item });
  out.emit("response.completed", { response: snapshot(responseId, "completed", [item]) });
  out.done();
}

const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", async () => {
    if (req.method === "GET") log({ method: "GET", url: req.url, headers: req.headers });
    if (req.method === "GET" && req.url.includes("models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(modelCatalog()));
      return;
    }
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { /* ignore */ }
    const input = Array.isArray(body?.input) ? body.input : [];
    const tools = Array.isArray(body?.tools) ? body.tools : [];
    log({ url: req.url, model: body?.model, stream: body?.stream, inputTypes: input.map((i) => i?.type), toolCount: tools.length });
    if (body?.stream === false) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(snapshot(`resp_${uuid()}`, "completed", [{ type: "message", id: `msg_${uuid()}`, status: "completed", role: "assistant", content: [{ type: "output_text", text: FIXED_TEXT, annotations: [] }] }])));
      return;
    }
    if (BACKEND === "fixed") {
      streamText(res, FIXED_TEXT);
      return;
    }
    const { promptPath, replyPath } = writePrompt(body?.instructions ?? "", input, tools);
    process.stdout.write(
      `\n=== 需要你粘贴一次 ===\n提示文件: ${promptPath}\n把回答保存到: ${replyPath}\n（桥在等这个文件出现，等 ${Math.round(TIMEOUT_MS / 1000)}s）\n\n`,
    );
    const text = await waitForReply(replyPath);
    log({ replied: Boolean(text), replyChars: text.length, promptPath, replyPath });
    if (!text) {
      const out = sse(res);
      const responseId = `resp_${uuid()}`;
      out.emit("response.created", { response: snapshot(responseId, "in_progress", []) });
      out.emit("response.failed", { response: { ...snapshot(responseId, "failed", []), error: { code: "bridge_timeout", message: "no reply file was produced" } } });
      out.done();
      return;
    }
    streamText(res, text);
  });
});

server.listen(PORT, "127.0.0.1", () => log({ listening: PORT, backend: BACKEND, dir: DIR }));
