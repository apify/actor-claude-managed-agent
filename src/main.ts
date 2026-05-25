/**
 * Apify Actor entrypoint.
 *
 * Flow:
 *   1. Validate input + required env vars.
 *   2. Build the per-run MCP server list:
 *        - https://mcp.apify.com/ (always)
 *        - https://connectors-proxy.apify.run/?name=<id> for each requested connector
 *   3. Clone the developer's template Agent, overriding mcp_servers.
 *   4. Create a vault + one static_bearer credential per MCP URL (all using APIFY_TOKEN).
 *   5. Reuse a cached Environment (per-Actor named KV store) or create one.
 *   6. Create a Session, send the user prompt, poll until idle.
 *   7. Fetch the final agent text, push to Dataset + KV OUTPUT.
 *   8. Cleanup: delete the vault and archive the cloned Agent.
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

const LOG_TEXT_PREVIEW_CHARS = 400;

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

interface ActorResult {
    answer: string;
    agentId: string;
    sessionId: string;
    environmentId: string;
    durationMs: number;
    finishedAt: string;
}

await Actor.init();

const startedAt = Date.now();
const cleanupRefs: CleanupRefs = {};

try {
    // ── 1. Inputs + env ──────────────────────────────────────────────────
    const input = ((await Actor.getInput<ActorInput>()) ?? {}) as Partial<ActorInput>;
    const { prompt, mcpConnectors = [] } = input;

    if (typeof prompt !== 'string' || !prompt.trim()) {
        throw new Error('Missing required input "prompt" (non-empty string).');
    }
    if (!Array.isArray(mcpConnectors) || mcpConnectors.some((id) => typeof id !== 'string')) {
        throw new Error('"mcpConnectors" must be an array of connector ID strings.');
    }

    const required = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AGENT_ID', 'APIFY_TOKEN'] as const;
    for (const v of required) {
        if (!process.env[v]) throw new Error(`Missing required env var: ${v}`);
    }
    const apiKey = process.env.ANTHROPIC_API_KEY!;
    const templateAgentId = process.env.ANTHROPIC_AGENT_ID!;
    const apifyToken = process.env.APIFY_TOKEN!;
    const runId = process.env.APIFY_ACTOR_RUN_ID || `local-${Date.now()}`;

    // ── 2. Build per-run MCP servers ─────────────────────────────────────
    const mcpServers: McpServer[] = [
        { type: 'url', name: 'apify', url: 'https://mcp.apify.com/' },
        ...mcpConnectors.map((id) => ({
            type: 'url' as const,
            name: `connector-${id}`,
            url: `https://connectors-proxy.apify.run/?name=${encodeURIComponent(id)}`,
        })),
    ];
    log.info(`MCP servers for this run (${mcpServers.length}):`, {
        urls: mcpServers.map((s) => s.url),
    });

    // ── 3. Clone template Agent ──────────────────────────────────────────
    const agent = await cloneAgentWithDynamicMcp({ apiKey, templateId: templateAgentId, mcpServers, runId });
    cleanupRefs.agent = agent.id;
    log.info(`Cloned Agent ${agent.id} from template ${templateAgentId}`);

    // ── 4. Vault + credentials ───────────────────────────────────────────
    const vault = await createVaultWithCredentials({ apiKey, mcpServers, token: apifyToken, runId });
    cleanupRefs.vault = vault.id;
    log.info(`Vault ${vault.id} ready with ${mcpServers.length} credential(s).`);

    // ── 5. Environment (cached across runs) ──────────────────────────────
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

    // ── 6. Session + prompt + wait ───────────────────────────────────────
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

    // ── 7. Final answer ──────────────────────────────────────────────────
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
    throw err;
} finally {
    if (process.env.ANTHROPIC_API_KEY && (cleanupRefs.vault || cleanupRefs.agent)) {
        await cleanup(process.env.ANTHROPIC_API_KEY, cleanupRefs, log).catch((error) => {
            log.warning('Cleanup threw unexpectedly (non-fatal)', { error: (error as Error).message });
        });
    }
    await Actor.exit();
}
