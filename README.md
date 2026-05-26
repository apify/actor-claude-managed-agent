> ⚠️ **Template — billing not included.** This Actor is a starting point. Before publishing your own copy to the Apify Store you **must** add a monetization config (e.g. Pay-Per-Event in `.actor/actor.json`) to cover the Anthropic API costs you'll be paying for every run. See [Apify monetization docs](https://docs.apify.com/platform/actors/publishing/monetize).

## What does it do?

Runs a **Claude Managed Agent** on Apify with on-demand access to any MCP servers you authorize through Apify's **MCP Connectors** — Slack, Notion, GitHub, Sentry, Gmail, Google Drive, and others. Send the agent a natural-language task, pick which Connectors it can use, and the agent does the work using your credentials — which never leave the Apify platform.

This is a **template**. Fork it, plug in your own Anthropic template Agent, customize the system prompt / model / tools, add a monetization config, and publish your own variant on the Apify Store.

## Why use this template

- **Bring your tools to Claude.** Authorize a Connector once in your Apify account; this Actor wires it into the agent at runtime.
- **Credentials never touch Actor code.** All third-party tokens stay inside Apify's MCP Proxy.
- **Per-run isolation.** Every run clones a fresh Anthropic Agent, creates a one-shot Vault, and tears them down on exit.
- **Auditable.** MCP traffic passes through your Actor's own proxy — extend `src/mcp.ts` to add logging or filtering if you need it.

## How to use it

1. **Authorize one or more MCP Connectors** in your Apify account under **Settings → Integrations → MCP Connectors**. Each Connector points at an upstream MCP server (e.g. `https://mcp.slack.com/mcp`) and is authorized once via OAuth, API key, or your own OAuth client.
2. **Open the Actor in the Apify Console** and go to the **Input** tab.
3. **Type a task** in the *Prompt* field and **pick the Connectors** the agent can use (leave empty for `https://mcp.apify.com/` only, which lets the agent browse the Apify Store).
4. **Click Start.** When the run finishes, open the **Dataset** tab to read the agent's answer.

## How much will it cost?

Two layers:

- **Apify side**: compute units (CU) for the time the Actor runs. This template ships **without** a Pay-Per-Event config — add one in `.actor/actor.json` before publishing so you can charge your users.
- **Anthropic side**: Claude API tokens, billed on the `ANTHROPIC_API_KEY` you put in the Actor's env. **You** (the developer) pay Anthropic directly; mark it back to users via your PPE pricing.

## Input

| Field | Type | Required | Description |
|---|---|---|---|
| `prompt` | string | ✅ | The task the Claude agent will perform. |
| `mcpConnectors` | string[] | optional | Apify MCP Connector IDs (resolved via the Console picker). Each becomes an MCP server the agent can call. |

## Output

A single row is written to the default Dataset and to the `OUTPUT` key-value record. Example:

```json
{
  "answer": "Here are the latest 5 posts from National Geographic on Instagram:\n1. …",
  "agentId": "agent_abc123",
  "sessionId": "sesn_def456",
  "environmentId": "env_ghi789",
  "durationMs": 87432,
  "finishedAt": "2026-05-25T13:42:11.234Z"
}
```

`answer` is the headline; the Anthropic resource IDs are useful for debugging or follow-up calls.

## How it works (architecture)

> **Why a local proxy?** Apify's documented MCP Connector pattern has the Actor itself be the MCP *client* (in-process). This template inverts that: the Actor re-exposes connectors as a *server* so a cloud-side LLM (Anthropic Managed Agent) can consume them. That gives the Actor a single public MCP surface per run for logging, filtering, or scoping connector traffic.

```
[Anthropic cloud Managed Agent]
            │  HTTPS, Bearer APIFY_TOKEN
            ▼
${APIFY_CONTAINER_URL}/mcp/<connectorId>    ← this Actor's public web server
            │
            ▼
[McpServer proxy, one per connectorId]      ← src/server.ts + src/mcp.ts
            │  Bearer APIFY_TOKEN
            ▼
${APIFY_MCP_PROXY_URL}/<connectorId>        ← Apify MCP Proxy (injects user credentials)
            │
            ▼
[Real connector: Sentry / Slack / Notion / …]
```

The same `APIFY_TOKEN` authenticates both hops — Anthropic→this proxy, and this proxy→Apify MCP Proxy.

Per run, in `src/main.ts`:

1. Validate input and required env vars.
2. If any MCP Connectors were requested, start a local MCP proxy on `ACTOR_WEB_SERVER_PORT`. The proxy is reachable from Anthropic's cloud at `${APIFY_CONTAINER_URL}/mcp/<connectorId>` (Bearer `APIFY_TOKEN`) and forwards every MCP message to `${APIFY_MCP_PROXY_URL}/<connectorId>`.
3. Build the per-run MCP server list — `https://mcp.apify.com/` (always, direct) plus one `${APIFY_CONTAINER_URL}/mcp/<id>` URL per requested connector.
4. Clone the developer's template Anthropic Agent, overriding `mcp_servers` with that list.
5. Create a per-run Vault with one `static_bearer` credential per MCP URL (all `APIFY_TOKEN`).
6. Reuse a cached Environment (per-Actor named KV store) or create one.
7. Create a Session, send the user prompt, poll until idle, fetch the final answer.
8. Push the result to Dataset + `OUTPUT` and cleanup (delete vault, archive cloned agent, stop the proxy).

## Environment variables

| Var | Source | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | Developer secret | Auth to Anthropic Managed Agents API. |
| `ANTHROPIC_AGENT_ID` | Developer secret | Template Agent ID to clone per run. |
| `APIFY_TOKEN` | Auto-injected by Apify per run | Bearer for `mcp.apify.com`, the local MCP proxy, and the upstream Apify MCP Proxy. |
| `APIFY_MCP_PROXY_URL` | Auto-injected by Apify per run | Upstream base URL the local proxy forwards to. |
| `APIFY_CONTAINER_URL` | Auto-injected by Apify per run | Public URL of this Actor's web server — passed to Anthropic as the MCP server host. |
| `ACTOR_WEB_SERVER_PORT` | Auto-injected by Apify per run | Port the local MCP proxy listens on (defaults to `4321` locally). |

## Project layout

```
.actor/
├── actor.json              # Actor metadata
├── input_schema.json       # { prompt, mcpConnectors }
├── output_schema.json      # Dataset + OUTPUT links
├── dataset_schema.json     # Result table view
└── Dockerfile              # apify/actor-node:24 + corepack pnpm
src/
├── main.ts                 # Apify entrypoint + orchestrator
├── anthropic.ts            # Anthropic Managed Agents API wrapper (zero runtime deps)
├── server.ts               # Public MCP proxy server (Express + StreamableHTTP)
├── mcp.ts                  # McpServer factory that proxies to APIFY_MCP_PROXY_URL/<id>
└── extract.ts              # Robust agent.message text extractor
```

## Local development + deploy

```bash
pnpm install

# Dev iteration with tsx (no build step)
ANTHROPIC_AGENT_ID=agent_xxx pnpm start:dev

# Or the Apify local-run path (reads INPUT.json from storage/)
apify run

# Deploy to Apify
apify push
```

`APIFY_TOKEN` and `ANTHROPIC_API_KEY` come from your environment (e.g. `lockbox run -c '…'`). The Actor reads input from `storage/key_value_stores/default/INPUT.json` when run outside Apify.

**Note on local runs:** `apify run` stores datasets and key-value records on your local filesystem only — they are **not** synced to Apify Console. Push and trigger from the Console to see real platform results.

## FAQ and disclaimers

**Where is my Sentry / Slack / Notion API token kept?**
Never inside this Actor. Credentials are injected by Apify's MCP Proxy server-side using the Connector you authorized. Both the Anthropic side and the Actor side only see opaque MCP messages and a per-run `APIFY_TOKEN`.

**Why does this Actor host its own MCP server instead of using Apify's MCP Proxy directly?**
Because Anthropic's Managed Agent runs in Anthropic's cloud and needs to reach the MCP server over the public internet. Hosting an MCP endpoint inside the Actor gives us a single public surface per run that we own — useful for logging, scoping, or transforming MCP traffic without exposing the user's third-party credentials.

**Disclaimer.** This Actor lets a Claude agent call third-party services on your behalf using your authorized MCP Connectors. The agent can take any action your Connectors permit. Review the Connector's tool list before allowing destructive operations, and start with read-only Connectors when trying it out.

For issues or feedback, open an issue at <https://github.com/apify/actor-claude-managed-agent/issues>.

## Resources

- [Anthropic Managed Agents documentation](https://platform.claude.com/docs/en/managed-agents/overview)
- [Apify MCP Connectors documentation](https://docs.apify.com/platform/integrations/mcp)
- [Apify Actor monetization](https://docs.apify.com/platform/actors/publishing/monetize)
- [Model Context Protocol specification](https://modelcontextprotocol.io)
- [What is the Model Context Protocol?](https://blog.apify.com/what-is-model-context-protocol/)
