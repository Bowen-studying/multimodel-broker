import { RelayConnection, type Delivery } from './connection.js';
import { readPrivate, type Registration } from './registration.js';
import { type Frame, type Channel } from './protocol.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
export const DEFAULT_TARGETS: Record<Channel, string> = { readonly: 'http://127.0.0.1:8789/mcp', agent: 'http://127.0.0.1:8790/mcp' };
/**
 * Which loopback instance a channel talks to is a local decision, and it is overridable so that one
 * public URL can be pointed at the agent instance (write-capable) without touching the relay, the
 * Worker or any token. Defaults keep the read/write split.
 */
export function resolveTargets(overrides: Partial<Record<Channel, string>> = {}): Record<Channel, string> {
    const targets = { ...DEFAULT_TARGETS, ...overrides };
    for (const value of Object.values(targets)) {
        const u = new URL(value);
        if (u.protocol !== 'http:' || u.hostname !== '127.0.0.1' || u.pathname !== '/mcp' || u.username || u.password || u.search)
            throw new Error('Local target must be loopback /mcp');
    }
    return targets;
}
export async function startClient(registration: Registration, options: {
    readonlyTokenFile?: string;
    agentTokenFile?: string;
    targets?: Partial<Record<Channel, string>>;
    log?: (s: string) => void;
} = {}): Promise<RelayConnection> {
    const targets = resolveTargets(options.targets);
    const tokens = { readonly: await readPrivate(options.readonlyTokenFile ?? join(homedir(), '.broker-m1-token')), agent: await readPrivate(options.agentTokenFile ?? join(homedir(), '.broker-agent-token')) };
    // Timestamps make connect/disconnect/forward interleaving readable: without them a flapping
    // connection is impossible to correlate with the requests that failed.
    const log = options.log ?? ((s: string) => console.log(`${new Date().toISOString()} ${s}`));
    const forward = async (f: Extract<Frame, {
        t: 'req';
    }>, delivery: Delivery, send: (f: Frame) => boolean): Promise<void> => {
        const timeout = setTimeout(() => delivery.abort.abort(new Error('timeout')), f.deadlineMs);
        try {
            const headers = new Headers(f.request.headers);
            for (const key of ['host', 'connection', 'content-length', 'authorization', 'cookie', 'proxy-authorization'])
                headers.delete(key);
            headers.set('authorization', `Bearer ${tokens[f.channel]}`);
            if (delivery.abort.signal.aborted)
                return;
            delivery.delivered = true;
            const startedAt = Date.now();
            const response = await fetch(targets[f.channel], { method: f.request.method, headers, ...(f.request.bodyBase64 ? { body: Buffer.from(f.request.bodyBase64, 'base64') } : {}), signal: delivery.abort.signal, redirect: 'manual' });
            // Log every forwarded request: this line is the proof that traffic traversed the relay
            // (the broker only sees 127.0.0.1 from both hops, so it cannot tell the two apart).
            log(`forward ${f.request.method} ${f.channel} -> ${response.status} ${Date.now() - startedAt}ms requestId=${f.requestId.slice(0, 8)}`);
            const responseHeaders: Record<string, string> = {};
            response.headers.forEach((v, k) => { if (!['content-length', 'transfer-encoding', 'connection', 'content-encoding'].includes(k))
                responseHeaders[k] = v; });
            if (!send({ t: 'res.start', requestId: f.requestId, status: response.status, headers: responseHeaders }))
                return;
            let seq = 0;
            const reader = response.body?.getReader();
            if (reader) {
                try {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done)
                            break;
                        for (let i = 0; i < value.length; i += 49152) {
                            if (!send({ t: 'res.chunk', requestId: f.requestId, seq: seq++, bodyBase64: Buffer.from(value.subarray(i, i + 49152)).toString('base64'), last: false }))
                                return;
                        }
                    }
                }
                finally {
                    await reader.cancel().catch(() => { });
                }
            }
            send({ t: 'res.end', requestId: f.requestId });
        }
        catch {
            const code = delivery.abort.signal.aborted ? 'timeout' : 'local_unreachable';
            log(`forward ${f.request.method} ${f.channel} -> ${code} requestId=${f.requestId.slice(0, 8)}`);
            send({ t: 'req.error', requestId: f.requestId, code, message: code === 'timeout' ? 'Local request deadline exceeded' : 'Local endpoint unavailable' });
        }
        finally {
            clearTimeout(timeout);
        }
    };
    const client = new RelayConnection(registration, (['readonly', 'agent'] as const).map(name => ({ name, target: targets[name] })), forward, log);
    client.start();
    return client;
}
