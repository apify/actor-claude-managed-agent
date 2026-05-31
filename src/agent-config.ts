/**
 * Pure helpers that build the per-session agent override we POST to
 * `/v1/sessions/{id}`.
 *
 * The agent the developer created on Anthropic's side has an EMPTY
 * `mcp_servers` list (see PLAN.md). At session time we inject, for each
 * Apify MCP connector the end user picked, one MCP server pointing at this
 * Actor's local `/mcp/<connectorId>` endpoint. The Actor forwards those
 * calls to the internal Apify MCP Proxy.
 *
 * These functions are intentionally pure (no I/O) so they can be unit
 * tested in isolation.
 */

export interface McpServerDef {
    type: 'url';
    name: string;
    url: string;
}

/** Any tool entry on an agent. We only special-case `mcp_toolset`. */
export interface AgentTool {
    type: string;
    [k: string]: unknown;
}

export interface McpToolset extends AgentTool {
    type: 'mcp_toolset';
    mcp_server_name: string;
    default_config: { permission_policy: { type: 'always_allow' } };
}

/**
 * Stable MCP-server name for a connector. Must be identical between the
 * `mcp_servers[].name` and the `mcp_toolset.mcp_server_name` that references
 * it, otherwise the agent can't resolve the toolset to a server.
 */
export function connectorServerName(connectorId: string): string {
    return `connector-${connectorId}`;
}

/**
 * Public URL of this Actor's local proxy endpoint for one connector.
 * `containerMcpBaseUrl` is `${APIFY_CONTAINER_URL}/mcp` (no trailing slash).
 *
 * This string is used in TWO places and MUST match byte-for-byte:
 *   1. the vault credential's `mcp_server_url`
 *   2. the session's `mcp_servers[].url`
 * Build both from this function to guarantee that.
 */
export function connectorMcpUrl(containerMcpBaseUrl: string, connectorId: string): string {
    return `${containerMcpBaseUrl.replace(/\/$/, '')}/${encodeURIComponent(connectorId)}`;
}

/** Build the `mcp_servers` array for the session override. */
export function buildMcpServers(connectorIds: string[], containerMcpBaseUrl: string): McpServerDef[] {
    return connectorIds.map((id) => ({
        type: 'url',
        name: connectorServerName(id),
        url: connectorMcpUrl(containerMcpBaseUrl, id),
    }));
}

/** Build one `mcp_toolset` per connector. Unattended runs → always_allow. */
export function buildMcpToolsets(connectorIds: string[]): McpToolset[] {
    return connectorIds.map((id) => ({
        type: 'mcp_toolset',
        mcp_server_name: connectorServerName(id),
        default_config: { permission_policy: { type: 'always_allow' } },
    }));
}

/**
 * Merge our connector toolsets into the agent's existing tools, replacing
 * only the `mcp_toolset` entries and preserving everything else verbatim
 * (`agent_toolset_*`, skills, custom configs, permission policies).
 */
export function mergeAgentTools(existingTools: AgentTool[] | undefined, connectorIds: string[]): AgentTool[] {
    const preserved = (existingTools ?? []).filter((t) => t?.type !== 'mcp_toolset');
    return [...preserved, ...buildMcpToolsets(connectorIds)];
}

export interface AgentUpdate {
    tools: AgentTool[];
    mcp_servers: McpServerDef[];
}

/**
 * Full session-agent override. `existingTools` comes from GET /v1/sessions/{id}
 * (the agent block inherited at session creation). We replace `mcp_servers`
 * entirely and merge `tools` (see {@link mergeAgentTools}).
 */
export function buildSessionAgentUpdate(
    existingTools: AgentTool[] | undefined,
    connectorIds: string[],
    containerMcpBaseUrl: string,
): AgentUpdate {
    return {
        tools: mergeAgentTools(existingTools, connectorIds),
        mcp_servers: buildMcpServers(connectorIds, containerMcpBaseUrl),
    };
}
