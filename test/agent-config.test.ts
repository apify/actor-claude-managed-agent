import { describe, expect, it } from 'vitest';

import {
    buildMcpServers,
    buildMcpToolsets,
    buildSessionAgentUpdate,
    connectorMcpUrl,
    connectorServerName,
    mergeAgentTools,
} from '../src/agent-config.js';

const BASE = 'https://abc.runs.apify.net/mcp';

describe('connectorMcpUrl', () => {
    it('joins base + id without double slash', () => {
        expect(connectorMcpUrl(BASE, 'conn_1')).toBe('https://abc.runs.apify.net/mcp/conn_1');
        expect(connectorMcpUrl(`${BASE}/`, 'conn_1')).toBe('https://abc.runs.apify.net/mcp/conn_1');
    });
});

describe('buildMcpServers', () => {
    it('builds one url server per connector with matching names', () => {
        const servers = buildMcpServers(['a', 'b'], BASE);
        expect(servers).toEqual([
            { type: 'url', name: 'connector-a', url: `${BASE}/a` },
            { type: 'url', name: 'connector-b', url: `${BASE}/b` },
        ]);
    });

    it('returns empty for no connectors', () => {
        expect(buildMcpServers([], BASE)).toEqual([]);
    });
});

describe('buildMcpToolsets', () => {
    it('always_allow + name matching the server name', () => {
        const [t] = buildMcpToolsets(['x']);
        expect(t).toEqual({
            type: 'mcp_toolset',
            mcp_server_name: connectorServerName('x'),
            default_config: { permission_policy: { type: 'always_allow' } },
        });
    });
});

describe('mergeAgentTools', () => {
    it('preserves non-mcp_toolset tools and replaces mcp_toolset entries', () => {
        const existing = [
            { type: 'agent_toolset_20260401', default_config: { enabled: true } },
            { type: 'mcp_toolset', mcp_server_name: 'stale' },
            { type: 'custom_tool', name: 'my_tool' },
        ];
        const merged = mergeAgentTools(existing, ['a']);
        // agent_toolset + custom_tool preserved, stale mcp_toolset dropped, new one added
        expect(merged).toEqual([
            { type: 'agent_toolset_20260401', default_config: { enabled: true } },
            { type: 'custom_tool', name: 'my_tool' },
            {
                type: 'mcp_toolset',
                mcp_server_name: 'connector-a',
                default_config: { permission_policy: { type: 'always_allow' } },
            },
        ]);
    });

    it('handles undefined existing tools', () => {
        expect(mergeAgentTools(undefined, [])).toEqual([]);
    });
});

describe('buildSessionAgentUpdate', () => {
    it('mcp_server name in tools matches name in mcp_servers (resolvable)', () => {
        const update = buildSessionAgentUpdate([{ type: 'agent_toolset_20260401' }], ['a', 'b'], BASE);
        const serverNames = update.mcp_servers.map((s) => s.name).sort();
        const toolsetNames = update.tools
            .filter((t) => t.type === 'mcp_toolset')
            .map((t) => t.mcp_server_name as string)
            .sort();
        expect(toolsetNames).toEqual(serverNames);
        // built-in toolset preserved
        expect(update.tools.some((t) => t.type === 'agent_toolset_20260401')).toBe(true);
    });
});

describe('byte-match invariant (credential URL vs session mcp_servers URL)', () => {
    it('credential url and session server url are produced identically', () => {
        const id = 'conn_X-1';
        const credentialUrl = connectorMcpUrl(BASE, id);
        const [server] = buildMcpServers([id], BASE);
        expect(server.url).toBe(credentialUrl);
    });
});
