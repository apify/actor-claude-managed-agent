/**
 * Apify Actor entrypoint — thin wrapper over a Claude Managed Agent.
 *
 * Normal mode (per run):
 *   1. Validate input + env.
 *   2. If MCP connectors were picked, start the local /mcp proxy (server.ts):
 *      Anthropic's agent reaches it at `${APIFY_CONTAINER_URL}/mcp/<id>` and it
 *      forwards to the internal Apify MCP Proxy.
 *   3. Run the agent session (run.ts): vault → session → mcp override → stream.
 *   4. Push the answer (default dataset) + full transcript (debug dataset).
 *   5. Cleanup: stop the proxy, delete the vault.
 *
 * Debug mode (`mcpProxyOnly: true`): boot only the local proxy and block, so
 * an external MCP client can be pointed at the container URL.
 */

import { Actor, log } from 'apify';

import { AnthropicAgents } from './anthropic.js';
import { type Config, InputError, processInput, type RawInput } from './config.js';
import { errorCodeFor, executeAgentRun, type RunRefs } from './run.js';
import type { SessionStreamEvent } from './sse.js';
import { startServer, type StartedServer } from './server.js';

const startedAt = Date.now();
let proxyServer: StartedServer | null = null;
let anthropic: AnthropicAgents | null = null;
const refs: RunRefs = { vaultId: null, sessionId: null };

/** Stop the proxy FIRST so no in-flight agent call reaches upstream after we revoke the vault. */
async function cleanup(): Promise<void> {
    if (proxyServer) {
        await proxyServer.close().catch((e) => log.warning('Proxy close failed (non-fatal)', { error: (e as Error).message }));
        proxyServer = null;
    }
    if (anthropic && refs.vaultId) {
        await anthropic.deleteVault(refs.vaultId).catch((e) => log.warning('Vault delete failed (non-fatal)', { error: (e as Error).message }));
        refs.vaultId = null;
    }
}

async function writeDebug(events: SessionStreamEvent[]): Promise<void> {
    if (events.length === 0) return;
    const debug = await Actor.openDataset('debug');
    await debug.pushData(
        events.map((e) => ({ type: e.type ?? null, processedAt: e.processed_at ?? null, event: e })),
    );
}

async function runProxyOnly(cfg: Config): Promise<void> {
    proxyServer = await startServer({
        serverPort: cfg.apify.webServerPort,
        apifyMcpProxyBaseUrl: cfg.apify.mcpProxyUrl,
        apifyToken: cfg.apify.token,
    });
    const base = `${cfg.apify.containerUrl.replace(/\/$/, '')}/mcp`;
    log.info('mcpProxyOnly=true — Claude flow skipped. Local MCP proxy is up.');
    log.info('Connect with Bearer $APIFY_TOKEN to:');
    if (cfg.mcpConnectors.length === 0) log.info(`  ${base}/<connectorId>`);
    for (const id of cfg.mcpConnectors) log.info(`  ${base}/${id}`);

    await new Promise<void>((resolve) => {
        const stop = () => resolve();
        Actor.on('aborting', stop);
        Actor.on('migrating', stop);
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
    });
}

async function runAgent(cfg: Config): Promise<void> {
    const { mcpConnectors, anthropic: an, apify } = cfg;
    const containerMcpBaseUrl = `${apify.containerUrl.replace(/\/$/, '')}/mcp`;

    anthropic = new AnthropicAgents({ apiKey: an.apiKey, baseUrl: process.env.ANTHROPIC_BASE_URL });

    // Local proxy is only needed when the agent will actually call connectors.
    if (mcpConnectors.length > 0) {
        proxyServer = await startServer({
            serverPort: apify.webServerPort,
            apifyMcpProxyBaseUrl: apify.mcpProxyUrl,
            apifyToken: apify.token,
        });
    }

    const result = await executeAgentRun(
        {
            client: anthropic,
            prompt: cfg.prompt,
            connectorIds: mcpConnectors,
            agentId: an.agentId,
            environmentId: an.environmentId,
            runId: apify.runId,
            containerMcpBaseUrl,
            apifyToken: apify.token,
            timeoutAt: cfg.timeoutAt,
            log: (msg) => log.info(msg),
        },
        refs,
    );

    const error = errorCodeFor(result.outcome);
    const row = {
        prompt: cfg.prompt,
        answer: result.answer,
        sessionId: result.sessionId,
        error,
        errorMessage: result.errorMessage,
        partial: error !== null && result.answer.length > 0,
        durationMs: Date.now() - startedAt,
        finishedAt: new Date().toISOString(),
    };

    await writeDebug(result.events);
    await Actor.pushData(row);
    await Actor.setValue('OUTPUT', row);

    if (error) {
        throw new Error(`Agent run ended abnormally: ${error}${result.errorMessage ? ` (${result.errorMessage})` : ''}`);
    }
    log.info(`Done in ${row.durationMs} ms (${result.answer.length} chars).`);
}

await Actor.init();
try {
    const cfg = processInput(((await Actor.getInput<RawInput>()) ?? {}) as RawInput, process.env);
    if (cfg.mcpProxyOnly) await runProxyOnly(cfg);
    else await runAgent(cfg);
    await cleanup();
    await Actor.exit();
} catch (err) {
    const e = err as { message?: string; status?: number; body?: unknown };
    await cleanup();
    if (err instanceof InputError) log.error(`Invalid input: ${e.message}`);
    else log.error('Actor failed', { error: e.message, status: e.status, body: e.body });
    await Actor.fail(e.message ?? 'Actor failed');
}
