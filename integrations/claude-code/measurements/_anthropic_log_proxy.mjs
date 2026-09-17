// 诊断代理：把 Claude Code 的 Anthropic 请求原样转发给 DeepSeek，同时记录"前缀指纹"，
// 用来判断缓存不命中是"前缀不稳定"还是"端点不支持缓存"。
//
// 用法: node _anthropic_log_proxy.mjs   （监听 8796）
//       ANTHROPIC_BASE_URL=http://127.0.0.1:8796 claude -p ... 
import http from "node:http";
import https from "node:https";
import crypto from "node:crypto";
import fs from "node:fs";

const UPSTREAM = "https://api.deepseek.com/anthropic";
const LOG = process.env.PROXY_LOG ?? "/tmp/anthropic-proxy.jsonl";
const sha = (v) => crypto.createHash("sha256").update(typeof v === "string" ? v : JSON.stringify(v ?? null)).digest("hex").slice(0, 16);

const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    let body = null;
    try { body = JSON.parse(raw); } catch { /* keep raw */ }
    const entry = {
      at: new Date().toISOString(),
      url: req.url,
      stream: body?.stream,
      model: body?.model,
      system_hash: sha(body?.system),
      system_len: typeof body?.system === "string" ? body.system.length : JSON.stringify(body?.system ?? "").length,
      tools_hash: sha(body?.tools),
      tools_count: Array.isArray(body?.tools) ? body.tools.length : 0,
      messages_count: Array.isArray(body?.messages) ? body.messages.length : 0,
      first_user_hash: sha(body?.messages?.[0]?.content),
      body_bytes: raw.length,
      cache_control_seen: raw.includes("cache_control"),
      auth_prefix: (req.headers["x-api-key"] || req.headers.authorization || "").toString().slice(0, 6),
    };
    fs.appendFileSync(LOG, JSON.stringify(entry) + "\n");

    const headers = { ...req.headers, host: "api.deepseek.com", "content-length": Buffer.byteLength(raw) };
    delete headers.connection;
    const up = https.request(`${UPSTREAM}${req.url}`, { method: req.method, headers }, (upRes) => {
      const chunks = [];
      upRes.on("data", (c) => chunks.push(c));
      upRes.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let usage = null;
        try {
          for (const line of text.split("\n")) {
            const s = line.startsWith("data:") ? line.slice(5).trim() : "";
            if (!s || s === "[DONE]") continue;
            const ev = JSON.parse(s);
            if (ev?.usage) usage = ev.usage;
            if (ev?.type === "message_start" && ev?.message?.usage) usage = ev.message.usage;
          }
        } catch { /* ignore */ }
        fs.appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), response_status: upRes.statusCode, usage }) + "\n");
        res.writeHead(upRes.statusCode ?? 502, upRes.headers);
        res.end(text);
      });
    });
    up.on("error", (e) => { res.writeHead(502).end(JSON.stringify({ error: String(e) })); });
    up.end(raw);
  });
});

server.listen(8796, "127.0.0.1", () => console.log("proxy on 8796 ->", UPSTREAM));
