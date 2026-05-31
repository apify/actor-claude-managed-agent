import { describe, expect, it, vi } from 'vitest';

import { AnthropicAgents, type ApiError } from '../src/anthropic.js';

interface Call {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: unknown;
}

/** Build a client whose fetch records calls and returns queued responses. */
function makeClient(responses: Array<{ status?: number; json?: unknown; text?: string; stream?: boolean }>) {
    const calls: Call[] = [];
    let i = 0;
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const u = typeof url === 'string' ? url : url.toString();
        calls.push({
            url: u,
            method: init?.method ?? 'GET',
            headers: (init?.headers as Record<string, string>) ?? {},
            body: init?.body ? JSON.parse(init.body as string) : undefined,
        });
        const r = responses[i++] ?? { status: 200, json: {} };
        if (r.stream) {
            const rs = new ReadableStream<Uint8Array>({
                start(c) {
                    c.enqueue(new TextEncoder().encode('data: {"type":"session.status_idle"}\n\n'));
                    c.close();
                },
            });
            return new Response(rs, { status: r.status ?? 200, headers: { 'content-type': 'text/event-stream' } });
        }
        const bodyText = r.text ?? JSON.stringify(r.json ?? {});
        return new Response(bodyText, { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
    });
    const client = new AnthropicAgents({ apiKey: 'sk-ant', fetchImpl: fetchImpl as unknown as typeof fetch });
    return { client, calls };
}

describe('AnthropicAgents request building', () => {
    it('createVault posts display_name with beta headers', async () => {
        const { client, calls } = makeClient([{ json: { id: 'vlt_1' } }]);
        const vault = await client.createVault('actor-run-1');
        expect(vault.id).toBe('vlt_1');
        expect(calls[0].url).toBe('https://api.anthropic.com/v1/vaults');
        expect(calls[0].method).toBe('POST');
        expect(calls[0].body).toEqual({ display_name: 'actor-run-1' });
        expect(calls[0].headers['anthropic-beta']).toBe('managed-agents-2026-04-01');
        expect(calls[0].headers['x-api-key']).toBe('sk-ant');
    });

    it('addStaticBearerCredential binds token to the mcp_server_url', async () => {
        const { client, calls } = makeClient([{ json: { id: 'cred_1' } }]);
        await client.addStaticBearerCredential('vlt_1', {
            displayName: 'connector-a',
            mcpServerUrl: 'https://abc.runs.apify.net/mcp/a',
            token: 'apify_tok',
        });
        expect(calls[0].url).toBe('https://api.anthropic.com/v1/vaults/vlt_1/credentials');
        expect(calls[0].body).toEqual({
            display_name: 'connector-a',
            auth: { type: 'static_bearer', mcp_server_url: 'https://abc.runs.apify.net/mcp/a', token: 'apify_tok' },
        });
    });

    it('createSession sends agent id, environment, vaults', async () => {
        const { client, calls } = makeClient([{ json: { id: 'ses_1', status: 'idle' } }]);
        const s = await client.createSession({ agentId: 'ag_1', environmentId: 'env_1', vaultIds: ['vlt_1'], title: 'T' });
        expect(s.id).toBe('ses_1');
        expect(calls[0].body).toEqual({
            agent: 'ag_1',
            environment_id: 'env_1',
            vault_ids: ['vlt_1'],
            title: 'T',
        });
    });

    it('getSession is a GET', async () => {
        const { client, calls } = makeClient([{ json: { id: 'ses_1', agent: { tools: [] } } }]);
        await client.getSession('ses_1');
        expect(calls[0].method).toBe('GET');
        expect(calls[0].url).toBe('https://api.anthropic.com/v1/sessions/ses_1');
    });

    it('updateSessionAgent posts the agent block', async () => {
        const { client, calls } = makeClient([{ json: { id: 'ses_1' } }]);
        await client.updateSessionAgent('ses_1', {
            tools: [{ type: 'mcp_toolset', mcp_server_name: 'connector-a' }],
            mcp_servers: [{ type: 'url', name: 'connector-a', url: 'https://x/mcp/a' }],
        });
        expect(calls[0].method).toBe('POST');
        expect(calls[0].body).toEqual({
            agent: {
                tools: [{ type: 'mcp_toolset', mcp_server_name: 'connector-a' }],
                mcp_servers: [{ type: 'url', name: 'connector-a', url: 'https://x/mcp/a' }],
            },
        });
    });

    it('sendUserMessage wraps text in a user.message event', async () => {
        const { client, calls } = makeClient([{ json: {} }]);
        await client.sendUserMessage('ses_1', 'do it');
        expect(calls[0].url).toBe('https://api.anthropic.com/v1/sessions/ses_1/events');
        expect(calls[0].body).toEqual({ events: [{ type: 'user.message', content: [{ type: 'text', text: 'do it' }] }] });
    });

    it('openEventStream GETs with text/event-stream and returns a body', async () => {
        const { client, calls } = makeClient([{ stream: true }]);
        const res = await client.openEventStream('ses_1');
        expect(calls[0].method).toBe('GET');
        expect(calls[0].headers.accept).toBe('text/event-stream');
        expect(res.body).toBeTruthy();
    });

    it('deleteVault is a DELETE', async () => {
        const { client, calls } = makeClient([{ json: {} }]);
        await client.deleteVault('vlt_1');
        expect(calls[0].method).toBe('DELETE');
        expect(calls[0].url).toBe('https://api.anthropic.com/v1/vaults/vlt_1');
    });
});

describe('AnthropicAgents error handling', () => {
    it('throws ApiError with status + parsed message', async () => {
        const { client } = makeClient([{ status: 404, json: { error: { message: 'not found' } } }]);
        await expect(client.getSession('ses_x')).rejects.toMatchObject({
            status: 404,
            message: expect.stringContaining('not found'),
        });
    });

    it('honours a custom baseUrl', async () => {
        const { client, calls } = makeClient([{ json: { id: 'vlt_1' } }]);
        // re-create with baseUrl
        const c2 = new AnthropicAgents({
            apiKey: 'sk',
            baseUrl: 'https://example.test/',
            fetchImpl: (async () => new Response('{"id":"v"}', { status: 200 })) as unknown as typeof fetch,
        });
        const v = await c2.createVault('x');
        expect(v.id).toBe('v');
        // original client unaffected
        expect(calls.length).toBe(0);
    });

    it('surfaces the failing status as a thrown ApiError shape', async () => {
        const { client } = makeClient([{ status: 500, text: 'boom' }]);
        const err = await client.createVault('x').catch((e) => e as ApiError);
        expect((err as ApiError).status).toBe(500);
    });
});
