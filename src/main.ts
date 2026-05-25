/**
 * Apify Actor entrypoint.
 *
 * Flow:
 *   1. Validate input + required env vars.
 *   2. If any MCP Connectors were requested, start a local MCP proxy on the
 *      Actor's web server port. The proxy is reachable from Anthropic's cloud
 *      at `${CONTAINER_URL}/mcp/<connectorId>` (Bearer APIFY_TOKEN) and
 *      forwards to `${APIFY_MCP_PROXY_URL}/<connectorId>`.
 *   3. Build the per-run MCP server list:
 *        - https://mcp.apify.com/ (always — passed directly to Anthropic)
 *        - ${CONTAINER_URL}/mcp/<id> for each requested connector
 *   4. Clone the developer's template Agent, overriding mcp_servers.
 *   5. Create a vault + one static_bearer credential per MCP URL (APIFY_TOKEN).
 *   6. Reuse a cached Environment (per-Actor named KV store) or create one.
 *   7. Create a Session, send the user prompt, poll until idle.
 *   8. Fetch the final agent text, push to Dataset + KV OUTPUT.
 *   9. Cleanup: delete the vault, archive the cloned Agent, stop the proxy.
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
}

interface ProcessedInputs {
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
 * Reads + validates Actor input and developer env vars. Fails fast (via
 * `Actor.fail`) on any user-facing error so the run shows a clear status
 * message in the Console. Apify-injected env vars are trusted as present.
 */
async function processInputs(): Promise<ProcessedInputs> {
    const raw = ((await Actor.getInput<ActorInput>()) ?? {}) as Partial<ActorInput>;

    if (typeof raw.prompt !== 'string' || !raw.prompt.trim()) {
        await failAndExit('Missing required input "prompt" (non-empty string).');
    }
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

    // Anthropic credentials are developer-provided (not Apify-managed) — verify them.
    for (const v of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AGENT_ID'] as const) {
        if (!process.env[v]) await failAndExit(`Missing required env var: ${v}`);
    }

    return {
        prompt: raw.prompt!,
        mcpConnectors,
        apiKey: process.env.ANTHROPIC_API_KEY!,
        templateAgentId: process.env.ANTHROPIC_AGENT_ID!,
        apifyToken: process.env.APIFY_TOKEN!,
        runId: process.env.APIFY_ACTOR_RUN_ID || `local-${Date.now()}`,
    };
}

await Actor.init();

const startedAt = Date.now();
const cleanupRefs: CleanupRefs = {};
let proxyServer: StartedServer | null = null;

try {
    const { prompt, mcpConnectors, apiKey, templateAgentId, apifyToken, runId } = await processInputs();

    let connectorBaseUrl: string | null = null;
    if (mcpConnectors.length > 0) {
        const apifyMcpProxyBaseUrl = process.env.APIFY_MCP_PROXY_URL!;
        const containerUrl = process.env.APIFY_CONTAINER_URL!;
        const serverPort = Number(process.env.ACTOR_WEB_SERVER_PORT);

        proxyServer = await startServer({ serverPort, apifyMcpProxyBaseUrl, apifyToken });
        connectorBaseUrl = `${containerUrl.replace(/\/$/, '')}/mcp`;
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
} catch (err) {
    const e = err as { message?: string; status?: number; body?: unknown };
    log.error('Actor failed:', { error: e.message, status: e.status, body: e.body });
    exitCode = 1;
    // Surface the failure reason on the run's status line in Apify Console.
    await Actor.exit(e.message ?? 'Actor failed', { exitCode: 1 });
} finally {
    // Stop the proxy FIRST so Anthropic's last in-flight calls cannot reach
    // the upstream Apify MCP Proxy after we revoke the vault credentials
    // below.
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
    await Actor.exit( 'Actor finished');
}
