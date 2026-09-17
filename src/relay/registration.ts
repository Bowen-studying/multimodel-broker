import { open, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
export interface Registration {
    url: string;
    name?: string;
    deviceId: string;
    agentConnectionToken: string;
    readonlyMcpToken: string;
    agentMcpToken: string;
}
export const DEVICE_FILE = join(homedir(), '.broker-relay-device.json');
export function relayUrl(raw: string): string {
    const u = new URL(raw);
    if (u.username || u.password || u.search || u.hash || u.pathname !== '/' || !['https:', 'http:'].includes(u.protocol))
        throw new Error('Invalid relay origin');
    if (u.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname))
        throw new Error('HTTPS required outside loopback');
    return u.origin;
}
export async function readPrivate(path: string): Promise<string> {
    const f = await open(path, 'r');
    try {
        const stat = await f.stat();
        if ((stat.mode & 0o777) !== 0o600 || !stat.isFile())
            throw new Error('Credential file must have mode 600');
        return (await f.readFile('utf8')).trim();
    }
    finally {
        await f.close();
    }
}
export async function readRegistration(path = DEVICE_FILE): Promise<Registration> {
    const r = JSON.parse(await readPrivate(path)) as Registration;
    if (!r.deviceId || ![r.agentConnectionToken, r.readonlyMcpToken, r.agentMcpToken].every(x => typeof x === 'string' && /^[A-Za-z0-9_-]{43,}$/.test(x)))
        throw new Error('Invalid device credentials');
    relayUrl(r.url);
    return r;
}
export async function register(raw: string, name?: string, path = DEVICE_FILE): Promise<Registration> {
    const url = relayUrl(raw);
    // Reserve the file first so existing credentials are never overwritten.
    const file = await open(path, 'wx', 0o600);
    let written = false;
    try {
        const response = await fetch(url + '/register', { method: 'POST', redirect: 'error' });
        if (response.status !== 201)
            throw new Error(`Registration failed (${response.status})`);
        const result = await response.json() as Omit<Registration, 'url'>;
        const r = { ...result, url, ...(name ? { name } : {}) };
        await file.writeFile(JSON.stringify(r, null, 2) + '\n');
        await file.sync();
        written = true;
        return r;
    }
    finally {
        await file.close();
        // A failed registration must not leave an empty credential file behind: the 'wx' guard
        // would then reject every later attempt with EEXIST, and the file looks registered.
        if (!written)
            await rm(path, { force: true }).catch(() => { });
    }
}
export function describeUrls(r: Registration): string {
    return (['readonly', 'agent'] as const).map(channel => {
        const token = channel === 'readonly' ? r.readonlyMcpToken : r.agentMcpToken;
        const url = `${r.url}/mcp/${r.deviceId}/${channel}/${token}`;
        return `${channel}: ${r.url}/mcp/${r.deviceId}/${channel}/<redacted> URL length=${url.length} sha256=${createHash('sha256').update(url).digest('hex').slice(0, 16)} token length=${token.length}`;
    }).join('\n');
}
