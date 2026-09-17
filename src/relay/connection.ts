import { decode, encode, type Frame, type Channel } from './protocol.js';
import type { Registration } from './registration.js';
export interface Delivery {
    delivered: boolean;
    abort: AbortController;
}
export class RelayConnection {
    private socket?: WebSocket;
    private stopped = false;
    private retry?: ReturnType<typeof setTimeout>;
    private heartbeat?: ReturnType<typeof setInterval>;
    private ack = 0;
    private attempts = 0;
    private connected = false;
    private unknown: Frame[] = [];
    /** Guards close() against being re-entered from a transport event while already closing. */
    private closing = false;
    readonly pending = new Map<string, Delivery>();
    constructor(private registration: Registration, private channels: {
        name: Channel;
        target: string;
    }[], private forward: (frame: Extract<Frame, {
        t: 'req';
    }>, delivery: Delivery, send: (f: Frame) => boolean) => Promise<void>, private log: (s: string) => void = console.log) { }
    start(): void {
        this.stopped = false;
        const u = new URL(`/agent/${this.registration.deviceId}`, this.registration.url);
        u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
        const socket = new WebSocket(u, `broker-relay.${this.registration.agentConnectionToken}`);
        this.socket = socket;
        const send = (f: Frame): boolean => { if (this.socket !== socket || socket.readyState !== WebSocket.OPEN)
            return false; try {
            socket.send(encode(f));
            return true;
        }
        catch {
            return false;
        } };
        socket.addEventListener('open', () => {
            if (this.stopped || this.socket !== socket) {
                this.safeClose(socket);
                return;
            }
            this.ack = Date.now();
            send({ t: 'hello', deviceId: this.registration.deviceId, channels: this.channels, protocol: 1 });
            this.heartbeat = setInterval(() => { const missed = Math.floor((Date.now() - this.ack) / 20000); if (missed >= 2)
                this.log(`heartbeat missed=${missed}`); if (missed >= 3) {
                this.safeClose(socket, 4000, 'heartbeat timeout');
                return;
            } send({ t: 'heartbeat', at: new Date().toISOString() }); }, 20000);
        });
        socket.addEventListener('message', event => {
            if (this.socket !== socket || this.stopped) return;
            try {
                if (typeof event.data !== 'string')
                    throw new Error('text required');
                const frame = decode(event.data);
                if (frame.t === 'hello.ok') {
                    if (frame.deviceId !== this.registration.deviceId)
                        throw new Error('wrong device');
                    this.log(`${this.connected ? 'reconnected' : 'connected'} channels=${this.channels.map(c => c.name).join(',')}`);
                    this.connected = true;
                    this.attempts = 0;
                    this.unknown = this.unknown.filter(f => !send(f));
                }
                else if (frame.t === 'heartbeat.ok')
                    this.ack = Date.now();
                else if (frame.t === 'req') {
                    if (this.pending.has(frame.requestId))
                        return;
                    const delivery = { delivered: false, abort: new AbortController() };
                    this.pending.set(frame.requestId, delivery);
                    let finished = false;
                    const reply = (f: Frame): boolean => {
                        const sent = send(f);
                        if (sent && (f.t === 'res.end' || f.t === 'req.error')) finished = true;
                        return sent;
                    };
                    void this.forward(frame, delivery, reply).catch(() => {
                        reply({t:'req.error',requestId:frame.requestId,code:'local_unreachable',message:'Local endpoint unavailable'});
                    }).finally(() => {
                        if (this.pending.get(frame.requestId) !== delivery) return;
                        // A failed send can finish before the close event is delivered.
                        if (!finished) this.unknown.push(delivery.delivered
                            ? {t:'outcome_unknown',requestId:frame.requestId,reason:'connection lost after delivery'}
                            : {t:'req.error',requestId:frame.requestId,code:'notDelivered',message:'connection lost before delivery'});
                        this.pending.delete(frame.requestId);
                    });
                }
                else
                    throw new Error('unexpected frame');
            }
            catch {
                this.safeClose(socket, 1008, 'invalid frame');
            }
        });
        socket.addEventListener('error', () => {
            // Do NOT close() here. undici re-emits 'error' from close(), so an error handler that
            // closes recursed until the stack blew up (RangeError: Maximum call stack size exceeded)
            // and the relay crash-looped, showing 503 to the public entry. Treat it as lost instead;
            // the transport tears itself down and the 'close' event follows.
            this.onClosed(socket);
        });
        socket.addEventListener('close', () => this.onClosed(socket));
    }
    /**
     * Bookkeeping for a lost socket: flush the delivery state so the upper layer can reconcile
     * (never replay a request), then schedule the reconnect. Idempotent: only the current socket
     * is processed.
     */
    private onClosed(socket: WebSocket): void {
        if (this.socket !== socket)
            return;
        clearInterval(this.heartbeat);
        this.socket = undefined;
        for (const [requestId, p] of this.pending) {
            this.unknown.push(p.delivered ? { t: 'outcome_unknown', requestId, reason: 'connection lost after delivery' } : { t: 'req.error', requestId, code: 'notDelivered', message: 'connection lost before delivery' });
            p.abort.abort();
        }
        this.pending.clear();
        if (!this.stopped)
            this.retry = setTimeout(() => this.start(), Math.min(10000, 250 * 2 ** Math.min(this.attempts++, 6)));
    }
    /**
     * undici's WebSocket re-throws the underlying connection error when close() is called on a
     * socket that already failed. Doing that from inside an event listener kills the process (the
     * relay then shows up as 503 to the public entry until systemd restarts it), so a failed close
     * is treated as "socket lost" instead of an error.
     */
    private safeClose(socket: WebSocket, code?: number, reason?: string): void {
        if (this.closing)
            return;
        this.closing = true;
        try {
            if (code === undefined)
                socket.close();
            else
                socket.close(code, reason);
        }
        catch (error) {
            this.log(`close ignored (${(error as Error).message}); treating as lost`);
            this.onClosed(socket);
        }
        finally {
            this.closing = false;
        }
    }
    disconnect(): void { if (this.socket)
        this.safeClose(this.socket, 4000, 'connection test'); }
    stop(): void { this.stopped = true; clearTimeout(this.retry); clearInterval(this.heartbeat); if (this.socket)
        this.safeClose(this.socket, 1000, 'stopped'); }
}
