// Minimal OpenAI Responses API shim, used only to answer one question:
// can a local provider drive `codex exec` (wire_api = "responses")?
// It logs every request Codex sends and replies with a fixed assistant message,
// emitting the same SSE event sequence the reference implementation uses.
//
// Run: SPIKE_PORT=8799 node server.mjs
import http from "node:http";
import fs from "node:fs";
import crypto from "node:crypto";

const PORT = Number(process.env.SPIKE_PORT ?? 8799);
const LOG_PATH = process.env.SPIKE_LOG ?? "/tmp/codex-bridge-spike.log";
const TEXT = process.env.SPIKE_TEXT ?? "SPIKE_OK";
const MODEL = process.env.SPIKE_MODEL ?? "spike-model";

const uuid = () => crypto.randomUUID();
const log = (entry) => fs.appendFileSync(LOG_PATH, JSON.stringify(entry) + "\n");

const snapshot = (id, status, output, endTurn) => ({
  id,
  object: "response",
  created_at: Math.floor(Date.now() / 1000),
  status,
  model: MODEL,
  output,
  usage: null,
  ...(endTurn === undefined ? {} : { end_turn: endTurn }),
});

function writeSse(res) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-request-id": `spike-${uuid()}`,
  });
  let seq = 0;
  const emit = (name, data) => {
    res.write(`event: ${name}\ndata: ${JSON.stringify({ type: name, sequence_number: seq++, ...data })}\n\n`);
  };
  return { emit, done: () => res.end("data: [DONE]\n\n") };
}

const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => { raw += chunk; });
  req.on("end", () => {
    if (req.method === "GET" && req.url.includes("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: MODEL, object: "model", created: 0, owned_by: "spike" }] }));
      return;
    }

    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { /* keep raw */ }
    const input = Array.isArray(body?.input) ? body.input : [];
    log({
      at: new Date().toISOString(),
      url: req.url,
      method: req.method,
      headers: req.headers,
      stream: body?.stream,
      model: body?.model,
      instructions: typeof body?.instructions === "string" ? body.instructions.slice(0, 400) : body?.instructions,
      toolCount: Array.isArray(body?.tools) ? body.tools.length : 0,
      toolNames: Array.isArray(body?.tools) ? body.tools.map((t) => t?.name ?? t?.type).slice(0, 40) : [],
      inputTypes: input.map((item) => item?.type),
      inputSummary: input.slice(-3).map((item) => JSON.stringify(item).slice(0, 300)),
      otherKeys: Object.keys(body ?? {}),
    });

    if (body?.stream === false) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        ...snapshot(`resp_${uuid()}`, "completed", [{ type: "message", id: `msg_${uuid()}`, status: "completed", role: "assistant", content: [{ type: "output_text", text: TEXT, annotations: [] }] }]),
      }));
      return;
    }

    const responseId = `resp_${uuid()}`;
    const itemId = `msg_${uuid()}`;
    const sse = writeSse(res);
    sse.emit("response.created", { response: snapshot(responseId, "in_progress", []) });
    sse.emit("response.output_item.added", {
      output_index: 0,
      item: { type: "message", id: itemId, status: "in_progress", role: "assistant", content: [] },
    });
    sse.emit("response.output_text.delta", { item_id: itemId, output_index: 0, content_index: 0, delta: TEXT });
    sse.emit("response.output_text.done", { item_id: itemId, output_index: 0, content_index: 0, text: TEXT });
    sse.emit("response.content_part.done", {
      item_id: itemId, output_index: 0, content_index: 0,
      part: { type: "output_text", text: TEXT, annotations: [] },
    });
    const item = {
      type: "message", id: itemId, status: "completed", role: "assistant",
      content: [{ type: "output_text", text: TEXT, annotations: [] }],
    };
    sse.emit("response.output_item.done", { output_index: 0, item });
    sse.emit("response.completed", { response: snapshot(responseId, "completed", [item]) });
    sse.done();
  });
});

server.listen(PORT, "127.0.0.1", () => log({ at: new Date().toISOString(), listening: PORT }));
