import { describe, it, expect } from 'vitest';
import { readFile, mkdtemp, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decode, encode, MAX_BASE64 } from '../../src/relay/protocol.js';
import { readPrivate, describeUrls, relayUrl } from '../../src/relay/registration.js';
import { resolveTargets } from '../../src/relay/client.js';
describe('relay protocol and credential safety', () => {
    it('parses shared Worker fixtures with exact fields', async () => {
        const fixtures = JSON.parse(await readFile(new URL('../../relay/fixtures/frames.json', import.meta.url), 'utf8'));
        expect(fixtures.map((f: {
            t: string;
        }) => f.t)).toEqual(['hello', 'hello.ok', 'heartbeat', 'heartbeat.ok', 'req', 'res.start', 'res.chunk', 'res.end', 'req.error', 'outcome_unknown']);
        for (const frame of fixtures)
            expect(decode(encode(frame))).toEqual(frame);
        expect(fixtures.find((f: {
            t: string;
        }) => f.t === 'req').deadlineMs).toBe(60000);
    });
    it('rejects malformed base64, oversized chunks, unknown channels and metadata', () => {
        const chunk = { t: 'res.chunk', requestId: 'fake-request', seq: 0, bodyBase64: 'e30=', last: false };
        for (const patch of [{ seq: -1 }, { bodyBase64: '!bad' }, { bodyBase64: 'a'.repeat(MAX_BASE64 + 4) }, { last: true }, { unexpected: true }])
            expect(() => decode(JSON.stringify({ ...chunk, ...patch }))).toThrow();
        expect(() => decode(JSON.stringify({ t: 'hello', deviceId: 'fake', protocol: 1, channels: [{ name: 'other', target: 'http://127.0.0.1/mcp' }] }))).toThrow();
    });
    it('reads mode 600 only and never prints public secrets', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'relay-test-'));
        try {
            const path = join(dir, 'fake-token');
            await writeFile(path, 'fake-local-token', { mode: 0o600 });
            expect(await readPrivate(path)).toBe('fake-local-token');
            expect((await stat(path)).mode & 0o777).toBe(0o600);
            await writeFile(join(dir, 'unsafe'), 'fake', { mode: 0o644 });
            await expect(readPrivate(join(dir, 'unsafe'))).rejects.toThrow('600');
        }
        finally {
            await rm(dir, { recursive: true });
        }
        const text = describeUrls({ url: 'https://example.test', deviceId: 'fake-device', agentConnectionToken: 'fake-connection', readonlyMcpToken: 'fake-readonly-secret', agentMcpToken: 'fake-agent-secret' });
        expect(text).not.toContain('fake-readonly-secret');
        expect(text).not.toContain('fake-agent-secret');
        expect(text).toContain('sha256=');
        expect(() => relayUrl('http://example.test')).toThrow();
        expect(relayUrl('http://127.0.0.1:8799')).toBe('http://127.0.0.1:8799');
    });
});
describe('channel routing is a local decision', () => {
    it('defaults to the read/write split and allows a per-channel override', () => {
        expect(resolveTargets()).toEqual({ readonly: 'http://127.0.0.1:8789/mcp', agent: 'http://127.0.0.1:8790/mcp' });
        expect(resolveTargets({ readonly: 'http://127.0.0.1:8790/mcp' })).toEqual({ readonly: 'http://127.0.0.1:8790/mcp', agent: 'http://127.0.0.1:8790/mcp' });
        expect(resolveTargets({ agent: 'http://127.0.0.1:8789/mcp' }).agent).toBe('http://127.0.0.1:8789/mcp');
    });
    it('refuses anything that is not a loopback /mcp endpoint', () => {
        expect(() => resolveTargets({ readonly: 'http://127.0.0.1:8790/' })).toThrow();
        expect(() => resolveTargets({ readonly: 'https://127.0.0.1:8790/mcp' })).toThrow();
        expect(() => resolveTargets({ readonly: 'http://10.0.0.5:8790/mcp' })).toThrow();
        expect(() => resolveTargets({ readonly: 'http://127.0.0.1:8790/mcp?token=x' })).toThrow();
    });
});
