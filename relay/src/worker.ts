export { Registry } from './registry';
export { Device } from './device';
export interface Env {
    RELAY_DO: DurableObjectNamespace;
    REGISTRY_DO: DurableObjectNamespace;
}
export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url), parts = url.pathname.split('/');
        const registry = env.REGISTRY_DO.get(env.REGISTRY_DO.idFromName('registry'));
        if (url.pathname === '/healthz' && request.method === 'GET') {
            const count = await (await registry.fetch('https://internal/count')).json() as {
                devices: number;
            };
            return Response.json({ ok: true, service: 'multimodel-broker-relay', version: '0.1.0', ...count });
        }
        if (url.pathname === '/register' && request.method === 'POST')
            return registry.fetch('https://internal/register', { method: 'POST' });
        const route = parts[1], deviceId = parts[2];
        if (!deviceId || !['agent', 'status', 'mcp'].includes(route))
            return Response.json({ error: 'not found' }, { status: 404 });
        if (route !== 'mcp' && request.method !== 'GET')
            return new Response(null, { status: 405 });
        const channel = parts[3];
        if (route === 'mcp' && (parts.length !== 5 || !['readonly', 'agent'].includes(channel)))
            return new Response(null, { status: 404 });
        const protocol = request.headers.get('sec-websocket-protocol') ?? '';
        const secret = route === 'mcp' ? parts[4] : (request.headers.get('authorization')?.match(/^Bearer (.+)$/)?.[1] ?? protocol.match(/^broker-relay\.([A-Za-z0-9_-]+)$/)?.[1] ?? '');
        const kind = route === 'mcp' ? (channel === 'readonly' ? 'readonlyMcpTokenHash' : 'agentMcpTokenHash') : 'agentConnectionTokenHash';
        const auth = await registry.fetch('https://internal/auth', { method: 'POST', body: JSON.stringify({ deviceId, secret, kind }) });
        if (!auth.ok)
            return auth;
        const target = new URL('https://internal/' + route);
        target.searchParams.set('deviceId', deviceId);
        if (channel)
            target.searchParams.set('channel', channel);
        const headers = new Headers(request.headers);
        headers.delete('authorization');
        return env.RELAY_DO.get(env.RELAY_DO.idFromName(deviceId)).fetch(new Request(target, { method: request.method, headers, body: request.body, redirect: 'manual' }));
    }
};
