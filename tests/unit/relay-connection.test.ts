import { afterEach, describe, it, expect, vi } from 'vitest';
import { RelayConnection } from '../../src/relay/connection.js';
import { decode, type Frame } from '../../src/relay/protocol.js';
class FakeSocket extends EventTarget {
    static OPEN = 1;
    static sockets: FakeSocket[] = [];
    readyState = 0;
    sent: Frame[] = [];
    constructor(..._args: unknown[]) { super(); FakeSocket.sockets.push(this); }
    send(text: string) { this.sent.push(decode(text)); }
    open() { this.readyState = 1; this.dispatchEvent(new Event('open')); }
    receive(f: Frame) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(f) })); }
    close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
}
const registration = { url: 'http://127.0.0.1:8799', deviceId: 'fake-device', agentConnectionToken: 'fake-connection', readonlyMcpToken: 'fake-readonly', agentMcpToken: 'fake-agent' };
const channels = [{ name: 'readonly' as const, target: 'http://127.0.0.1:8789/mcp' }];
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); FakeSocket.sockets = []; });
describe('relay reconnect delivery safety', () => {
    it('queues only outcome notices after delivered and undelivered requests lose their socket', async () => {
        vi.useFakeTimers();
        vi.stubGlobal('WebSocket', FakeSocket);
        const forward = vi.fn(async (f, delivery) => { delivery.delivered = f.requestId === 'sent'; await new Promise<void>(resolve => delivery.abort.signal.addEventListener('abort', () => resolve())); });
        const client = new RelayConnection(registration, channels, forward, () => { });
        client.start();
        const first = FakeSocket.sockets[0]!;
        first.open();
        expect(first.sent[0]?.t).toBe('hello');
        first.receive({ t: 'hello.ok', deviceId: 'fake-device', protocol: 1 });
        for (const requestId of ['sent', 'unsent'])
            first.receive({ t: 'req', requestId, channel: 'readonly', deadlineMs: 60000, request: { method: 'POST', path: '/mcp', headers: {}, bodyBase64: 'e30=' } });
        first.close();
        await vi.advanceTimersByTimeAsync(250);
        const second = FakeSocket.sockets[1]!;
        second.open();
        second.receive({ t: 'hello.ok', deviceId: 'fake-device', protocol: 1 });
        expect(second.sent).toContainEqual({ t: 'outcome_unknown', requestId: 'sent', reason: 'connection lost after delivery' });
        expect(second.sent).toContainEqual({ t: 'req.error', requestId: 'unsent', code: 'notDelivered', message: 'connection lost before delivery' });
        expect(second.sent.filter(f => f.t === 'req')).toEqual([]);
        expect(forward).toHaveBeenCalledTimes(2);
        expect(client.pending.size).toBe(0);
        client.stop();
    });
    it('reconnects when heartbeat acknowledgements stop', async () => {
        vi.useFakeTimers();
        vi.stubGlobal('WebSocket', FakeSocket);
        const log = vi.fn();
        const client = new RelayConnection(registration, channels, async () => { }, log);
        client.start();
        FakeSocket.sockets[0]!.open();
        await vi.advanceTimersByTimeAsync(60250);
        expect(FakeSocket.sockets).toHaveLength(2);
        expect(log).toHaveBeenCalledWith('heartbeat missed=3');
        client.stop();
    });
});

describe('relay close-event ordering', () => {
    it('retains outcome_unknown when send fails before the close event', async () => {
        vi.useFakeTimers();
        vi.stubGlobal('WebSocket', FakeSocket);
        const client = new RelayConnection(registration, channels, async (frame, delivery, send) => {
            delivery.delivered = true;
            FakeSocket.sockets[0]!.readyState = 2;
            expect(send({t:'res.end',requestId:frame.requestId})).toBe(false);
        }, () => {});
        client.start();
        const first = FakeSocket.sockets[0]!;
        first.open();
        first.receive({t:'req',requestId:'closing-request',channel:'readonly',deadlineMs:60000,request:{method:'POST',path:'/mcp',headers:{}}});
        await vi.advanceTimersByTimeAsync(0);
        expect(client.pending.size).toBe(0);
        first.close();
        await vi.advanceTimersByTimeAsync(250);
        const second = FakeSocket.sockets[1]!;
        second.open();
        second.receive({t:'hello.ok',deviceId:'fake-device',protocol:1});
        expect(second.sent).toContainEqual({t:'outcome_unknown',requestId:'closing-request',reason:'connection lost after delivery'});
        client.stop();
    });
});

describe('relay survives a transport that re-fires error from close', () => {
    // undici's close() re-emits 'error'. An error handler that calls close() therefore recursed
    // until the stack blew up: "RangeError: Maximum call stack size exceeded", relay crash-loop,
    // and the public entry answered 503.
    class MisbehavingSocket extends FakeSocket {
        closes = 0;
        override close() {
            this.closes += 1;
            this.readyState = 3;
            this.dispatchEvent(new Event('error'));
            this.dispatchEvent(new Event('close'));
        }
    }
    it('never closes from the error path, so the recursion cannot start', async () => {
        vi.useFakeTimers();
        vi.stubGlobal('WebSocket', MisbehavingSocket);
        const logs: string[] = [];
        const client = new RelayConnection(registration, channels, async () => { }, (line) => { logs.push(line); });
        client.start();
        const first = MisbehavingSocket.sockets[0]! as MisbehavingSocket;
        first.open();
        expect(() => first.dispatchEvent(new Event('error'))).not.toThrow();
        expect(first.closes).toBe(0);
        await vi.advanceTimersByTimeAsync(500);
        expect(MisbehavingSocket.sockets.length).toBeGreaterThan(1);
    });

    it('treats a throwing close as a lost socket instead of crashing', () => {
        class ThrowingCloseSocket extends FakeSocket {
            override close() { throw new Error('WebSocket is already in CLOSING or CLOSED state'); }
        }
        vi.useFakeTimers();
        vi.stubGlobal('WebSocket', ThrowingCloseSocket);
        const logs: string[] = [];
        const client = new RelayConnection(registration, channels, async () => { }, (line) => { logs.push(line); });
        client.start();
        const first = ThrowingCloseSocket.sockets[0]! as ThrowingCloseSocket;
        first.open();
        expect(() => client.stop()).not.toThrow();
        expect(logs.some((line) => line.includes('close ignored'))).toBe(true);
    });
});
