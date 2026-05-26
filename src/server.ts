/**
 * Public MCP endpoint hosted inside the Actor container.
 *
 * Anthropic's Managed Agent (cloud-side) connects to
 *   `${CONTAINER_URL}/mcp/<connectorId>`   (Bearer APIFY_TOKEN)
 *
 * For each new session the server stands up a per-connector McpServer that
 * proxies every MCP message through to the documented Apify MCP Proxy at
 *   `${APIFY_MCP_PROXY_URL}/<connectorId>` (also Bearer APIFY_TOKEN).
 *
 * Why not point Anthropic at the Apify MCP Proxy directly? Hosting the
 * endpoint inside the Actor gives the Actor a single public surface it
 * owns — useful for logging, transforming, or scoping the MCP traffic per
 * run without touching user credentials (those stay inside the Apify Proxy).
 */
import { randomUUID } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { log } from 'apify';
import express, { type NextFunction, type Request, type Response } from 'express';

import { getMcpServer } from './mcp.js';

// MCP tool responses can carry sizeable JSON (scraped HTML, dataset items,
// etc.). The Express default of 100 KB rejects realistic payloads mid-session.
const MAX_BODY_BYTES = '10mb';
// Conservative connector ID shape: alphanumerics plus `-` and `_`. Apify
// connector IDs follow this pattern; locking it down here prevents slashes,
// dots, or URL-encoded sequences from altering the upstream URL path.
const CONNECTOR_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface StartServerOptions {
    /** Port the local Express server listens on (Apify container web server port). */
    serverPort: number;
    /** Base URL of the Apify MCP Proxy (env: APIFY_MCP_PROXY_URL). */
    apifyMcpProxyBaseUrl: string;
    /** Run's APIFY_TOKEN — used both for incoming Bearer validation and downstream auth. */
    apifyToken: string;
}

export interface StartedServer {
    /** Stop accepting new connections and close active MCP transports. */
    close: () => Promise<void>;
}

export async function startServer(options: StartServerOptions): Promise<StartedServer> {
    const { serverPort, apifyMcpProxyBaseUrl, apifyToken } = options;
    log.info('Starting MCP HTTP Server', { serverPort, apifyMcpProxyBaseUrl });

    const transports: Record<string, { transport: StreamableHTTPServerTransport; connectorId: string }> = {};
    const app = express();

    app.get('/favicon.ico', (_req, res) => {
        res.writeHead(301, { Location: 'https://apify.com/favicon.ico' });
        res.end();
    });

    // Log every incoming HTTP request and its final status. Lets you see at a
    // glance whether the request even reached this Actor, which path/auth state
    // it landed in, and what we sent back.
    app.use((req: Request, res: Response, next: NextFunction) => {
        const sessionId = req.headers['mcp-session-id'] as string | undefined;
        const hasAuth = typeof req.headers.authorization === 'string';
        log.info(`→ ${req.method} ${req.originalUrl}`, {
            sessionId: sessionId ?? null,
            hasAuthHeader: hasAuth,
            contentLength: req.headers['content-length'] ?? null,
        });
        res.on('finish', () => {
            log.info(`← ${req.method} ${req.originalUrl} ${res.statusCode}`, {
                sessionId: sessionId ?? null,
            });
        });
        next();
    });

    app.use(express.json({ limit: MAX_BODY_BYTES }));

    // No inbound bearer check: the Apify platform gates the container URL,
    // so any request that reaches us has already been auth-validated. The
    // upstream Apify MCP Proxy call below still uses APIFY_TOKEN as the
    // bearer to identify this run.

    const requireValidConnectorId = (req: Request, res: Response, next: NextFunction) => {
        const { connectorId } = req.params;
        if (typeof connectorId !== 'string' || !CONNECTOR_ID_PATTERN.test(connectorId)) {
            log.warning('Rejected request: invalid connector ID', {
                path: req.originalUrl,
                connectorId: connectorId ?? null,
            });
            res.status(400).json({
                jsonrpc: '2.0',
                error: { code: -32602, message: 'Invalid connector ID' },
                id: null,
            });
            return;
        }
        next();
    };

    app.post('/mcp/:connectorId', requireValidConnectorId, async (req, res) => {
        // requireValidConnectorId guarantees this is a non-empty string.
        const connectorId = req.params.connectorId as string;
        const sessionId = req.headers['mcp-session-id'] as string | undefined;
        const rpcMethod = typeof req.body?.method === 'string' ? req.body.method : null;
        log.info('POST /mcp body received', {
            connectorId,
            sessionId: sessionId ?? null,
            rpcMethod,
            rpcId: req.body?.id ?? null,
            isInitialize: isInitializeRequest(req.body),
        });
        try {
            let transport: StreamableHTTPServerTransport;
            if (sessionId && transports[sessionId]) {
                const entry = transports[sessionId];
                if (entry.connectorId !== connectorId) {
                    log.warning('Session/connector mismatch — rejecting', {
                        sessionId,
                        sessionConnectorId: entry.connectorId,
                        requestConnectorId: connectorId,
                    });
                    res.status(404).json({
                        jsonrpc: '2.0',
                        error: { code: -32001, message: 'Session not found for this connector' },
                        id: null,
                    });
                    return;
                }
                log.info('Reusing existing transport', { sessionId, connectorId });
                transport = entry.transport;
            } else if (!sessionId && isInitializeRequest(req.body)) {
                // Two concurrent retries of the same initialize land here as
                // two independent sessions. We rely on the Actor.exit cleanup
                // loop to close the orphan; bounding concurrent inits would
                // require a per-connector lock and isn't worth the complexity
                // for a single-tenant per-run actor.
                transport = new StreamableHTTPServerTransport({
                    sessionIdGenerator: () => randomUUID(),
                    onsessioninitialized: (initializedSessionId) => {
                        log.info('Session initialized', { sessionId: initializedSessionId, connectorId });
                        transports[initializedSessionId] = { transport, connectorId };
                    },
                });

                transport.onclose = () => {
                    const sid = transport.sessionId;
                    if (sid && transports[sid]) {
                        log.info('Transport closed', { sessionId: sid });
                        delete transports[sid];
                    }
                };

                const upstreamUrl = `${apifyMcpProxyBaseUrl.replace(/\/$/, '')}/${encodeURIComponent(connectorId)}`;
                log.info('New session — opening upstream MCP client', { connectorId, upstreamUrl });
                let mcpServer;
                try {
                    mcpServer = await getMcpServer({ upstreamUrl, apifyToken });
                } catch (upstreamError) {
                    log.error('Failed to open upstream MCP client', {
                        upstreamUrl,
                        connectorId,
                        error: (upstreamError as Error).message,
                    });
                    res.status(502).json({
                        jsonrpc: '2.0',
                        error: {
                            code: -32099,
                            message: `Upstream MCP unavailable: ${(upstreamError as Error).message}`,
                        },
                        id: null,
                    });
                    return;
                }
                try {
                    await mcpServer.connect(transport);
                } catch (connectError) {
                    // Avoid leaking the upstream client if the local connect failed
                    // after the upstream was already wired up.
                    await mcpServer.close().catch((closeError) => {
                        log.warning('Failed to close MCP server after connect error', {
                            error: (closeError as Error).message,
                        });
                    });
                    throw connectError;
                }

                await transport.handleRequest(req, res, req.body);
                return;
            } else {
                log.warning('POST rejected: no valid session ID and not an initialize request', {
                    sessionId: sessionId ?? null,
                    rpcMethod,
                });
                res.status(400).json({
                    jsonrpc: '2.0',
                    error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
                    id: null,
                });
                return;
            }

            await transport.handleRequest(req, res, req.body);
        } catch (error) {
            log.error('Error handling MCP request', { error, sessionId: sessionId || null, connectorId });
            if (!res.headersSent) {
                res.status(500).json({
                    jsonrpc: '2.0',
                    error: { code: -32603, message: 'Internal server error' },
                    id: null,
                });
            }
        }
    });

    const sessionStreamHandler = async (req: Request, res: Response) => {
        // requireValidConnectorId guarantees this is a non-empty string.
        const connectorId = req.params.connectorId as string;
        const sessionId = req.headers['mcp-session-id'] as string | undefined;
        if (!sessionId || !transports[sessionId]) {
            log.warning(`${req.method} /mcp/${connectorId} rejected: invalid/missing session ID`, {
                sessionId: sessionId ?? null,
                knownSessions: Object.keys(transports),
            });
            res.status(400).send('Invalid or missing session ID');
            return;
        }
        if (transports[sessionId].connectorId !== connectorId) {
            log.warning(`${req.method} session/connector mismatch`, {
                sessionId,
                sessionConnectorId: transports[sessionId].connectorId,
                requestConnectorId: connectorId,
            });
            res.status(404).send('Session not found for this connector');
            return;
        }
        log.info(`${req.method} /mcp/${connectorId} forwarding to transport`, { sessionId });
        await transports[sessionId].transport.handleRequest(req, res);
    };

    app.get('/mcp/:connectorId', requireValidConnectorId, sessionStreamHandler);
    app.delete('/mcp/:connectorId', requireValidConnectorId, sessionStreamHandler);

    const httpServer: HttpServer = await new Promise((resolve) => {
        const server = app.listen(serverPort, () => {
            log.info(`MCP HTTP Server listening on port ${serverPort}`);
            resolve(server);
        });
    });

    return {
        close: async () => {
            for (const sid of Object.keys(transports)) {
                try {
                    await transports[sid].transport.close();
                } catch (error) {
                    log.warning('Error closing MCP transport', { sessionId: sid, error: (error as Error).message });
                }
                delete transports[sid];
            }
            await new Promise<void>((resolve, reject) => httpServer.close((err) => (err ? reject(err) : resolve())));
        },
    };
}
