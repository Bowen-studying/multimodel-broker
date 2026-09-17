import { decode, encode, REQUEST_TIMEOUT_MS, type Frame, type Channel } from './protocol';
type Pending = {
    resolve: (r: Response) => void;
    controller?: ReadableStreamDefaultController<Uint8Array>;
    timer: ReturnType<typeof setTimeout>;
    seq: number;
};
export class Device {
    private socket?: WebSocket;
    private deviceId = '';
    private channels: Channel[] = [];
    private heartbeat: number | null = null;
    private pending = new Map<string, Pending>();
    constructor(private state: DurableObjectState) { }
    private online(): boolean { return !!this.socket && this.channels.length > 0 && this.heartbeat !== null && Date.now() - this.heartbeat < 60000; }
    private fail(id: string, status: number, code: string): void {
        const p = this.pending.get(id);
        if (!p)
            return;
        clearTimeout(p.timer);
        this.pending.delete(id);
        if (p.controller)
            p.controller.error(new Error(code));
        else
            p.resolve(Response.json({ error: code }, { status }));
    }
    private disconnect(socket: WebSocket): void {
        if (socket !== this.socket)
            return;
        this.socket = undefined;
        this.channels = [];
        for (const id of this.pending.keys())
            this.fail(id, 502, 'outcome_unknown');
    }
    async alarm(): Promise<void> { if (!this.online() && this.socket) {
        const ws = this.socket;
        this.disconnect(ws);
        ws.close(4000, 'heartbeat timeout');
    } }
    private message(socket: WebSocket, data: unknown): void {
        if (socket !== this.socket)
            return;
        try {
            if (typeof data !== 'string')
                throw new Error('text required');
            const f = decode(data);
            if (f.t === 'hello') {
                if (f.deviceId !== this.deviceId || this.channels.length)
                    throw new Error('invalid hello');
                this.channels = f.channels.map(c => c.name);
                this.heartbeat = Date.now();
                this.state.waitUntil(this.state.storage.setAlarm(Date.now() + 60000));
                socket.send(encode({ t: 'hello.ok', deviceId: this.deviceId, protocol: 1 }));
                return;
            }
            if (!this.channels.length)
                throw new Error('hello required');
            if (f.t === 'heartbeat') {
                this.heartbeat = Date.now();
                this.state.waitUntil(this.state.storage.setAlarm(Date.now() + 60000));
                socket.send(encode({ t: 'heartbeat.ok', at: f.at }));
                return;
            }
            if (!('requestId' in f))
                throw new Error('unexpected frame');
            const p = this.pending.get(f.requestId);
            if (!p)
                return;
            if (f.t === 'res.start') {
                if (p.controller)
                    throw new Error('duplicate start');
                const stream = new ReadableStream<Uint8Array>({ start: c => { p.controller = c; }, cancel: () => { clearTimeout(p.timer); this.pending.delete(f.requestId); } });
                const headers = new Headers(f.headers);
                for (const h of ['content-length', 'transfer-encoding', 'connection', 'content-encoding'])
                    headers.delete(h);
                p.resolve(new Response([204, 205, 304].includes(f.status) ? null : stream, { status: f.status, headers }));
            }
            else if (f.t === 'res.chunk') {
                if (!p.controller || f.seq !== p.seq++)
                    throw new Error('invalid chunk sequence');
                p.controller.enqueue(Uint8Array.from(atob(f.bodyBase64), c => c.charCodeAt(0)));
            }
            else if (f.t === 'res.end') {
                if (!p.controller)
                    throw new Error('missing start');
                p.controller.close();
                clearTimeout(p.timer);
                this.pending.delete(f.requestId);
            }
            else if (f.t === 'req.error')
                this.fail(f.requestId, f.code === 'timeout' ? 504 : 502, f.code);
            else if (f.t === 'outcome_unknown')
                this.fail(f.requestId, 502, 'outcome_unknown');
            else
                throw new Error('unexpected frame');
        }
        catch {
            this.disconnect(socket);
            socket.close(1008, 'invalid frame');
        }
    }
    async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);
        this.deviceId = url.searchParams.get('deviceId')!;
        if (url.pathname === '/status')
            return Response.json({ deviceId: this.deviceId, online: this.online(), channels: this.online() ? this.channels : [], lastHeartbeatAt: this.heartbeat === null ? null : new Date(this.heartbeat).toISOString() });
        if (url.pathname === '/agent') {
            if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket')
                return Response.json({ error: 'websocket upgrade required' }, { status: 426 });
            if (this.online())
                return Response.json({ error: 'device already connected' }, { status: 409 });
            if (this.socket) {
                const old = this.socket;
                this.disconnect(old);
                old.close(4000, 'replaced');
            }
            const pair = new WebSocketPair();
            const client = pair[0], server = pair[1];
            server.accept();
            this.socket = server;
            this.channels = [];
            this.heartbeat = null;
            server.addEventListener('message', event => this.message(server, event.data));
            server.addEventListener('close', () => { this.disconnect(server); try {
                server.close();
            }
            catch { } });
            server.addEventListener('error', () => this.disconnect(server));
            await this.state.storage.setAlarm(Date.now() + 60000);
            const protocol = request.headers.get('sec-websocket-protocol');
            return new Response(null, { status: 101, webSocket: client, headers: protocol ? { 'sec-websocket-protocol': protocol } : {} });
        }
        if (!this.online())
            return Response.json({ error: 'notDelivered: device offline' }, { status: 503 });
        const channel = url.searchParams.get('channel') as Channel;
        if (!this.channels.includes(channel))
            return Response.json({ error: 'notDelivered: channel unavailable' }, { status: 503 });
        const bytes = new Uint8Array(await request.arrayBuffer());
        if (bytes.length > 49152)
            return Response.json({ error: 'request body too large' }, { status: 413 });
        const requestId = crypto.randomUUID();
        const headers: Record<string, string> = {};
        request.headers.forEach((v, k) => { if (!['authorization', 'host', 'connection', 'content-length', 'upgrade', 'sec-websocket-protocol'].includes(k))
            headers[k] = v; });
        const frame: Frame = { t: 'req', requestId, channel, deadlineMs: REQUEST_TIMEOUT_MS, request: { method: request.method, path: '/mcp', headers, ...(bytes.length ? { bodyBase64: btoa(String.fromCharCode(...bytes)) } : {}) } };
        return new Promise<Response>(resolve => {
            const timer = setTimeout(() => this.fail(requestId, 504, 'timeout'), REQUEST_TIMEOUT_MS);
            this.pending.set(requestId, { resolve, timer, seq: 0 });
            try {
                this.socket!.send(encode(frame));
            }
            catch {
                this.fail(requestId, 503, 'notDelivered');
            }
        });
    }
}
