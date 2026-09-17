import { token, hash, equal } from './tokens';
export interface RecordData {
    agentConnectionTokenHash: string;
    readonlyMcpTokenHash: string;
    agentMcpTokenHash: string;
    createdAt: string;
    lastSeenAt: string | null;
}
export class Registry {
    constructor(private state: DurableObjectState) { }
    async fetch(request: Request): Promise<Response> {
        const p = new URL(request.url).pathname;
        if (p === '/count')
            return Response.json({ devices: (await this.state.storage.list()).size });
        if (p === '/register') {
            return this.state.blockConcurrencyWhile(async () => {
                if ((await this.state.storage.list()).size >= 100)
                    return Response.json({ error: 'device limit of 100 reached' }, { status: 429 });
                const deviceId = crypto.randomUUID(), agentConnectionToken = token(), readonlyMcpToken = token(), agentMcpToken = token();
                await this.state.storage.put(deviceId, { agentConnectionTokenHash: await hash(agentConnectionToken), readonlyMcpTokenHash: await hash(readonlyMcpToken), agentMcpTokenHash: await hash(agentMcpToken), createdAt: new Date().toISOString(), lastSeenAt: null });
                return Response.json({ deviceId, agentConnectionToken, readonlyMcpToken, agentMcpToken }, { status: 201 });
            });
        }
        const { deviceId, secret, kind } = await request.json() as {
            deviceId: string;
            secret: string;
            kind: 'agentConnectionTokenHash' | 'readonlyMcpTokenHash' | 'agentMcpTokenHash';
        };
        const record = await this.state.storage.get<RecordData>(deviceId);
        if (!record || !equal(await hash(secret), record[kind]))
            return Response.json({ error: 'missing or invalid credential' }, { status: 401 });
        record.lastSeenAt = new Date().toISOString();
        await this.state.storage.put(deviceId, record);
        return Response.json({ ok: true });
    }
}
