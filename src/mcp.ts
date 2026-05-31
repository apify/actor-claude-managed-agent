/**
 * Build an MCP server that proxies every request/notification to an upstream
 * MCP server reached over Streamable HTTP — specifically an Apify MCP
 * Connector at `${APIFY_MCP_PROXY_URL}/<connectorId>` authenticated with the
 * run's `APIFY_TOKEN`. The Apify MCP Proxy injects the user's third-party
 * credentials server-side, so this Actor never sees the upstream service's
 * tokens.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DEFAULT_REQUEST_TIMEOUT_MSEC } from '@modelcontextprotocol/sdk/shared/protocol.js';
import {
    ClientNotificationSchema,
    ClientRequestSchema,
    ResultSchema,
    ServerNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { log } from 'apify';

export interface UpstreamConfig {
    upstreamUrl: string;
    apifyToken: string;
}

export async function getMcpServer(
    upstream: UpstreamConfig,
    options?: { timeout?: number },
): Promise<McpServer> {
    const server = new McpServer({
        name: 'claude-agent-mcp-proxy',
        version: '1.0.0',
    });

    server.server.registerCapabilities({
        tools: {},
        prompts: {},
        resources: {},
        completions: {},
        logging: {},
        tasks: {},
    });

    const proxyClient = await getMcpProxyClient(upstream);

    for (const schema of ClientRequestSchema.options) {
        const method = schema.shape.method.value;
        server.server.setRequestHandler(schema, async (req) => {
            if (req.method === 'initialize') {
                log.info('MCP initialize — replying with cached upstream capabilities');
                return {
                    capabilities: proxyClient.getServerCapabilities(),
                    protocolVersion: req.params.protocolVersion,
                    serverInfo: {
                        name: 'Apify MCP proxy server',
                        title: 'Apify MCP proxy server',
                        version: '1.0.0',
                    },
                };
            }
            log.info(`MCP → upstream ${method}`, { params: req.params });
            try {
                const result = await proxyClient.request(req, ResultSchema, {
                    timeout: options?.timeout || DEFAULT_REQUEST_TIMEOUT_MSEC,
                });
                log.info(`MCP ← upstream ${method} ok`);
                return result;
            } catch (error) {
                log.error(`MCP ← upstream ${method} failed`, { error: (error as Error).message });
                throw error;
            }
        });
    }

    for (const schema of ClientNotificationSchema.options) {
        const method = schema.shape.method.value;
        server.server.setNotificationHandler(schema, async (notification) => {
            if (notification.method === 'notifications/initialized') {
                return;
            }
            log.info('Received MCP notification', { method, notification });
            await proxyClient.notification(notification);
        });
    }

    for (const schema of ServerNotificationSchema.options) {
        const method = schema.shape.method.value;
        proxyClient.setNotificationHandler(schema, async (notification) => {
            log.info('Sending MCP notification', { method, notification });
            await server.server.notification(notification);
        });
    }

    // NOTE: server→client *requests* (sampling/createMessage, elicitation/create,
    // roots/list) are NOT forwarded. The SDK gates those handlers on negotiated
    // capabilities on both legs, so a naive passthrough breaks the common path.
    // Connectors that need them are unsupported for now (rare for Apify connectors).

    server.server.onclose = () => {
        log.info('MCP Server is closing, shutting down the proxy client');
        proxyClient.close().catch((error) => {
            log.error('Error closing MCP Proxy Client', { error });
        });
    };

    return server;
}

async function getMcpProxyClient(upstream: UpstreamConfig): Promise<Client> {
    const { upstreamUrl, apifyToken } = upstream;
    log.info('Starting MCP proxy client to upstream', { upstreamUrl });

    const transport = new StreamableHTTPClientTransport(new URL(upstreamUrl), {
        requestInit: {
            headers: { Authorization: `Bearer ${apifyToken}` },
        },
    });

    const client = new Client({
        name: 'claude-agent-mcp-proxy-client',
        version: '1.0.0',
    });

    await client.connect(transport);
    log.info('MCP proxy client connected', {
        upstreamUrl,
        capabilities: client.getServerCapabilities(),
    });
    return client;
}
