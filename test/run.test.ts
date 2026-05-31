import { describe, expect, it, vi } from 'vitest';

import { AnthropicAgents } from '../src/anthropic.js';
import { errorCodeFor, executeAgentRun, type RunRefs } from '../src/run.js';

const BASE_URL = 'https://abc.runs.apify.net';
const CONTAINER_MCP = `${BASE_URL}/mcp`;

interface Call { method: string; path: string; body: unknown; }

/**
 * Mock Anthropic API. Routes by method + path suffix and records every call so
 * tests can assert the orchestration sequence. The event stream is configurable.
 */
function makeMockClient(opts: { sessionTools?: unknown[]; streamFrames?: string[] } = {}) {
    const calls: Call[] = [];
    const streamFrames = opts.streamFrames ?? [
        'data: {"id":"e1","type":"agent.message","content":[{"type":"text","text":"working"}]}\n\n',
        'data: {"id":"e2","type":"agent.mcp_tool_use","name":"echo"}\n\n',
        'data: {"id":"e3","type":"agent.message","content":[{"type":"text","text":"final answer"}]}\n\n',
        'data: {"id":"e4","type":"session.status_idle","stop_reason":"end_turn"}\n\n',
    ];

    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
        const u = new URL(typeof url === 'string' ? url : url.toString());
        const method = init?.method ?? 'GET';
        const body = init?.body ? JSON.parse(init.body as string) : undefined;
        calls.push({ method, path: u.pathname, body });

        const json = (obj: unknown, status = 200) =>
            new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

        // Order matters: match the stream path before the generic session GET.
        if (u.pathname.endsWith('/events/stream')) {
            const rs = new ReadableStream<Uint8Array>({
                start(c) {
                    for (const f of streamFrames) c.enqueue(new TextEncoder().encode(f));
                    c.close();
                },
            });
            return new Response(rs, { status: 200, headers: { 'content-type': 'text/event-stream' } });
        }
        if (u.pathname.endsWith('/events') && method === 'POST') return json({});
        if (u.pathname === '/v1/vaults' && method === 'POST') return json({ id: 'vlt_1' });
        if (/\/v1\/vaults\/[^/]+\/credentials$/.test(u.pathname)) return json({ id: 'cred_1' });
        if (/\/v1\/vaults\/[^/]+$/.test(u.pathname) && method === 'DELETE') return json({});
        if (u.pathname === '/v1/sessions' && method === 'POST') return json({ id: 'ses_1', status: 'idle' });
        if (/\/v1\/sessions\/[^/]+$/.test(u.pathname) && method === 'GET') {
            return json({ id: 'ses_1', agent: { tools: opts.sessionTools ?? [{ type: 'agent_toolset_20260401' }] } });
        }
        if (/\/v1\/sessions\/[^/]+$/.test(u.pathname) && method === 'POST') return json({ id: 'ses_1' });
        return json({}, 404);
    });

    const client = new AnthropicAgents({ apiKey: 'sk', fetchImpl: fetchImpl as unknown as typeof fetch });
    return { client, calls };
}

const baseParams = (client: AnthropicAgents, connectorIds: string[]) => ({
    client,
    prompt: 'do the thing',
    connectorIds,
    agentId: 'ag_1',
    environmentId: 'env_1',
    runId: 'run_1',
    containerMcpBaseUrl: CONTAINER_MCP,
    apifyToken: 'apify_tok',
    timeoutAt: null,
});

describe('executeAgentRun — with connectors', () => {
    it('runs the full sequence and returns the final answer', async () => {
        const { client, calls } = makeMockClient();
        const refs: RunRefs = { vaultId: null, sessionId: null, events: [] };
        const result = await executeAgentRun(baseParams(client, ['a', 'b']), refs);

        expect(result.outcome).toBe('idle');
        expect(result.answer).toBe('final answer');
        expect(result.sessionId).toBe('ses_1');
        expect(refs.events).toHaveLength(4);
        expect(refs.vaultId).toBe('vlt_1');
        expect(refs.sessionId).toBe('ses_1');

        // Verify the call sequence (the order the design requires).
        const seq = calls.map((c) => `${c.method} ${c.path}`);
        expect(seq).toEqual([
            'POST /v1/vaults',
            'POST /v1/vaults/vlt_1/credentials', // connector a
            'POST /v1/vaults/vlt_1/credentials', // connector b
            'POST /v1/sessions',
            'GET /v1/sessions/ses_1', // read inherited agent tools
            'POST /v1/sessions/ses_1', // update mcp_servers/tools
            'GET /v1/sessions/ses_1/events/stream', // stream opened…
            'POST /v1/sessions/ses_1/events', // …before sending the prompt
        ]);
    });

    it('sets credential URLs that match the session mcp_servers URLs (byte-match)', async () => {
        const { client, calls } = makeMockClient();
        await executeAgentRun(baseParams(client, ['a']), { vaultId: null, sessionId: null, events: [] });

        const credCall = calls.find((c) => c.path.endsWith('/credentials'));
        const credUrl = (credCall!.body as { auth: { mcp_server_url: string } }).auth.mcp_server_url;

        const updateCall = calls.find((c) => c.path === '/v1/sessions/ses_1' && c.method === 'POST');
        const serverUrl = (updateCall!.body as { agent: { mcp_servers: Array<{ url: string }> } }).agent.mcp_servers[0].url;

        expect(credUrl).toBe(`${CONTAINER_MCP}/a`);
        expect(credUrl).toBe(serverUrl);
    });

    it('preserves the agent built-in toolset while injecting mcp_toolset', async () => {
        const { client, calls } = makeMockClient({
            sessionTools: [{ type: 'agent_toolset_20260401' }, { type: 'mcp_toolset', mcp_server_name: 'stale' }],
        });
        await executeAgentRun(baseParams(client, ['a']), { vaultId: null, sessionId: null, events: [] });

        const updateCall = calls.find((c) => c.path === '/v1/sessions/ses_1' && c.method === 'POST');
        const tools = (updateCall!.body as { agent: { tools: Array<{ type: string; mcp_server_name?: string }> } }).agent.tools;
        expect(tools.some((t) => t.type === 'agent_toolset_20260401')).toBe(true);
        expect(tools.filter((t) => t.type === 'mcp_toolset').map((t) => t.mcp_server_name)).toEqual(['connector-a']);
    });
});

describe('executeAgentRun — without connectors', () => {
    it('skips vault + session update, still streams', async () => {
        const { client, calls } = makeMockClient();
        const refs: RunRefs = { vaultId: null, sessionId: null, events: [] };
        const result = await executeAgentRun(baseParams(client, []), refs);

        expect(result.answer).toBe('final answer');
        expect(refs.vaultId).toBeNull();
        const seq = calls.map((c) => `${c.method} ${c.path}`);
        expect(seq).toEqual([
            'POST /v1/sessions',
            'GET /v1/sessions/ses_1/events/stream',
            'POST /v1/sessions/ses_1/events',
        ]);
        // createSession got an empty vault_ids array.
        expect((calls[0].body as { vault_ids: string[] }).vault_ids).toEqual([]);
    });
});

describe('executeAgentRun — failure modes', () => {
    it('reports terminated with the prior error message and keeps partial answer', async () => {
        const { client } = makeMockClient({
            streamFrames: [
                'data: {"id":"e1","type":"agent.message","content":[{"type":"text","text":"partial work"}]}\n\n',
                'data: {"id":"e2","type":"session.error","error":{"message":"model overloaded"}}\n\n',
                'data: {"id":"e3","type":"session.status_terminated"}\n\n',
            ],
        });
        const result = await executeAgentRun(baseParams(client, []), { vaultId: null, sessionId: null, events: [] });
        expect(result.outcome).toBe('terminated');
        expect(result.errorMessage).toBe('model overloaded');
        expect(result.answer).toBe('partial work');
        expect(errorCodeFor(result.outcome)).toBe('session_terminated');
    });

    it('still populates refs.vaultId when a later step throws (so cleanup can run)', async () => {
        // Make createSession fail after the vault is created.
        const calls: Call[] = [];
        const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
            const u = new URL(typeof url === 'string' ? url : url.toString());
            const method = init?.method ?? 'GET';
            calls.push({ method, path: u.pathname, body: undefined });
            if (u.pathname === '/v1/vaults' && method === 'POST') {
                return new Response(JSON.stringify({ id: 'vlt_9' }), { status: 200 });
            }
            if (/\/credentials$/.test(u.pathname)) return new Response('{}', { status: 200 });
            if (u.pathname === '/v1/sessions') {
                return new Response(JSON.stringify({ error: { message: 'bad agent' } }), { status: 400 });
            }
            return new Response('{}', { status: 200 });
        });
        const client = new AnthropicAgents({ apiKey: 'sk', fetchImpl: fetchImpl as unknown as typeof fetch });
        const refs: RunRefs = { vaultId: null, sessionId: null, events: [] };

        await expect(executeAgentRun(baseParams(client, ['a']), refs)).rejects.toThrow(/bad agent/);
        expect(refs.vaultId).toBe('vlt_9'); // cleanup can now delete it
    });
});

describe('executeAgentRun — deadline', () => {
    it('classifies a deadline abort during stream-open as timeout, not a crash', async () => {
        const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
            const u = new URL(typeof url === 'string' ? url : url.toString());
            if (u.pathname === '/v1/sessions') return new Response(JSON.stringify({ id: 'ses_t' }), { status: 200 });
            if (u.pathname.endsWith('/events/stream')) {
                // Never resolve until the deadline AbortController aborts.
                return new Promise<Response>((_resolve, reject) => {
                    init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
                });
            }
            return new Response('{}', { status: 200 });
        });
        const client = new AnthropicAgents({ apiKey: 'sk', fetchImpl: fetchImpl as unknown as typeof fetch });
        // Deadline floors to ~1s: at = now+1s, offset 30s → max(1000, negative) = 1000ms.
        const timeoutAt = new Date(Date.now() + 1_000).toISOString();
        const refs: RunRefs = { vaultId: null, sessionId: null, events: [] };
        const result = await executeAgentRun({ ...baseParams(client, []), timeoutAt }, refs);
        expect(result.outcome).toBe('timeout');
        expect(result.sessionId).toBe('ses_t');
    });

    it('creates one credential per connector', async () => {
        const { client, calls } = makeMockClient();
        await executeAgentRun(baseParams(client, ['a', 'b', 'c']), { vaultId: null, sessionId: null, events: [] });
        expect(calls.filter((c) => c.path.endsWith('/credentials'))).toHaveLength(3);
    });
});

describe('errorCodeFor', () => {
    it('maps outcomes to codes', () => {
        expect(errorCodeFor('idle')).toBeNull();
        expect(errorCodeFor('terminated')).toBe('session_terminated');
        expect(errorCodeFor('timeout')).toBe('timeout');
        expect(errorCodeFor('stream_dropped')).toBe('stream_dropped');
    });
});
