# Spikes — pre-implementation validation

Two throwaway scripts that test the riskiest assumptions in [PLAN.md](../../PLAN.md)
before we commit to writing the v1 implementation. Run them in order.

## Spike 1 — proxy reachability

Goal: confirm the Apify MCP Proxy accepts an inbound HTTPS call from outside
the Apify network, authenticated with an Apify token.

If this fails, **Option A (Anthropic agent talks to the proxy directly) is
dead** and we need to put the Actor back in the request path (Standby +
`/mcp` proxy inside the container).

### Run

```bash
APIFY_MCP_PROXY_URL="https://<the-proxy-host>" \
APIFY_TOKEN="<apify_api_token_with_run_or_user_scope>" \
CONNECTOR_ID="conn_<your_real_connector_id>" \
  ./spike-1-proxy-reachability.sh
```

Get the proxy URL by running any Apify Actor and `echo $APIFY_MCP_PROXY_URL`
inside it. Get a connector ID by creating one in **Apify Console → Settings
→ Integrations**.

### Interpretation

| Response | Meaning |
|---|---|
| `200` with an MCP `initialize` response | Proxy reachable from outside — Option A is alive. |
| `401` | Token rejected. Either it's the wrong token or the proxy refuses non-Actor callers. |
| `403` | Token accepted but the connector ID is not authorized for this run/user. |
| Connection refused / 5xx / timeout | Reachability or proxy-side issue. |

## Spike 2 — end-to-end thin slice

Goal: confirm the full Plan flow works against the real Anthropic API and
the real Apify MCP Proxy. Creates a vault, attaches it to a session against
an existing agent + environment, overrides `mcp_servers` to point at the
proxy, sends a prompt, and streams events to stdout.

If this passes, the Plan is validated and we can implement v1 with
confidence.

### One-time prep

1. Create an agent + environment manually via Anthropic Console (or the
   API). Note `ANTHROPIC_AGENT_ID` and `ANTHROPIC_ENVIRONMENT_ID`. The
   agent's `mcp_servers` should be empty.
2. Have at least one MCP connector ready in Apify Console.

### Run

```bash
ANTHROPIC_API_KEY="sk-ant-..." \
ANTHROPIC_AGENT_ID="ag_..." \
ANTHROPIC_ENVIRONMENT_ID="env_..." \
APIFY_MCP_PROXY_URL="https://<the-proxy-host>" \
APIFY_TOKEN="<apify_api_token>" \
CONNECTOR_IDS="conn_abc,conn_def" \
PROMPT="List the tools you can use, then call one." \
  node scripts/spikes/spike-2-e2e.mjs
```

Requires Node 18+ (for native `fetch`).

### What success looks like

- Vault and session created (printed IDs).
- Session updated; `agent.mcp_servers` now points at the proxy URLs.
- SSE stream opens (HTTP 200).
- Events stream in, including at least one `agent.message` and ideally one
  `agent.mcp_tool_use` (proves the agent actually called the proxy).
- Final `session.status.idle` event. Vault deleted in `finally`.

### Common failure modes to watch for

- `agent.mcp_tool_use` events with errors → proxy reachability or auth
  issue (revisit Spike 1).
- Session terminates immediately → the developer agent might still have
  `mcp_servers` set with auth that doesn't resolve.
- Stream hangs → proxy MCP transport may not match Anthropic's expectations
  (streamable HTTP vs SSE).
