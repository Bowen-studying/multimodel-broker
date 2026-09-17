export const REQUEST_TIMEOUT_MS = 60000;
export const MAX_BASE64 = 65536;
export type Channel = 'readonly' | 'agent';
export type Frame = {
    t: 'hello';
    deviceId: string;
    channels: {
        name: Channel;
        target: string;
    }[];
    protocol: 1;
} | {
    t: 'hello.ok';
    deviceId: string;
    protocol: 1;
} | {
    t: 'heartbeat' | 'heartbeat.ok';
    at: string;
} | {
    t: 'req';
    requestId: string;
    channel: Channel;
    deadlineMs: number;
    request: {
        method: string;
        path: string;
        headers: Record<string, string>;
        bodyBase64?: string;
    };
} | {
    t: 'res.start';
    requestId: string;
    status: number;
    headers: Record<string, string>;
} | {
    t: 'res.chunk';
    requestId: string;
    seq: number;
    bodyBase64: string;
    last: false;
} | {
    t: 'res.end';
    requestId: string;
} | {
    t: 'req.error';
    requestId: string;
    code: string;
    message: string;
} | {
    t: 'outcome_unknown';
    requestId: string;
    reason: string;
};
function object(v: unknown): v is Record<string, unknown> { return !!v && typeof v === 'object' && !Array.isArray(v); }
function str(v: unknown): v is string { return typeof v === 'string' && v.length > 0; }
function headers(v: unknown): boolean { return object(v) && Object.values(v).every(x => typeof x === 'string'); }
function b64(v: unknown): boolean { return typeof v === 'string' && v.length <= MAX_BASE64 && v.length % 4 === 0 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(v); }
export function decode(text: string): Frame {
    const f: unknown = JSON.parse(text);
    if (!object(f))
        throw new Error('invalid frame');
    let valid = false;
    switch (f.t) {
        case 'hello':
            valid = str(f.deviceId) && f.protocol === 1 && Array.isArray(f.channels) && f.channels.length > 0 && f.channels.length <= 2 && new Set(f.channels.map(c => c.name)).size === f.channels.length && f.channels.every(c => object(c) && ['readonly', 'agent'].includes(String(c.name)) && str(c.target) && Object.keys(c).every(k => ['name', 'target'].includes(k)));
            break;
        case 'hello.ok':
            valid = str(f.deviceId) && f.protocol === 1;
            break;
        case 'heartbeat':
        case 'heartbeat.ok':
            valid = str(f.at) && Number.isFinite(Date.parse(f.at));
            break;
        case 'req':
            valid = str(f.requestId) && ['readonly', 'agent'].includes(String(f.channel)) && Number.isInteger(f.deadlineMs) && Number(f.deadlineMs) > 0 && Number(f.deadlineMs) <= REQUEST_TIMEOUT_MS && object(f.request) && str(f.request.method) && f.request.path === '/mcp' && headers(f.request.headers) && (f.request.bodyBase64 === undefined || b64(f.request.bodyBase64));
            break;
        case 'res.start':
            valid = str(f.requestId) && Number.isInteger(f.status) && Number(f.status) >= 200 && Number(f.status) <= 599 && headers(f.headers);
            break;
        case 'res.chunk':
            valid = str(f.requestId) && Number.isInteger(f.seq) && Number(f.seq) >= 0 && b64(f.bodyBase64) && f.last === false;
            break;
        case 'res.end':
            valid = str(f.requestId);
            break;
        case 'req.error':
            valid = str(f.requestId) && str(f.code) && str(f.message);
            break;
        case 'outcome_unknown':
            valid = str(f.requestId) && str(f.reason);
            break;
    }
    const keys: Record<string, string[]> = { hello: ['deviceId', 'channels', 'protocol'], 'hello.ok': ['deviceId', 'protocol'], heartbeat: ['at'], 'heartbeat.ok': ['at'], req: ['requestId', 'channel', 'deadlineMs', 'request'], 'res.start': ['requestId', 'status', 'headers'], 'res.chunk': ['requestId', 'seq', 'bodyBase64', 'last'], 'res.end': ['requestId'], 'req.error': ['requestId', 'code', 'message'], outcome_unknown: ['requestId', 'reason'] };
    if (!valid || !Object.keys(f).every(k => k === 't' || keys[String(f.t)]?.includes(k)))
        throw new Error('invalid frame');
    return f as Frame;
}
export function encode(frame: Frame): string { const text = JSON.stringify(frame); decode(text); return text; }
