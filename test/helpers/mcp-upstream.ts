/**
 * A minimal but spec-compliant upstream MCP server exposing an `echo` tool.
 * Stands in for the internal Apify MCP Proxy in tests.
 */
import { createServer, type Server as HttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, isInitializeRequest, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import express from 'express';

export interface FakeUpstream {
    baseUrl: string;
    close: () => Promise<void>;
    lastAuth: () => string | undefined;
}

export async function startFakeUpstream(): Promise<FakeUpstream> {
    const transports: Record<string, StreamableHTTPServerTransport> = {};
    let lastAuth: string | undefined;
    const app = express();
    app.use(express.json());

    const makeServer = () => {
        const server = new Server({ name: 'fake-upstream', version: '1.0.0' }, { capabilities: { tools: {} } });
        server.setRequestHandler(ListToolsRequestSchema, async () => ({
            tools: [{
                name: 'echo',
                description: 'Echo back the provided text',
                inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
            }],
        }));
        server.setRequestHandler(CallToolRequestSchema, async (req) => ({
            content: [{ type: 'text', text: `echo:${(req.params.arguments as { text?: string } | undefined)?.text ?? ''}` }],
        }));
        return server;
    };

    app.post('/:connectorId', async (req, res) => {
        lastAuth = req.headers.authorization;
        const sid = req.headers['mcp-session-id'] as string | undefined;
        let transport = sid ? transports[sid] : undefined;
        if (!transport && isInitializeRequest(req.body)) {
            transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                onsessioninitialized: (id) => { transports[id] = transport!; },
            });
            await makeServer().connect(transport);
        }
        if (!transport) {
            res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'no session' }, id: null });
            return;
        }
        await transport.handleRequest(req, res, req.body);
    });
    const sessionRoute = async (req: express.Request, res: express.Response) => {
        const sid = req.headers['mcp-session-id'] as string | undefined;
        const transport = sid ? transports[sid] : undefined;
        if (!transport) { res.status(400).end(); return; }
        await transport.handleRequest(req, res);
    };
    app.get('/:connectorId', sessionRoute);
    app.delete('/:connectorId', sessionRoute);

    const http: HttpServer = await new Promise((resolve) => {
        const s = createServer(app);
        s.listen(0, '127.0.0.1', () => resolve(s));
    });
    const port = (http.address() as AddressInfo).port;
    return {
        baseUrl: `http://127.0.0.1:${port}`,
        lastAuth: () => lastAuth,
        close: () => new Promise<void>((resolve) => http.close(() => resolve())),
    };
}

export function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const s = createServer();
        s.listen(0, '127.0.0.1', () => {
            const p = (s.address() as AddressInfo).port;
            s.close(() => resolve(p));
        });
        s.on('error', reject);
    });
}
