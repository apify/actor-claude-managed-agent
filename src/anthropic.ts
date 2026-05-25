/**
 * Thin wrapper around Anthropic's Managed Agents beta API.
 *
 * Zero-dependency: uses global fetch shipped with Node 18+.
 *
 * Exported helpers map 1:1 to the Actor's runtime flow:
 *   cloneAgentWithDynamicMcp   → POST /v1/agents (cloned from template)
 *   createVaultWithCredentials → POST /v1/vaults + N credentials
 *   createEnvironment          → POST /v1/environments
 *   createSession              → POST /v1/sessions
 *   sendUserMessage            → POST /v1/sessions/{id}/events
 *   waitForSessionIdle         → poll GET /v1/sessions/{id} (with initial settle delay)
 *   fetchLatestAgentText       → GET /v1/sessions/{id}/events + extract text
 *   cleanup                    → DELETE vault + POST /v1/agents/{id}/archive
 */

import { extractTextFromEvent, type SessionEvent } from './extract.js';

const BASE = 'https://api.anthropic.com';
const BETA = 'managed-agents-2026-04-01';
const VERSION = '2023-06-01';

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

export interface McpServer {
    type: 'url';
    name: string;
    url: string;
}

interface PermissionPolicy {
    type: 'always_allow' | 'always_ask';
}

interface ToolDefaultConfig {
    enabled?: boolean;
    permission_policy?: PermissionPolicy;
}

export interface McpToolset {
    type: 'mcp_toolset';
    mcp_server_name: string;
    configs?: unknown[];
    default_config?: ToolDefaultConfig;
}

export interface AgentToolset {
    type: 'agent_toolset_20260401';
    configs?: unknown[];
    default_config?: ToolDefaultConfig;
}

export type AgentTool =
    | McpToolset
    | AgentToolset
    | { type: string; [k: string]: unknown };

export interface AnthropicModel {
    id: string;
    speed?: string;
}

export interface AnthropicAgent {
    id: string;
    name: string;
    description: string | null;
    metadata: Record<string, unknown>;
    model: AnthropicModel;
    multiagent: unknown;
    skills: unknown[];
    system: string;
    mcp_servers: McpServer[];
    tools: AgentTool[];
}

export interface AnthropicVault {
    id: string;
    display_name?: string;
}

export interface AnthropicEnvironment {
    id: string;
    name?: string;
}

export type SessionStatus = 'idle' | 'running' | 'paused' | 'error' | 'rescheduling' | string;

export interface AnthropicSession {
    id: string;
    status: SessionStatus;
    title?: string;
}

interface EventsListResponse {
    data: SessionEvent[];
}

export interface CleanupRefs {
    agent?: string;
    vault?: string;
}

interface ApifyLogger {
    warning?: (msg: string, data?: Record<string, unknown>) => void;
}

interface ApiError extends Error {
    status?: number;
    body?: unknown;
}

interface RequestOptions {
    method?: 'GET' | 'POST' | 'DELETE' | 'PATCH';
    body?: unknown;
    /** Per-request timeout. Default {@link API_REQUEST_TIMEOUT_MS}. */
    timeoutMs?: number;
}

const API_REQUEST_TIMEOUT_MS = 60_000;

// ────────────────────────────────────────────────────────────────────────────
// Internal
// ────────────────────────────────────────────────────────────────────────────

async function api<T = unknown>(
    apiKey: string,
    path: string,
    { method = 'POST', body, timeoutMs = API_REQUEST_TIMEOUT_MS }: RequestOptions = {},
): Promise<T> {
    const res = await fetch(`${BASE}${path}`, {
        method,
        headers: {
            'x-api-key': apiKey,
            'anthropic-version': VERSION,
            'anthropic-beta': BETA,
            'content-type': 'application/json',
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { parsed = text; }

    if (!res.ok) {
        const msg =
            typeof parsed === 'object'
            && parsed !== null
            && 'error' in parsed
            && typeof (parsed as { error?: { message?: string } }).error?.message === 'string'
                ? (parsed as { error: { message: string } }).error.message
                : typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
        const err: ApiError = new Error(`Anthropic API ${method} ${path} → ${res.status}: ${msg}`);
        err.status = res.status;
        err.body = parsed;
        throw err;
    }
    return parsed as T;
}

function buildMcpToolsets(mcpServers: McpServer[]): McpToolset[] {
    return mcpServers.map((s) => ({
        type: 'mcp_toolset',
        mcp_server_name: s.name,
        default_config: { permission_policy: { type: 'always_allow' } },
    }));
}

// ────────────────────────────────────────────────────────────────────────────
// Exports
// ────────────────────────────────────────────────────────────────────────────

export interface CloneAgentOptions {
    apiKey: string;
    templateId: string;
    mcpServers: McpServer[];
    runId: string;
}

/**
 * Fetch the developer's template Agent and create a fresh clone whose
 * `mcp_servers` list is replaced with the per-run list. The writeable-field
 * whitelist below (description, metadata, model, multiagent, skills, system,
 * tools) was confirmed against the live API by round-tripping a template.
 */
export async function cloneAgentWithDynamicMcp(opts: CloneAgentOptions): Promise<AnthropicAgent> {
    const { apiKey, templateId, mcpServers, runId } = opts;
    const template = await api<AnthropicAgent>(apiKey, `/v1/agents/${templateId}`, { method: 'GET' });

    const { description, metadata, model, multiagent, skills, system, tools } = template;
    // The template's mcp_toolset entries reference old server names — drop them
    const nonMcpTools = (tools || []).filter((t) => t.type !== 'mcp_toolset');

    return api<AnthropicAgent>(apiKey, '/v1/agents', {
        body: {
            name: `${template.name} — run ${runId}`,
            description,
            metadata,
            model,
            multiagent,
            skills,
            system,
            mcp_servers: mcpServers,
            tools: [...nonMcpTools, ...buildMcpToolsets(mcpServers)],
        },
    });
}

export interface CreateVaultOptions {
    apiKey: string;
    mcpServers: McpServer[];
    token: string;
    runId: string;
}

/**
 * Create a vault and add one static_bearer credential per MCP server.
 * All credentials share the same bearer token (typically APIFY_TOKEN).
 */
export async function createVaultWithCredentials(opts: CreateVaultOptions): Promise<AnthropicVault> {
    const { apiKey, mcpServers, token, runId } = opts;
    const vault = await api<AnthropicVault>(apiKey, '/v1/vaults', {
        body: { display_name: `actor-run-${runId}` },
    });

    await Promise.all(mcpServers.map((server) => api(
        apiKey,
        `/v1/vaults/${vault.id}/credentials`,
        {
            body: {
                display_name: `cred-${server.name}`,
                auth: {
                    type: 'static_bearer',
                    mcp_server_url: server.url,
                    token,
                },
            },
        },
    )));
    return vault;
}

export async function createEnvironment(apiKey: string, name: string): Promise<AnthropicEnvironment> {
    return api<AnthropicEnvironment>(apiKey, '/v1/environments', {
        body: {
            name,
            config: { type: 'cloud', networking: { type: 'unrestricted' } },
        },
    });
}

export interface CreateSessionOptions {
    apiKey: string;
    agentId: string;
    environmentId: string;
    vaultIds: string[];
    title: string;
}

export async function createSession(opts: CreateSessionOptions): Promise<AnthropicSession> {
    const { apiKey, agentId, environmentId, vaultIds, title } = opts;
    return api<AnthropicSession>(apiKey, '/v1/sessions', {
        body: {
            agent: agentId,
            environment_id: environmentId,
            title,
            vault_ids: vaultIds,
        },
    });
}

export async function sendUserMessage(apiKey: string, sessionId: string, text: string): Promise<unknown> {
    return api(apiKey, `/v1/sessions/${sessionId}/events`, {
        body: {
            events: [{ type: 'user.message', content: [{ type: 'text', text }] }],
        },
    });
}

export interface WaitOptions {
    /** Hard ceiling for the whole wait. Default 5 min. */
    timeoutMs?: number;
    /** Poll interval after the initial delay. Default 4s. */
    intervalMs?: number;
    /**
     * Sleep before the first poll. Required to avoid a race where the session
     * is briefly `idle` right after creation (before the platform processes
     * the user.message we just sent). Default 5s.
     */
    initialDelayMs?: number;
    onTick?: (status: SessionStatus, elapsedSeconds: number) => void;
    /**
     * Called for every new event observed during polling (tool calls,
     * assistant messages, etc.). Use this to surface agent progress in logs.
     */
    onEvent?: (event: SessionEvent) => void;
}

const EVENTS_FETCH_LIMIT = 100;

/** Poll session status until idle or error. Throws on timeout. */
export async function waitForSessionIdle(
    apiKey: string,
    sessionId: string,
    opts: WaitOptions = {},
): Promise<AnthropicSession> {
    const {
        timeoutMs = 5 * 60_000,
        intervalMs = 4000,
        initialDelayMs = 5000,
        onTick = () => {},
        onEvent = () => {},
    } = opts;
    const started = Date.now();
    // Dedupe by event ID. The `created_at[gt]` filter is unreliable, so we
    // fetch the most recent batch each tick and emit only IDs we haven't seen.
    const emittedEventIds = new Set<string>();

    if (initialDelayMs > 0) {
        await new Promise((r) => setTimeout(r, initialDelayMs));
    }

    while (true) {
        const params = new URLSearchParams({
            order: 'desc',
            limit: String(EVENTS_FETCH_LIMIT),
        });
        const events = await api<EventsListResponse>(
            apiKey,
            `/v1/sessions/${sessionId}/events?${params.toString()}`,
            { method: 'GET' },
        );
        // Reverse to chronological so callers see events in the order they occurred.
        const chronological = (events.data ?? []).slice().reverse();
        for (const event of chronological) {
            if (emittedEventIds.has(event.id)) continue;
            emittedEventIds.add(event.id);
            onEvent(event);
        }

        const sess = await api<AnthropicSession>(apiKey, `/v1/sessions/${sessionId}`, { method: 'GET' });
        const elapsed = Math.round((Date.now() - started) / 1000);
        onTick(sess.status, elapsed);
        if (sess.status === 'idle') return sess;
        if (sess.status === 'error') throw new Error(`Session ${sessionId} entered error state`);
        if (Date.now() - started > timeoutMs) {
            throw new Error(`Session ${sessionId} did not finish within ${timeoutMs}ms (last status: ${sess.status})`);
        }
        await new Promise((r) => setTimeout(r, intervalMs));
    }
}

export interface FinalText {
    answer: string;
    raw: SessionEvent | null;
}

/**
 * Fetch the most recent agent.message events and pull out the assistant text.
 * Returns { answer, raw } — raw is the event we sourced the text from (or null).
 */
export async function fetchLatestAgentText(apiKey: string, sessionId: string): Promise<FinalText> {
    const events = await api<EventsListResponse>(
        apiKey,
        `/v1/sessions/${sessionId}/events?order=desc&limit=50`,
        { method: 'GET' },
    );
    const msgEvents = (events.data || []).filter((e) => e.type === 'agent.message');
    for (const e of msgEvents) {
        const text = extractTextFromEvent(e);
        if (text) return { answer: text, raw: e };
    }
    return { answer: '', raw: msgEvents[0] ?? null };
}

/**
 * Best-effort cleanup. Anthropic doesn't support agent deletion — agents
 * are archived via POST /v1/agents/{id}/archive. Vaults can be DELETEd
 * normally. Errors are collected and reported via the logger but never
 * rethrown, since cleanup runs in a `finally` block.
 */
export async function cleanup(apiKey: string, refs: CleanupRefs, logger?: ApifyLogger): Promise<void> {
    const errors: { what: string; id: string; error: string }[] = [];

    if (refs.vault) {
        try {
            await api(apiKey, `/v1/vaults/${refs.vault}`, { method: 'DELETE' });
        } catch (error) {
            errors.push({ what: 'vault', id: refs.vault, error: (error as Error).message });
        }
    }
    if (refs.agent) {
        try {
            await api(apiKey, `/v1/agents/${refs.agent}/archive`, { method: 'POST' });
        } catch (error) {
            errors.push({ what: 'agent', id: refs.agent, error: (error as Error).message });
        }
    }
    if (errors.length && logger?.warning) {
        logger.warning('Cleanup completed with errors (non-fatal)', { errors });
    }
}
