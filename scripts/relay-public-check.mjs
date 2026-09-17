#!/usr/bin/env node
/**
 * R3 acceptance: drive both relay channels through the PUBLIC workers.dev URL - the same path
 * ChatGPT uses - and read the result back from the broker's own SQLite database.
 *
 *   NODE_USE_ENV_PROXY=1 node scripts/relay-public-check.mjs [--deepseek]
 *
 * Read-only by design: it never calls run_agent. It reads the device credentials from
 * ~/.broker-relay-device.json (mode 600) and prints only lengths/fingerprints, never tokens.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DEEPSEEK = process.argv.includes('--deepseek');
const device = JSON.parse(readFileSync(join(homedir(), '.broker-relay-device.json'), 'utf8'));
const base = device.url;
const url = (channel) => `${base}/mcp/${device.deviceId}/${channel}/${channel === 'readonly' ? device.readonlyMcpToken : device.agentMcpToken}`;
let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  PASS ${m}`); };
const bad = (m) => { fail++; console.log(`  FAIL ${m}`); };
const head = (m) => console.log(`\n== ${m} ==`);

async function rpc(channel, method, params, session, id = 1) {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': '2025-11-25',
    'user-agent': 'relay-public-check/1.0',
  };
  if (session) headers['mcp-session-id'] = session;
  const res = await fetch(url(channel), {
    method: 'POST', headers,
    body: JSON.stringify({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, ...(params ? { params } : {}) }),
  });
  const text = await res.text();
  const body = text.startsWith('event:') || text.includes('\ndata:') || text.startsWith('data:')
    ? JSON.parse(text.split('\n').find((l) => l.startsWith('data:')).slice(5))
    : (text ? JSON.parse(text) : undefined);
  return { status: res.status, session: res.headers.get('mcp-session-id') ?? session, body };
}

head('endpoint');
console.log(`  relay:    ${base}`);
console.log(`  deviceId: ${device.deviceId}`);
console.log(`  tokens:   readonly len=${device.readonlyMcpToken.length} agent len=${device.agentMcpToken.length} (values never printed)`);

head('readonly channel (M0/M1 must still hold)');
const init = await rpc('readonly', 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'relay-public-check', version: '1' } });
init.status === 200 && init.body?.result?.serverInfo ? ok(`initialize HTTP ${init.status} serverInfo=${init.body.result.serverInfo.name}`) : bad(`initialize HTTP ${init.status}: ${JSON.stringify(init.body).slice(0, 160)}`);
const notif = await rpc('readonly', 'notifications/initialized', undefined, init.session, undefined);
[200, 202, 204].includes(notif.status) ? ok(`notifications/initialized HTTP ${notif.status}`) : bad(`notifications HTTP ${notif.status}`);
const tools = await rpc('readonly', 'tools/list', {}, init.session, 2);
const names = tools.body?.result?.tools?.map((t) => t.name) ?? [];
const readonlyTool = tools.body?.result?.tools?.find((t) => t.name === 'run_agent');
// Two topologies are valid: the split one (read-only channel -> 8789, 7 tools) and the single-entry
// one (this channel -> 8790, 8 tools including run_agent). Report which one is live instead of
// assuming, and always assert that a visible run_agent carries honest mutating annotations.
names.length >= 7
  ? ok(`tools/list = ${names.length} tools: ${names.join(', ')}${readonlyTool ? ' [single-entry: run_agent visible]' : ' [read-only channel]'}`)
  : bad(`tools/list = ${names.length} tools (${names.join(', ')}) - expected at least 7`);
if (readonlyTool)
  readonlyTool.annotations?.readOnlyHint === false && readonlyTool.annotations?.destructiveHint === true
    ? ok('run_agent annotations on this channel are honest: readOnlyHint=false destructiveHint=true')
    : bad(`run_agent annotations: ${JSON.stringify(readonlyTool.annotations)}`);

const ping = await rpc('readonly', 'tools/call', { name: 'ping', arguments: {} }, init.session, 3);
const pingText = ping.body?.result?.content?.[0]?.text ?? '';
pingText.includes('"ok": true') ? ok('ping returned ok') : bad(`ping: ${pingText.slice(0, 120)}`);

const workers = await rpc('readonly', 'tools/call', { name: 'list_workers', arguments: {} }, init.session, 4);
const workersText = workers.body?.result?.content?.[0]?.text ?? '';
workersText.includes('deepseek') ? ok(`list_workers reports deepseek (${(workersText.match(/"id":\s*"([a-z]+)"/g) ?? []).join(' ').slice(0, 120)})`) : bad(`list_workers: ${workersText.slice(0, 160)}`);

let taskId;
if (DEEPSEEK) {
  const marker = 'RELAY_R3_' + Math.random().toString(16).slice(2, 10).toUpperCase();
  const call = await rpc('readonly', 'tools/call', { name: 'run_worker', arguments: { worker: 'deepseek', task: `Reply with exactly: ${marker}` } }, init.session, 5);
  const text = call.body?.result?.content?.[0]?.text ?? '';
  let envelope;
  try { envelope = JSON.parse(text); } catch { /* keep raw */ }
  // The run_worker envelope nests the provider result: data.result.{answer,taskId,usage}.
  const payload = envelope?.data?.result ?? envelope?.data ?? {};
  taskId = payload.taskId ?? envelope?.taskId;
  const answer = String(payload.answer ?? '').trim();
  answer === marker && (payload.status ?? envelope?.status) === 'completed'
    ? ok(`run_worker(deepseek) -> ${answer} taskId=${taskId} usage=${JSON.stringify(payload.usage ?? envelope?.usage)}`)
    : bad(`run_worker(deepseek) answer=${JSON.stringify(answer)} envelope=${text.slice(0, 160)}`);
  if (taskId) {
    // Either instance may be behind the relay, so look in both stores and say which one answered.
    let found;
    for (const file of ['broker-agent.sqlite', 'broker.sqlite']) {
      const db = new DatabaseSync(join(homedir(), 'projects/multimodel-broker/data', file), { readOnly: true });
      const row = db.prepare('SELECT id, kind, status, result_json, trace_id FROM tasks WHERE id = ?').get(taskId);
      const run = row ? db.prepare('SELECT provider, model, status, usage_json FROM runs WHERE task_id = ?').get(taskId) : undefined;
      db.close();
      if (row) { found = { file, row, run, storedAnswer: String(row.result_json ?? '').includes(marker) }; break; }
    }
    found?.row.status === 'completed' && found.storedAnswer && found.run?.provider === 'deepseek'
      ? ok(`SQLite (${found.file}) corroborates ${taskId}: kind=${found.row.kind} status=${found.row.status} provider=${found.run.provider}/${found.run.model} usage=${found.run.usage_json} trace=${found.row.trace_id}`)
      : bad(`SQLite row for ${taskId}: ${JSON.stringify(found ? { file: found.file, status: found.row.status, storedAnswer: found.storedAnswer, run: found.run } : 'not found in either store')}`);
  }
} else {
  console.log('  (skipped the DeepSeek call - pass --deepseek to spend one cheap provider call)');
}

head('agent channel (write-capable tool must be visible, never executed here)');
const ainit = await rpc('agent', 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'relay-public-check', version: '1' } });
ainit.status === 200 && ainit.body?.result?.serverInfo ? ok(`initialize HTTP ${ainit.status}`) : bad(`initialize HTTP ${ainit.status}`);
await rpc('agent', 'notifications/initialized', undefined, ainit.session, undefined);
const atools = await rpc('agent', 'tools/list', {}, ainit.session, 2);
const anames = atools.body?.result?.tools?.map((t) => t.name) ?? [];
const entry = atools.body?.result?.tools?.find((t) => t.name === 'run_agent');
anames.length >= 7 && entry ? ok(`tools/list = ${anames.length} tools incl. run_agent`) : bad(`agent tools/list = ${anames.length}: ${anames.join(', ')}`);
entry?.annotations?.readOnlyHint === false && entry?.annotations?.destructiveHint === true
  ? ok(`run_agent annotations are honest: readOnlyHint=false destructiveHint=true`)
  : bad(`run_agent annotations: ${JSON.stringify(entry?.annotations)}`);
console.log('  (run_agent NOT called - a real write needs explicit authorisation)');

head('cleanup');
for (const [channel, session] of [['readonly', init.session], ['agent', ainit.session]]) {
  if (!session) continue;
  const del = await fetch(url(channel), { method: 'DELETE', headers: { 'mcp-session-id': session, 'mcp-protocol-version': '2025-11-25', 'user-agent': 'relay-public-check/1.0' } });
  ok(`${channel} session DELETE HTTP ${del.status}`);
}

console.log(`\nresult: ${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
