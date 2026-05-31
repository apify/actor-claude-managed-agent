/**
 * End-to-end test of the Actor's MCP proxy path:
 *
 *   real MCP Client  ──▶  Actor /mcp/<id> (src/server.ts + src/mcp.ts)  ──▶  fake upstream MCP server
 *
 * The fake upstream stands in for the internal Apify MCP Proxy. Everything
 * uses the real @modelcontextprotocol/sdk over real HTTP on localhost, so this
 * exercises the full two-hop forwarding, session handshake, tools/list and
 * tools/call — the parts of the design we could not verify against the live
 * (cluster-private) proxy.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startServer, type StartedServer } from '../src/server.js';
import { freePort, startFakeUpstream } from './helpers/mcp-upstream.js';

async function connectClient(actorPort: number, connectorId: string): Promise<Client> {
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${actorPort}/mcp/${connectorId}`),
        { requestInit: { headers: { Authorization: 'Bearer test-token' } } },
    );
    await client.connect(transport);
    return client;
}

describe('Actor MCP proxy → upstream (end to end)', () => {
    let upstream: Awaited<ReturnType<typeof startFakeUpstream>>;
    let actor: StartedServer;
    let actorPort: number;

    beforeAll(async () => {
        upstream = await startFakeUpstream();
        actorPort = await freePort();
        actor = await startServer({
            serverPort: actorPort,
            apifyMcpProxyBaseUrl: upstream.baseUrl,
            apifyToken: 'test-token',
        });
    });

    afterAll(async () => {
        await actor.close();
        await upstream.close();
    });

    it('lists the upstream tool through the Actor proxy', async () => {
        const client = await connectClient(actorPort, 'conn_test');
        const { tools } = await client.listTools();
        expect(tools.map((t) => t.name)).toContain('echo');
        await client.close();
    });

    it('calls the upstream tool through the Actor proxy', async () => {
        const client = await connectClient(actorPort, 'conn_test');
        const result = await client.callTool({ name: 'echo', arguments: { text: 'hello' } });
        expect(result.content).toEqual([{ type: 'text', text: 'echo:hello' }]);
        await client.close();
    });

    it('forwards the run token as the upstream bearer', async () => {
        const client = await connectClient(actorPort, 'conn_test');
        await client.listTools();
        expect(upstream.lastAuth()).toBe('Bearer test-token');
        await client.close();
    });
});
