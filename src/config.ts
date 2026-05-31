/**
 * Input + environment validation, and the agent-deadline calculation.
 *
 * `processInput` is pure (takes the raw input object and an env map) so the
 * validation rules can be unit tested without the Apify runtime.
 */

const CONNECTOR_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Thrown on any user-facing validation failure; main.ts maps it to Actor.fail. */
export class InputError extends Error {}

export interface RawInput {
    prompt?: unknown;
    mcpConnectors?: unknown;
    mcpProxyOnly?: unknown;
}

export interface Config {
    mcpProxyOnly: boolean;
    prompt: string;
    mcpConnectors: string[];
    anthropic: { apiKey: string; agentId: string; environmentId: string };
    apify: {
        token: string;
        mcpProxyUrl: string;
        containerUrl: string;
        webServerPort: number;
        runId: string;
    };
    /** ISO timestamp when the Actor run times out, or null if not set. */
    timeoutAt: string | null;
}

type Env = Record<string, string | undefined>;

function requireEnv(env: Env, name: string): string {
    const v = env[name];
    if (!v) throw new InputError(`Missing required environment variable: ${name}`);
    return v;
}

/** Parse a TCP port. Falls back on anything not a positive integer (avoids the `Number(x)||default` falsy-zero trap). */
function parsePort(value: string | undefined, fallback: number): number {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 && n <= 65_535 ? n : fallback;
}

export function processInput(raw: RawInput, env: Env): Config {
    const mcpProxyOnly = raw.mcpProxyOnly === true;

    // mcpConnectors: array of safe id strings.
    const rawConnectors = raw.mcpConnectors ?? [];
    if (!Array.isArray(rawConnectors) || rawConnectors.some((id) => typeof id !== 'string')) {
        throw new InputError('"mcpConnectors" must be an array of connector ID strings.');
    }
    const mcpConnectors = rawConnectors as string[];
    const badId = mcpConnectors.find((id) => !CONNECTOR_ID_PATTERN.test(id));
    if (badId !== undefined) {
        throw new InputError(`Invalid connector ID "${badId}" — expected /^[A-Za-z0-9_-]+$/.`);
    }

    // Prompt required only for the real agent flow.
    const prompt = typeof raw.prompt === 'string' ? raw.prompt : '';
    if (!mcpProxyOnly && !prompt.trim()) {
        throw new InputError('Missing required input "prompt" (non-empty string).');
    }

    // Anthropic creds required only for the real agent flow.
    const anthropic = {
        apiKey: mcpProxyOnly ? (env.ANTHROPIC_API_KEY ?? '') : requireEnv(env, 'ANTHROPIC_API_KEY'),
        agentId: mcpProxyOnly ? (env.ANTHROPIC_AGENT_ID ?? '') : requireEnv(env, 'ANTHROPIC_AGENT_ID'),
        environmentId: mcpProxyOnly
            ? (env.ANTHROPIC_ENVIRONMENT_ID ?? '')
            : requireEnv(env, 'ANTHROPIC_ENVIRONMENT_ID'),
    };

    // Apify proxy plumbing required whenever we will stand up the local proxy
    // (any connectors) or run in proxy-only debug mode.
    const needsProxy = mcpProxyOnly || mcpConnectors.length > 0;
    const apify = {
        token: needsProxy ? requireEnv(env, 'APIFY_TOKEN') : (env.APIFY_TOKEN ?? ''),
        mcpProxyUrl: needsProxy ? requireEnv(env, 'APIFY_MCP_PROXY_URL') : (env.APIFY_MCP_PROXY_URL ?? ''),
        containerUrl: needsProxy
            ? (env.APIFY_CONTAINER_URL ?? env.ACTOR_WEB_SERVER_URL ?? requireEnv(env, 'APIFY_CONTAINER_URL'))
            : (env.APIFY_CONTAINER_URL ?? env.ACTOR_WEB_SERVER_URL ?? ''),
        webServerPort: parsePort(env.ACTOR_WEB_SERVER_PORT, 4321),
        runId: env.APIFY_ACTOR_RUN_ID || `local-${Date.now()}`,
    };

    return {
        mcpProxyOnly,
        prompt,
        mcpConnectors,
        anthropic,
        apify,
        timeoutAt: env.ACTOR_TIMEOUT_AT ?? null,
    };
}

/**
 * Milliseconds from `now` until the agent's hard deadline.
 *
 * We give the agent the Actor's own run deadline minus an offset reserved for
 * pushing datasets + deleting the vault before Apify hard-kills the container.
 * Falls back to `fallbackMs` when `ACTOR_TIMEOUT_AT` is unset/invalid, and
 * never returns less than 1s (so a near-expired run still makes one attempt).
 */
export function computeDeadlineMs(
    timeoutAt: string | null,
    now: number,
    offsetMs = 30_000,
    fallbackMs = 10 * 60_000,
): number {
    // Clamp to the setTimeout 32-bit max so a far-future/garbage deadline can't
    // overflow and fire immediately.
    const MAX_TIMER_MS = 2_147_483_647;
    if (!timeoutAt) return Math.min(fallbackMs, MAX_TIMER_MS);
    const at = Date.parse(timeoutAt);
    if (Number.isNaN(at)) return Math.min(fallbackMs, MAX_TIMER_MS);
    return Math.min(MAX_TIMER_MS, Math.max(1_000, at - now - offsetMs));
}
