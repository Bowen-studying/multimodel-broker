import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fixtures from '../fixtures/frames.json';
import { decode, encode } from '../src/protocol';
import type { Env } from '../src/worker';
import type { Device } from '../src/device';
import type { Registry, RecordData } from '../src/registry';
import { hash } from '../src/tokens';
const bindings = env as Env;
const id = 'test-device', secret = 'fake-connection-token', readonly = 'fake-readonly-token';
async function seed() {
    const stub = bindings.REGISTRY_DO.get(bindings.REGISTRY_DO.idFromName('registry'));
    await runInDurableObject(stub, async (_instance: Registry, state) => { await state.storage.put(id, { agentConnectionTokenHash: await hash(secret), readonlyMcpTokenHash: await hash(readonly), agentMcpTokenHash: await hash('fake-agent-token'), createdAt: new Date().toISOString(), lastSeenAt: null }); });
}
const auth = { authorization: `Bearer ${secret}` };
async function status() { return (await SELF.fetch(`https://relay/status/${id}`, { headers: auth })).json() as Promise<{
    online: boolean;
    channels: string[];
    lastHeartbeatAt: string | null;
}>; }
function next(ws: WebSocket): Promise<ReturnType<typeof decode>> { return new Promise(resolve => ws.addEventListener('message', e => resolve(decode(e.data as string)), { once: true })); }
async function connect() { const r = await SELF.fetch(`https://relay/agent/${id}`, { headers: { ...auth, upgrade: 'websocket' } }); expect(r.status).toBe(101); const ws = r.webSocket!; ws.accept(); const reply = next(ws); ws.send(encode({ ...decode(JSON.stringify(fixtures[0])), deviceId: id } as Parameters<typeof encode>[0])); expect((await reply).t).toBe('hello.ok'); return ws; }
describe('real Worker transport', () => {
    beforeEach(async () => { const stub = bindings.REGISTRY_DO.get(bindings.REGISTRY_DO.idFromName('registry')); await runInDurableObject(stub, async (_instance: Registry, state) => { await state.storage.deleteAll(); }); });
    it('parses every shared fixture and rejects invalid fields', () => { for (const f of fixtures)
        expect(decode(encode(f as Parameters<typeof encode>[0]))).toEqual(f); expect(() => decode('{"t":"res.chunk","requestId":"x","seq":-1,"bodyBase64":"e30=","last":false}')).toThrow(); expect(() => decode(JSON.stringify({ ...fixtures[0], extra: 'disallowed' }))).toThrow(); });
    it('registers new devices and persists hashes only', async () => {
        const a = await SELF.fetch('https://relay/register', { method: 'POST' }), b = await SELF.fetch('https://relay/register', { method: 'POST' });
        expect(a.status).toBe(201);
        expect(b.status).toBe(201);
        const x = await a.json() as Record<string, string>, y = await b.json() as Record<string, string>;
        expect(x.deviceId).not.toBe(y.deviceId);
        for (const key of ['agentConnectionToken', 'readonlyMcpToken', 'agentMcpToken'])
            expect(x[key].length).toBeGreaterThanOrEqual(43);
        const stub = bindings.REGISTRY_DO.get(bindings.REGISTRY_DO.idFromName('registry'));
        await runInDurableObject(stub, async (_instance: Registry, state) => { const record = await state.storage.get<RecordData>(x.deviceId); expect(Object.keys(record!).sort()).toEqual(['agentConnectionTokenHash', 'readonlyMcpTokenHash', 'agentMcpTokenHash', 'createdAt', 'lastSeenAt'].sort()); expect(record!.agentConnectionTokenHash).toBe(await hash(x.agentConnectionToken)); });
        const health = await (await SELF.fetch('https://relay/healthz')).json();
        expect(health).toEqual({ ok: true, service: 'multimodel-broker-relay', version: '0.1.0', devices: 2 });
    });
    it('caps registration at 100', async () => {
        const stub = bindings.REGISTRY_DO.get(bindings.REGISTRY_DO.idFromName('registry'));
        await runInDurableObject(stub, async (_instance: Registry, state) => { for (let n = 0; n < 100; n++)
            await state.storage.put(`fake-${n}`, {}); });
        const response = await SELF.fetch('https://relay/register', { method: 'POST' });
        expect(response.status).toBe(429);
        expect(await response.text()).toContain('100');
    });
    it('rejects missing, wrong and cross-channel credentials', async () => { await seed(); for (const path of [`status/${id}`, `agent/${id}`, `mcp/${id}/readonly/fake-agent-token`])
        expect((await SELF.fetch(`https://relay/${path}`, { headers: { authorization: 'Bearer wrong' } })).status).toBe(401); expect((await SELF.fetch(`https://relay/status/${id}`)).status).toBe(401); });
    it('upgrades, acknowledges hello and heartbeat, reports online then offline', async () => {
        await seed();
        expect((await status()).online).toBe(false);
        const ws = await connect();
        expect((await status()).channels).toEqual(['readonly', 'agent']);
        const heartbeat = next(ws);
        ws.send(encode({ t: 'heartbeat', at: '2026-09-17T00:00:00.000Z' }));
        expect(await heartbeat).toEqual({ t: 'heartbeat.ok', at: '2026-09-17T00:00:00.000Z' });
        expect((await status()).online).toBe(true);
        ws.close();
        for (let i = 0; i < 30 && (await status()).online; i++)
            await new Promise(r => setTimeout(r, 10));
        expect((await status()).online).toBe(false);
    });
    it('expires heartbeat and permits takeover', async () => {
        await seed();
        const ws = await connect();
        const stub = bindings.RELAY_DO.get(bindings.RELAY_DO.idFromName(id));
        await runInDurableObject(stub, async (instance: Device) => { (instance as unknown as {
            heartbeat: number;
        }).heartbeat = Date.now() - 60001; await instance.alarm(); });
        expect((await status()).online).toBe(false);
        ws.close();
        const replacement = await connect();
        replacement.close();
    });
    it('times out pending requests with HTTP 504 without replay', async () => {
        await seed();
        const ws = await connect();
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        try {
            const incoming = next(ws);
            const response = SELF.fetch(`https://relay/mcp/${id}/readonly/${readonly}`, { method: 'POST', body: '{}' });
            await incoming;
            await runInDurableObject(bindings.RELAY_DO.get(bindings.RELAY_DO.idFromName(id)), async () => { await vi.advanceTimersByTimeAsync(60000); });
            expect((await response).status).toBe(504);
        }
        finally {
            vi.useRealTimers();
            ws.close();
        }
    });
    it('streams multiplexed public requests and reports unknown outcomes', async () => {
        await seed();
        const ws = await connect();
        const incoming = next(ws);
        const response = SELF.fetch(`https://relay/mcp/${id}/readonly/${readonly}`, { method: 'POST', body: '{}' });
        const req = await incoming;
        expect(req.t).toBe('req');
        if (req.t !== 'req')
            throw new Error('request required');
        expect(req.deadlineMs).toBe(60000);
        ws.send(encode({ t: 'res.start', requestId: req.requestId, status: 200, headers: { 'content-type': 'text/event-stream' } }));
        ws.send(encode({ t: 'res.chunk', requestId: req.requestId, seq: 0, bodyBase64: btoa('data: one\n\n'), last: false }));
        const r = await response;
        const reader = r.body!.getReader();
        expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: one\n\n');
        ws.send(encode({ t: 'res.chunk', requestId: req.requestId, seq: 1, bodyBase64: btoa('data: two\n\n'), last: false }));
        ws.send(encode({ t: 'res.end', requestId: req.requestId }));
        expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: two\n\n');
        expect((await reader.read()).done).toBe(true);
        const incoming2 = next(ws);
        const unknown = SELF.fetch(`https://relay/mcp/${id}/readonly/${readonly}`, { method: 'POST', body: '{}' });
        await incoming2;
        ws.close();
        expect((await unknown).status).toBe(502);
    });
});
