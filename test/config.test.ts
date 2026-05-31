import { describe, expect, it } from 'vitest';

import { computeDeadlineMs, InputError, processInput } from '../src/config.js';

const fullEnv = {
    ANTHROPIC_API_KEY: 'sk-ant',
    ANTHROPIC_AGENT_ID: 'ag_1',
    ANTHROPIC_ENVIRONMENT_ID: 'env_1',
    APIFY_TOKEN: 'apify_tok',
    APIFY_MCP_PROXY_URL: 'http://10.0.0.1:8012',
    APIFY_CONTAINER_URL: 'https://abc.runs.apify.net',
    ACTOR_WEB_SERVER_PORT: '4321',
    APIFY_ACTOR_RUN_ID: 'run_1',
};

describe('processInput — happy path', () => {
    it('parses a normal run with connectors', () => {
        const cfg = processInput({ prompt: 'hi', mcpConnectors: ['a', 'b'] }, fullEnv);
        expect(cfg.mcpProxyOnly).toBe(false);
        expect(cfg.prompt).toBe('hi');
        expect(cfg.mcpConnectors).toEqual(['a', 'b']);
        expect(cfg.anthropic).toEqual({ apiKey: 'sk-ant', agentId: 'ag_1', environmentId: 'env_1' });
        expect(cfg.apify.webServerPort).toBe(4321);
        expect(cfg.apify.containerUrl).toBe('https://abc.runs.apify.net');
    });

    it('allows empty connectors (agent uses built-in tools)', () => {
        const cfg = processInput({ prompt: 'hi' }, fullEnv);
        expect(cfg.mcpConnectors).toEqual([]);
    });

    it('falls back to ACTOR_WEB_SERVER_URL when APIFY_CONTAINER_URL absent', () => {
        const { APIFY_CONTAINER_URL: _omit, ...rest } = fullEnv;
        const cfg = processInput({ prompt: 'hi', mcpConnectors: ['a'] }, {
            ...rest,
            ACTOR_WEB_SERVER_URL: 'https://fallback.runs.apify.net',
        });
        expect(cfg.apify.containerUrl).toBe('https://fallback.runs.apify.net');
    });
});

describe('processInput — validation', () => {
    it('requires a prompt in normal mode', () => {
        expect(() => processInput({ mcpConnectors: [] }, fullEnv)).toThrow(InputError);
        expect(() => processInput({ prompt: '   ' }, fullEnv)).toThrow(/non-empty/);
    });

    it('rejects non-array connectors', () => {
        expect(() => processInput({ prompt: 'x', mcpConnectors: 'a' }, fullEnv)).toThrow(/must be an array/);
    });

    it('rejects unsafe connector IDs', () => {
        expect(() => processInput({ prompt: 'x', mcpConnectors: ['ok', '../evil'] }, fullEnv)).toThrow(/Invalid connector ID/);
    });

    it('requires Anthropic env vars in normal mode', () => {
        const { ANTHROPIC_AGENT_ID: _omit, ...rest } = fullEnv;
        expect(() => processInput({ prompt: 'x' }, rest)).toThrow(/ANTHROPIC_AGENT_ID/);
    });

    it('requires proxy env vars when connectors are present', () => {
        const { APIFY_MCP_PROXY_URL: _omit, ...rest } = fullEnv;
        expect(() => processInput({ prompt: 'x', mcpConnectors: ['a'] }, rest)).toThrow(/APIFY_MCP_PROXY_URL/);
    });

    it('does NOT require proxy env vars when no connectors', () => {
        const { APIFY_MCP_PROXY_URL: _o1, APIFY_TOKEN: _o2, APIFY_CONTAINER_URL: _o3, ...rest } = fullEnv;
        expect(() => processInput({ prompt: 'x' }, rest)).not.toThrow();
    });
});

describe('processInput — proxy-only debug mode', () => {
    it('skips prompt + anthropic requirements but needs proxy plumbing', () => {
        const env = {
            APIFY_TOKEN: 't',
            APIFY_MCP_PROXY_URL: 'http://10.0.0.1:8012',
            APIFY_CONTAINER_URL: 'https://abc.runs.apify.net',
        };
        const cfg = processInput({ mcpProxyOnly: true, mcpConnectors: ['a'] }, env);
        expect(cfg.mcpProxyOnly).toBe(true);
        expect(cfg.prompt).toBe('');
    });
});

describe('computeDeadlineMs', () => {
    const now = Date.parse('2026-05-31T12:00:00Z');

    it('uses ACTOR_TIMEOUT_AT minus offset', () => {
        const at = new Date(now + 5 * 60_000).toISOString(); // +5 min
        expect(computeDeadlineMs(at, now, 30_000)).toBe(5 * 60_000 - 30_000);
    });

    it('floors at 1s for a near-expired run', () => {
        const at = new Date(now + 5_000).toISOString(); // +5s, offset 30s → negative
        expect(computeDeadlineMs(at, now, 30_000)).toBe(1_000);
    });

    it('falls back when timeoutAt is null or invalid', () => {
        expect(computeDeadlineMs(null, now, 30_000, 99)).toBe(99);
        expect(computeDeadlineMs('not-a-date', now, 30_000, 99)).toBe(99);
    });
});
