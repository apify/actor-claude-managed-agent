/**
 * Thin client for Anthropic's Managed Agents beta API.
 *
 * Only the endpoints this Actor needs at runtime: vaults, sessions, session
 * events, and the SSE event stream. Agent + environment creation lives in
 * `scripts/provision.ts` (developer runs it once), not here.
 *
 * `fetchImpl` and `baseUrl` are injectable so the request building and error
 * handling can be unit tested against a mock without a network.
 */

import type { AgentTool, McpServerDef } from './agent-config.js';

const DEFAULT_BASE = 'https://api.anthropic.com';
const BETA = 'managed-agents-2026-04-01';
const VERSION = '2023-06-01';
const DEFAULT_TIMEOUT_MS = 60_000;

export interface Vault {
    id: string;
    [k: string]: unknown;
}

export interface SessionAgentBlock {
    tools?: AgentTool[];
    mcp_servers?: McpServerDef[];
    [k: string]: unknown;
}

export interface Session {
    id: string;
    status?: string;
    agent?: SessionAgentBlock;
    [k: string]: unknown;
}

export interface ApiError extends Error {
    status?: number;
    body?: unknown;
}

type FetchImpl = typeof globalThis.fetch;

export interface AnthropicClientOptions {
    apiKey: string;
    baseUrl?: string;
    fetchImpl?: FetchImpl;
    requestTimeoutMs?: number;
}

export class AnthropicAgents {
    private readonly apiKey: string;
    private readonly baseUrl: string;
    private readonly fetchImpl: FetchImpl;
    private readonly requestTimeoutMs: number;

    constructor(opts: AnthropicClientOptions) {
        this.apiKey = opts.apiKey;
        this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE).replace(/\/$/, '');
        this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
        this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    }

    private headers(extra?: Record<string, string>): Record<string, string> {
        return {
            'x-api-key': this.apiKey,
            'anthropic-version': VERSION,
            'anthropic-beta': BETA,
            'content-type': 'application/json',
            ...extra,
        };
    }

    private async api<T = unknown>(
        path: string,
        init: { method?: string; body?: unknown } = {},
    ): Promise<T> {
        const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
            method: init.method ?? 'POST',
            headers: this.headers(),
            body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
            signal: AbortSignal.timeout(this.requestTimeoutMs),
        });
        const text = await res.text();
        let parsed: unknown;
        try {
            parsed = text ? JSON.parse(text) : undefined;
        } catch {
            parsed = text;
        }
        if (!res.ok) {
            throw toApiError(init.method ?? 'POST', path, res.status, parsed);
        }
        return parsed as T;
    }

    createVault(displayName: string): Promise<Vault> {
        return this.api<Vault>('/v1/vaults', { body: { display_name: displayName } });
    }

    /** Add a `static_bearer` credential bound to one MCP server URL. */
    addStaticBearerCredential(
        vaultId: string,
        opts: { mcpServerUrl: string; token: string; displayName: string },
    ): Promise<unknown> {
        return this.api(`/v1/vaults/${vaultId}/credentials`, {
            body: {
                display_name: opts.displayName,
                auth: { type: 'static_bearer', mcp_server_url: opts.mcpServerUrl, token: opts.token },
            },
        });
    }

    createSession(opts: {
        agentId: string;
        environmentId: string;
        vaultIds: string[];
        title?: string;
    }): Promise<Session> {
        return this.api<Session>('/v1/sessions', {
            body: {
                agent: opts.agentId,
                environment_id: opts.environmentId,
                vault_ids: opts.vaultIds,
                ...(opts.title ? { title: opts.title } : {}),
            },
        });
    }

    getSession(sessionId: string): Promise<Session> {
        return this.api<Session>(`/v1/sessions/${sessionId}`, { method: 'GET' });
    }

    /** Override the session's agent tools + mcp_servers (full replacement). */
    updateSessionAgent(
        sessionId: string,
        agent: { tools: AgentTool[]; mcp_servers: McpServerDef[] },
    ): Promise<Session> {
        return this.api<Session>(`/v1/sessions/${sessionId}`, { body: { agent } });
    }

    sendUserMessage(sessionId: string, text: string): Promise<unknown> {
        return this.api(`/v1/sessions/${sessionId}/events`, {
            body: { events: [{ type: 'user.message', content: [{ type: 'text', text }] }] },
        });
    }

    /**
     * Open the SSE event stream. Returns the raw Response so the caller can
     * iterate `response.body`. Pass an AbortSignal to enforce the deadline.
     */
    async openEventStream(sessionId: string, signal?: AbortSignal): Promise<Response> {
        const res = await this.fetchImpl(`${this.baseUrl}/v1/sessions/${sessionId}/events/stream`, {
            method: 'GET',
            headers: this.headers({ accept: 'text/event-stream' }),
            signal,
        });
        if (!res.ok || !res.body) {
            const body = await res.text().catch(() => '');
            throw toApiError('GET', `/v1/sessions/${sessionId}/events/stream`, res.status, body);
        }
        return res;
    }

    deleteVault(vaultId: string): Promise<unknown> {
        return this.api(`/v1/vaults/${vaultId}`, { method: 'DELETE' });
    }
}

function toApiError(method: string, path: string, status: number, parsed: unknown): ApiError {
    const message =
        typeof parsed === 'object' && parsed !== null && 'error' in parsed
        && typeof (parsed as { error?: { message?: string } }).error?.message === 'string'
            ? (parsed as { error: { message: string } }).error.message
            : typeof parsed === 'string' && parsed
                ? parsed
                : JSON.stringify(parsed);
    const err: ApiError = new Error(`Anthropic API ${method} ${path} → ${status}: ${message}`);
    err.status = status;
    err.body = parsed;
    return err;
}
