/**
 * Core agent-run orchestration, independent of the Apify runtime so it can be
 * tested against a mock Anthropic API.
 *
 * Sequence (per PLAN.md): create vault (+ one credential per connector) →
 * create session → override the session's mcp_servers/tools → open the SSE
 * stream → send the prompt → consume events until terminal/deadline.
 */

import type { AnthropicAgents } from './anthropic.js';
import { buildSessionAgentUpdate, connectorMcpUrl, connectorServerName } from './agent-config.js';
import { computeDeadlineMs } from './config.js';
import {
    agentMessageText,
    consumeSessionStream,
    lastAgentMessageText,
    readableToAsyncIterable,
    type SessionStreamEvent,
    type StreamOutcome,
} from './sse.js';

export interface RunRefs {
    /** Set as soon as the vault exists so the caller can delete it even on failure. */
    vaultId: string | null;
    sessionId: string | null;
}

export interface RunParams {
    client: AnthropicAgents;
    prompt: string;
    connectorIds: string[];
    agentId: string;
    environmentId: string;
    runId: string;
    /** `${APIFY_CONTAINER_URL}/mcp` */
    containerMcpBaseUrl: string;
    apifyToken: string;
    timeoutAt: string | null;
    now?: () => number;
    log?: (msg: string) => void;
    onEvent?: (event: SessionStreamEvent) => void;
}

export interface RunResult {
    outcome: StreamOutcome;
    answer: string;
    errorMessage: string | null;
    events: SessionStreamEvent[];
    sessionId: string;
}

export async function executeAgentRun(params: RunParams, refs: RunRefs): Promise<RunResult> {
    const {
        client, prompt, connectorIds, agentId, environmentId, runId,
        containerMcpBaseUrl, apifyToken, timeoutAt,
    } = params;
    const now = params.now ?? Date.now;
    const log = params.log ?? (() => {});

    // 1. Vault + one static_bearer credential per connector.
    const vaultIds: string[] = [];
    if (connectorIds.length > 0) {
        const vault = await client.createVault(`actor-run-${runId}`);
        refs.vaultId = vault.id;
        vaultIds.push(vault.id);
        for (const id of connectorIds) {
            await client.addStaticBearerCredential(vault.id, {
                displayName: connectorServerName(id),
                mcpServerUrl: connectorMcpUrl(containerMcpBaseUrl, id),
                token: apifyToken,
            });
        }
        log(`Vault ${vault.id} ready with ${connectorIds.length} connector credential(s).`);
    }

    // 2. Session.
    const session = await client.createSession({ agentId, environmentId, vaultIds, title: `Actor run ${runId}` });
    refs.sessionId = session.id;
    log(`Session ${session.id} created.`);

    // 3. Override mcp_servers/tools (preserve non-MCP tools).
    if (connectorIds.length > 0) {
        const detail = await client.getSession(session.id);
        const update = buildSessionAgentUpdate(detail.agent?.tools, connectorIds, containerMcpBaseUrl);
        await client.updateSessionAgent(session.id, update);
        log(`Session MCP servers set: ${update.mcp_servers.map((s) => s.name).join(', ')}`);
    }

    // 4. Stream BEFORE sending the prompt (only post-open events are delivered).
    const deadlineMs = computeDeadlineMs(timeoutAt, now());
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deadlineMs);
    log(`Agent deadline in ${Math.round(deadlineMs / 1000)}s.`);

    const events: SessionStreamEvent[] = [];
    try {
        const stream = await client.openEventStream(session.id, controller.signal);
        await client.sendUserMessage(session.id, prompt);
        const result = await consumeSessionStream(
            readableToAsyncIterable(stream.body as ReadableStream<Uint8Array>),
            (ev) => {
                events.push(ev);
                params.onEvent?.(ev);
                const text = agentMessageText(ev);
                if (text) log(`💬 ${text.replace(/\s+/g, ' ').trim().slice(0, 300)}`);
                else if (ev.type) log(`· ${ev.type}`);
            },
            controller.signal,
        );
        return {
            outcome: result.outcome,
            answer: lastAgentMessageText(events),
            errorMessage: result.errorMessage,
            events,
            sessionId: session.id,
        };
    } finally {
        clearTimeout(timer);
    }
}

export function errorCodeFor(outcome: StreamOutcome): string | null {
    switch (outcome) {
        case 'idle': return null;
        case 'terminated': return 'session_terminated';
        case 'timeout': return 'timeout';
        case 'stream_dropped': return 'stream_dropped';
        default: return 'unknown';
    }
}
