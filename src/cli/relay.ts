import { parseArgs } from 'node:util';
import { register, readRegistration, describeUrls, relayUrl } from '../relay/registration.js';
import { startClient } from '../relay/client.js';
export async function runRelay(argv: string[]): Promise<number> {
    try {
        const { positionals, values } = parseArgs({
            args: argv, allowPositionals: true, options: {
                url: { type: 'string' }, name: { type: 'string' },
                'readonly-token-file': { type: 'string' }, 'agent-token-file': { type: 'string' },
                // Which loopback instance a channel reaches is a local decision: one public URL can be
                // pointed at the agent (write-capable) instance without touching the relay or any token.
                'readonly-target': { type: 'string' }, 'agent-target': { type: 'string' },
            },
        });
        const action = positionals[0];
        if (action === 'stop') {
            console.log('relay start runs in the foreground; use Ctrl-C in that terminal to stop it.');
            return 0;
        }
        if (action === 'setup') {
            if (!values.url)
                throw new Error('relay setup requires --url');
            const r = await register(values.url, values.name);
            console.log(`deviceId=${r.deviceId}\n${describeUrls(r)}`);
            return 0;
        }
        if (!['start', 'status', 'url'].includes(action ?? ''))
            throw new Error('Usage: relay setup|start|status|stop|url [--url origin] [--readonly-target url] [--agent-target url]');
        const r = await readRegistration();
        if (values.url && relayUrl(values.url) !== r.url)
            throw new Error('Relay URL differs from registered origin');
        if (action === 'url') {
            console.log(describeUrls(r));
            return 0;
        }
        if (action === 'status') {
            const response = await fetch(`${r.url}/status/${r.deviceId}`, { headers: { authorization: `Bearer ${r.agentConnectionToken}` }, redirect: 'error' });
            if (!response.ok)
                throw new Error(`Status failed (${response.status})`);
            console.log(JSON.stringify(await response.json()));
            return 0;
        }
        const client = await startClient(r, {
            readonlyTokenFile: values['readonly-token-file'],
            agentTokenFile: values['agent-token-file'],
            targets: {
                ...(values['readonly-target'] ? { readonly: values['readonly-target'] } : {}),
                ...(values['agent-target'] ? { agent: values['agent-target'] } : {}),
            },
        });
        await new Promise<void>(resolve => { const stop = () => { client.stop(); process.off('SIGINT', stop); process.off('SIGTERM', stop); resolve(); }; process.on('SIGINT', stop); process.on('SIGTERM', stop); });
        return 0;
    }
    catch {
        console.error('Relay command failed; check arguments, relay availability, and mode-600 credential files. Existing credentials are never overwritten.');
        return 1;
    }
}
