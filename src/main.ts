/**
 * Apify Actor entrypoint.
 *
 * Two modes (selected by env var `MCP_PROXY_ONLY`):
 *
 * 1. Normal mode (default) — runs the full Claude Managed Agent flow:
 *      a. Validate input + required env vars.
 *      b. If any MCP Connectors were requested, start a local MCP proxy on the
 *         Actor's web server port. The proxy is reachable from Anthropic's cloud
 *         at `${CONTAINER_URL}/mcp/<connectorId>` (Bearer APIFY_TOKEN) and
 *         forwards to `${APIFY_MCP_PROXY_URL}/<connectorId>`.
 *      c. Build the per-run MCP server list (mcp.apify.com + container-url proxies).
 *      d. Clone the developer's template Agent, overriding mcp_servers.
 *      e. Create a vault + one static_bearer credential per MCP URL.
 *      f. Reuse a cached Environment or create one.
 *      g. Create a Session, send the user prompt, poll until idle.
 *      h. Fetch the final agent text, push to Dataset + KV OUTPUT.
 *      i. Cleanup: delete the vault, archive the cloned Agent, stop the proxy.
 *
 * 2. Proxy-only mode (`MCP_PROXY_ONLY=1`) — boots only the local MCP proxy and
 *    blocks until aborted. Lets you point a local MCP client at
 *    `http://localhost:<ACTOR_WEB_SERVER_PORT>/mcp/<connectorId>` (Bearer APIFY_TOKEN)
 *    to test the proxy + upstream Apify MCP Proxy round-trip without spinning up
 *    the Anthropic Managed Agent.
 */

import { Actor, log } from 'apify';

import {
    cloneAgentWithDynamicMcp,
    createVaultWithCredentials,
    createEnvironment,
    createSession,
    sendUserMessage,
    waitForSessionIdle,
    fetchLatestAgentText,
    cleanup,
    type CleanupRefs,
    type McpServer,
} from './anthropic.js';
import { extractTextFromEvent, type SessionEvent } from './extract.js';
import { startServer, type StartedServer } from './server.js';

const LOG_TEXT_PREVIEW_CHARS = 400;

/**
 * `Actor.fail` already calls `process.exit`, so the line after never runs —
 * but `Actor.fail` is typed `Promise<void>`. Wrapping it in a helper with a
 * `never` return type lets TypeScript narrow control flow after the call
 * without us having to `throw`.
 */
async function failAndExit(message: string): Promise<never> {
    await Actor.fail(message);
    process.exit(1);
}

function formatEventForLog(event: SessionEvent): string | null {
    if (event.type !== 'agent.message') return null;
    const text = extractTextFromEvent(event);
    if (!text) return null;
    const oneline = text.replace(/\s+/g, ' ').trim();
    const preview = oneline.length > LOG_TEXT_PREVIEW_CHARS
        ? `${oneline.slice(0, LOG_TEXT_PREVIEW_CHARS)}…`
        : oneline;
    return `💬 ${preview}`;
}

interface ActorInput {
    prompt: string;
    mcpConnectors?: string[];
    /** Hidden debug toggle — boots only the local MCP proxy, skips the Claude agent. */
    mcpProxyOnly?: boolean;
}

interface ProcessedInputs {
    mcpProxyOnly: boolean;
    prompt: string;
    mcpConnectors: string[];
    apiKey: string;
    templateAgentId: string;
    apifyToken: string;
    runId: string;
}

interface ActorResult {
    answer: string;
    agentId: string;
    sessionId: string;
    environmentId: string;
    durationMs: number;
    finishedAt: string;
}

const CONNECTOR_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Boots the local MCP proxy and returns its handle plus the public base URL.
 * Used by BOTH the full agent flow (Anthropic's cloud agent calls into the
 * proxy via the container URL) AND the proxy-only debug mode.
 */
async function startMcpProxy(apifyToken: string): Promise<{ server: StartedServer; baseUrl: string }> {
    const apifyMcpProxyBaseUrl = process.env.APIFY_MCP_PROXY_URL!;
    const containerUrl = process.env.APIFY_CONTAINER_URL!.replace(/\/$/, '');
    const serverPort = Number(process.env.ACTOR_WEB_SERVER_PORT) || 4321;
    const server = await startServer({ serverPort, apifyMcpProxyBaseUrl, apifyToken });
    return { server, baseUrl: `${containerUrl}/mcp` };
}

/** Resolve when the platform signals abort/migrate or the OS signals SIGINT/SIGTERM. */
function waitForShutdownSignal(): Promise<void> {
    return new Promise((resolve) => {
        const stop = () => resolve();
        Actor.on('aborting', stop);
        Actor.on('migrating', stop);
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
    });
}

/**
 * Reads + validates Actor input and developer env vars. Fails fast (via
 * `Actor.fail`) on any user-facing error so the run shows a clear status
 * message in the Console. Apify-injected env vars are trusted as present.
 */
async function processInputs(): Promise<ProcessedInputs> {
    const raw = ((await Actor.getInput<ActorInput>()) ?? {}) as Partial<ActorInput>;
    const mcpProxyOnly = raw.mcpProxyOnly === true;

    const mcpConnectors = raw.mcpConnectors ?? [];
    if (!Array.isArray(mcpConnectors) || mcpConnectors.some((id) => typeof id !== 'string')) {
        await failAndExit('"mcpConnectors" must be an array of connector ID strings.');
    }
    // Connector IDs become a URL path segment on the local proxy and the
    // upstream Apify MCP Proxy. Keep them to a safe character set up front.
    const badId = mcpConnectors.find((id) => !CONNECTOR_ID_PATTERN.test(id));
    if (badId !== undefined) {
        await failAndExit(`Invalid connector ID "${badId}" — expected /^[A-Za-z0-9_-]+$/.`);
    }

    // Prompt + Anthropic credentials are only required for the normal agent flow.
    if (!mcpProxyOnly) {
        if (typeof raw.prompt !== 'string' || !raw.prompt.trim()) {
            await failAndExit('Missing required input "prompt" (non-empty string).');
        }
        for (const v of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AGENT_ID'] as const) {
            if (!process.env[v]) await failAndExit(`Missing required env var: ${v}`);
        }
    }

    return {
        mcpProxyOnly,
        prompt: raw.prompt ?? '',
        mcpConnectors,
        apiKey: process.env.ANTHROPIC_API_KEY ?? '',
        templateAgentId: process.env.ANTHROPIC_AGENT_ID ?? '',
        apifyToken: process.env.APIFY_TOKEN!,
        runId: process.env.APIFY_ACTOR_RUN_ID || `local-${Date.now()}`,
    };
}

await Actor.init();

const startedAt = Date.now();
const cleanupRefs: CleanupRefs = {};
let proxyServer: StartedServer | null = null;

// Stop the proxy FIRST so Anthropic's last in-flight calls cannot reach the
// upstream Apify MCP Proxy after we revoke the vault credentials below.
async function cleanupAll(): Promise<void> {
    if (proxyServer) {
        await proxyServer.close().catch((error) => {
            log.warning('Failed to stop MCP proxy server (non-fatal)', { error: (error as Error).message });
        });
    }
    if (process.env.ANTHROPIC_API_KEY && (cleanupRefs.vault || cleanupRefs.agent)) {
        await cleanup(process.env.ANTHROPIC_API_KEY, cleanupRefs, log).catch((error) => {
            log.warning('Cleanup threw unexpectedly (non-fatal)', { error: (error as Error).message });
        });
    }
}

try {
    const inputs = await processInputs();

    if (inputs.mcpProxyOnly) {
        const { apifyToken, mcpConnectors } = inputs;
        const { server, baseUrl } = await startMcpProxy(apifyToken);
        proxyServer = server;

        log.info('mcpProxyOnly=true — Anthropic flow skipped. MCP proxy is up.');
        log.info('Connect with Bearer $APIFY_TOKEN to:');
        if (mcpConnectors.length === 0) {
            log.info(`  ${baseUrl}/<connectorId>   (no mcpConnectors in input)`);
        } else {
            for (const id of mcpConnectors) {
                log.info(`  ${baseUrl}/${id}`);
            }
        }
        log.info('Waiting for shutdown signal (SIGINT / SIGTERM / Apify abort)…');
        await waitForShutdownSignal();
        log.info('Shutdown signal received; stopping proxy.');
    } else {
        await runAgentJob(inputs);
    }

    await cleanupAll();
    await Actor.exit();
} catch (err) {
    const e = err as { message?: string; status?: number; body?: unknown };
    log.error('Actor failed:', { error: e.message, status: e.status, body: e.body });
    await cleanupAll();
    await Actor.fail(e.message ?? 'Actor failed');
}

async function runAgentJob(inputs: ProcessedInputs): Promise<void> {
    const { prompt, mcpConnectors, apiKey, templateAgentId, apifyToken, runId } = inputs;

    let connectorBaseUrl: string | null = null;
    if (mcpConnectors.length > 0) {
        const { server, baseUrl } = await startMcpProxy(apifyToken);
        proxyServer = server;
        connectorBaseUrl = baseUrl;
    }

    const mcpServers: McpServer[] = [
        { type: 'url', name: 'apify', url: 'https://mcp.apify.com/' },
        ...mcpConnectors.map((id) => ({
            type: 'url' as const,
            name: `connector-${id}`,
            url: `${connectorBaseUrl}/${encodeURIComponent(id)}`,
        })),
    ];
    log.info(`MCP servers for this run (${mcpServers.length}):`, {
        urls: mcpServers.map((s) => s.url),
    });

    const agent = await cloneAgentWithDynamicMcp({ apiKey, templateId: templateAgentId, mcpServers, runId });
    cleanupRefs.agent = agent.id;
    log.info(`Cloned Agent ${agent.id} from template ${templateAgentId}`);

    const vault = await createVaultWithCredentials({ apiKey, mcpServers, token: apifyToken, runId });
    cleanupRefs.vault = vault.id;
    log.info(`Vault ${vault.id} ready with ${mcpServers.length} credential(s).`);

    const cacheStore = await Actor.openKeyValueStore('claude-agent-cache');
    let environmentId = (await cacheStore.getValue<string>('environment_id')) ?? null;
    if (environmentId) {
        log.info(`Reusing cached Environment ${environmentId}`);
    } else {
        const env = await createEnvironment(apiKey, 'claude-agent-actor');
        environmentId = env.id;
        await cacheStore.setValue('environment_id', environmentId);
        log.info(`Created and cached new Environment ${environmentId}`);
    }

    const session = await createSession({
        apiKey,
        agentId: agent.id,
        environmentId,
        vaultIds: [vault.id],
        title: `Actor run ${runId}`,
    });
    log.info(`Session ${session.id} created. Sending prompt…`);

    await sendUserMessage(apiKey, session.id, prompt);

    await waitForSessionIdle(apiKey, session.id, {
        timeoutMs: 10 * 60_000,
        intervalMs: 4000,
        initialDelayMs: 5000,
        onTick: (status, secs) => log.info(`… status=${status} elapsed=${secs}s`),
        onEvent: (event) => {
            const line = formatEventForLog(event);
            if (line) log.info(line);
        },
    });
    log.info('Session reached idle. Fetching final answer…');

    const { answer, raw } = await fetchLatestAgentText(apiKey, session.id);
    if (!answer) {
        log.warning('No plain-text answer found in agent.message events.', {
            lastEvent: raw ? { id: raw.id, type: raw.type } : null,
        });
    }

    const result: ActorResult = {
        answer,
        agentId: agent.id,
        sessionId: session.id,
        environmentId,
        durationMs: Date.now() - startedAt,
        finishedAt: new Date().toISOString(),
    };

    await Actor.pushData(result);
    await Actor.setValue('OUTPUT', result);
    log.info(`Done in ${result.durationMs} ms (${answer.length} chars of answer).`);
}
