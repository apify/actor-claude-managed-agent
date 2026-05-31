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
import { type Config, computeDeadlineMs, InputError, processInput, type RawInput } from './config.js';
import { errorCodeFor, executeAgentRun, type RunRefs } from './run.js';
import { finalAnswerText, type SessionStreamEvent } from './sse.js';
import { startServer, type StartedServer } from './server.js';

const startedAt = Date.now();
let proxyServer: StartedServer | null = null;
let anthropic: AnthropicAgents | null = null;
const refs: RunRefs = { vaultId: null, sessionId: null, events: [] };

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

function buildRow(prompt: string, sessionId: string | null, answer: string, error: string | null, errorMessage: string | null): Record<string, unknown> {
    return {
        prompt,
        answer,
        sessionId: sessionId ?? null,
        error,
        errorMessage: errorMessage ?? null,
        partial: error !== null && answer.length > 0,
        durationMs: Date.now() - startedAt,
        finishedAt: new Date().toISOString(),
    };
}

/** Best-effort: a failure here must never sink the primary answer row. */
async function writeDebug(events: SessionStreamEvent[]): Promise<void> {
    if (events.length === 0) return;
    try {
        const debug = await Actor.openDataset('debug');
        await debug.pushData(events.map((e) => ({ type: e.type ?? null, processedAt: e.processed_at ?? null, event: e })));
    } catch (e) {
        log.warning('Failed to write debug dataset (non-fatal)', { error: (e as Error).message });
    }
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

/** Runs the agent flow, always writing one default-dataset row. Returns the error code (null on success). */
async function runAgent(cfg: Config): Promise<string | null> {
    const { mcpConnectors, anthropic: an, apify } = cfg;
    const containerMcpBaseUrl = `${apify.containerUrl.replace(/\/$/, '')}/mcp`;

    anthropic = new AnthropicAgents({ apiKey: an.apiKey, baseUrl: process.env.ANTHROPIC_BASE_URL || undefined });

    // Local proxy is only needed when the agent will actually call connectors.
    // Give upstream tool calls the run's remaining budget instead of the SDK's 60s default.
    if (mcpConnectors.length > 0) {
        proxyServer = await startServer({
            serverPort: apify.webServerPort,
            apifyMcpProxyBaseUrl: apify.mcpProxyUrl,
            apifyToken: apify.token,
            upstreamRequestTimeoutMs: computeDeadlineMs(cfg.timeoutAt, Date.now()),
        });
    }

    let error: string | null;
    let row: Record<string, unknown>;
    try {
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
        error = errorCodeFor(result.outcome);
        row = buildRow(cfg.prompt, result.sessionId, result.answer, error, error ? result.errorMessage : null);
    } catch (runErr) {
        // Any throw before completion (vault/session creation, an unexpected
        // stream-open failure, etc.). Still emit a row so the dataset always
        // reflects the run's fate, with whatever partial answer we captured.
        error = 'setup_failed';
        const message = (runErr as Error)?.message ?? String(runErr);
        log.error('Run failed before completion', { error: message });
        row = buildRow(cfg.prompt, refs.sessionId, finalAnswerText(refs.events), error, message);
    }

    // Primary output first; the debug transcript is best-effort and must never
    // prevent the answer/OUTPUT from being written.
    await Actor.pushData(row);
    await Actor.setValue('OUTPUT', row);
    await writeDebug(refs.events);

    if (error) log.warning(`Run ended with error "${error}" (${row.errorMessage ?? 'no detail'}).`);
    else log.info(`Done in ${row.durationMs} ms (${String(row.answer).length} chars).`);
    return error;
}

await Actor.init();
try {
    const cfg = processInput(((await Actor.getInput<RawInput>()) ?? {}) as RawInput, process.env);
    if (cfg.mcpProxyOnly) {
        await runProxyOnly(cfg);
        await cleanup();
        await Actor.exit();
    } else {
        const error = await runAgent(cfg);
        await cleanup();
        if (error) await Actor.fail(`Agent run ended abnormally: ${error}`);
        else await Actor.exit();
    }
} catch (err) {
    // InputError, or an unexpected failure outside the agent flow (proxy start,
    // dataset push). runAgent already writes a row for in-flow failures.
    await cleanup();
    const message = (err as Error)?.message ?? 'Actor failed';
    if (err instanceof InputError) log.error(`Invalid input: ${message}`);
    else log.error('Actor failed', { error: message, status: (err as { status?: number }).status });
    await Actor.fail(message);
}
