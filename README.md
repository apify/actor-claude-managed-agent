# Claude Agent with MCP Connectors

A thin Apify Actor that runs **your** pre-built [Claude Managed Agent](https://platform.claude.com/docs/en/managed-agents/overview) and gives it tools through Apify [MCP Connectors](https://docs.apify.com/platform/integrations/mcp) — Slack, Notion, GitHub, and any other MCP server you authorize in your Apify account. The end user types a prompt, picks the connectors, and reads the agent's answer in the dataset. Credentials never touch the Actor code.

> ⚠️ **Template — add billing before publishing.** Before publishing your fork to the Apify Store you must add a monetization config (e.g. Pay-Per-Event in `.actor/actor.json`) to cover the Anthropic API costs you pay for every run. See the [Apify monetization docs](https://docs.apify.com/platform/actors/publishing/monetize).

## How it works

```
End user ──▶ Actor run ──▶ Anthropic Managed Agents API ──▶ agent runtime
   (prompt + connector IDs)        │                              │ tool call
                                   │ SSE events (answer)          ▼
                                   ◀──────────────────  ${APIFY_CONTAINER_URL}/mcp/<id>  ← this Actor
                                                                  │  forwards (Bearer APIFY_TOKEN)
                                                                  ▼
                                                       Apify MCP Proxy ──▶ Slack / Notion / …
```

Per run, the Actor:

1. Validates input + env.
2. If connectors were picked, starts a local MCP proxy on `ACTOR_WEB_SERVER_PORT`. Anthropic reaches it at `${APIFY_CONTAINER_URL}/mcp/<connectorId>` and it forwards each MCP message to the internal `${APIFY_MCP_PROXY_URL}/<connectorId>`.
3. Creates a one-shot Anthropic **vault** with one `static_bearer` credential per connector (the credential value is the run-scoped `APIFY_TOKEN`).
4. Creates a **session** against your agent + environment.
5. Overrides the session's `mcp_servers`/`tools` to point at the proxy URLs (preserving the agent's built-in tools).
6. Opens the SSE event stream, sends the prompt, and streams events until the session goes idle.
7. Writes the answer to the default dataset and the full event transcript to a `debug` dataset.
8. Cleans up: stops the proxy, deletes the vault.

The Actor never creates or modifies your agent, and never sees a third-party token — the Apify MCP Proxy injects those server-side.

## Setup (once, as the developer)

1. **Provision your agent + environment** on Anthropic. Run locally:

   ```bash
   ANTHROPIC_API_KEY=sk-ant-... \
     pnpm provision --name "My Agent" --system "You are a helpful assistant."
   ```

   This creates a Managed Agent (with **empty** `mcp_servers` — the Actor injects them per run) and a cloud environment, then prints two IDs.

2. **Set Actor secrets** (Apify Console → your Actor → Settings → Environment variables):

   | Variable | Value |
   |---|---|
   | `ANTHROPIC_API_KEY` | Your Anthropic API key |
   | `ANTHROPIC_AGENT_ID` | Printed by `provision` |
   | `ANTHROPIC_ENVIRONMENT_ID` | Printed by `provision` |

3. **Publish:** `apify push`.

> **Your agent must have no `mcp_servers` configured.** The Actor injects the user-selected connectors per session; any MCP server set on the agent itself would fail at runtime because the per-session vault only carries credentials for the Apify connectors.

## Using the Actor (as an end user)

1. Authorize MCP Connectors under **Apify Console → Settings → Integrations → MCP Connectors** (once each, via OAuth / API key / your own OAuth client).
2. Open the Actor, type a **prompt**, and pick one or more **MCP connectors** (leave empty to run the agent with only its built-in tools).
3. **Start.** Read the answer in the **Dataset** tab when the run finishes.

## Input

| Field | Type | Required | Description |
|---|---|---|---|
| `prompt` | string | ✅ | The task for the agent. |
| `mcpConnectors` | string[] | optional | Apify MCP Connector IDs (resolved by the Console picker). Each becomes an MCP server the agent can call. |

## Output

**Default dataset** — one row per run:

```json
{
  "prompt": "use the echo tool",
  "answer": "Tool said: …",
  "sessionId": "ses_…",
  "error": null,
  "errorMessage": null,
  "partial": false,
  "durationMs": 5234,
  "finishedAt": "2026-05-31T20:00:00.000Z"
}
```

On failure `error` is a short code (`timeout`, `session_terminated`, `stream_dropped`, `setup_failed`) and `partial` is `true` if a partial answer was captured.

**`debug` dataset** — one row per streamed event (`agent.message`, `agent.mcp_tool_use`, status changes, …), for debugging the agent's behaviour without re-running.

## Environment variables

| Var | Source | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | Developer secret | Auth to the Managed Agents API. |
| `ANTHROPIC_AGENT_ID` | Developer secret | The agent to run (from `provision`). |
| `ANTHROPIC_ENVIRONMENT_ID` | Developer secret | The cloud environment (from `provision`). |
| `APIFY_TOKEN` | Auto-injected per run | Bearer for the local proxy → Apify MCP Proxy. Run-scoped; expires with the run. |
| `APIFY_MCP_PROXY_URL` | Auto-injected per run | Internal Apify MCP Proxy base URL. |
| `APIFY_CONTAINER_URL` | Auto-injected per run | Public URL of this Actor's web server, advertised to Anthropic. |
| `ACTOR_WEB_SERVER_PORT` | Auto-injected per run | Port the local proxy listens on (default `4321`). |
| `ANTHROPIC_BASE_URL` | optional | Override the Anthropic API base (used by tests). |

## Project layout

```
.actor/                 # Actor metadata, input/output/dataset schemas, Dockerfile
src/
├── main.ts             # Apify entrypoint: input → proxy → run → datasets → cleanup
├── run.ts              # Orchestration: vault → session → mcp override → stream
├── anthropic.ts        # Managed Agents API client (vaults, sessions, events, stream)
├── config.ts           # Input + env validation, deadline calculation
├── agent-config.ts     # Pure builders for mcp_servers / mcp_toolset overrides
├── sse.ts              # SSE parsing + session-stream consumer
├── server.ts           # Local /mcp/<id> proxy server (Express + StreamableHTTP)
└── mcp.ts              # McpServer that proxies to ${APIFY_MCP_PROXY_URL}/<id>
scripts/provision.ts    # One-time agent + environment creation (developer runs locally)
test/                   # vitest unit + integration + end-to-end tests
```

## Develop

```bash
pnpm install
pnpm typecheck      # tsc over src + test + scripts
pnpm test           # vitest: unit, MCP-proxy integration, full e2e
pnpm build          # compile src → dist
apify run           # local run (reads storage/key_value_stores/default/INPUT.json)
apify push          # deploy
```

The test suite includes an end-to-end test that boots the real Actor against a fake Anthropic API and a fake MCP upstream, so the orchestration and the MCP proxy path are verified without any live credentials.

## Notes on connectors

The Apify MCP Proxy is in active development. Some providers (e.g. Notion) work with zero setup; many major OAuth providers (GitHub, Slack, Google, Microsoft) currently need a "user-provided OAuth client" when you create the connector. See the [MCP Connectors docs](https://docs.apify.com/platform/integrations/mcp).

Connectors whose MCP server issues **server→client requests** (sampling, elicitation, roots) are not supported: the local proxy forwards tools and notifications, but not those request types.

## Resources

- [Anthropic Managed Agents](https://platform.claude.com/docs/en/managed-agents/overview)
- [Apify MCP Connectors](https://docs.apify.com/platform/integrations/mcp)
- [Apify Actor monetization](https://docs.apify.com/platform/actors/publishing/monetize)
- [Model Context Protocol](https://modelcontextprotocol.io)
