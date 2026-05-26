## What does Claude Agent with MCP Connectors do?

Claude Agent with MCP Connectors runs a **Claude Managed Agent** on Apify and gives it on-demand access to any MCP servers you authorize through Apify's **MCP Connectors** — Slack, Notion, GitHub, Sentry, Gmail, Google Drive, and others. Send the agent a natural-language task, pick which Connectors it can use, and the agent does the work using your credentials — which never leave the Apify platform.

This Actor is a **template**. It demonstrates how to host a public MCP endpoint inside an Apify run, re-expose your authorized MCP Connectors to a cloud-hosted LLM (Anthropic's Managed Agents API), and clean up the per-run resources when finished.

## Why use Claude Agent with MCP Connectors?

- **Bring your tools to Claude.** Authorize a Connector once in your Apify account; this Actor wires it into the agent at runtime.
- **Credentials never touch Actor code.** All third-party tokens stay inside Apify's MCP Proxy.
- **Per-run isolation.** Every run clones a fresh Anthropic Agent, creates a one-shot Vault, and tears them down on exit.
- **Scheduling, API access, monitoring, integrations.** Standard Apify platform features apply — run it on a schedule, trigger it from another Actor, or call it via the Apify API.
- **Auditable.** All MCP traffic flows through the Actor's own proxy, where it can be logged or filtered per run.

## What data does this Actor produce?

One row per run is written to the default Dataset and to the `OUTPUT` key-value record.

| Field | Type | Description |
|---|---|---|
| `answer` | string | Final text the Claude agent produced for the task. |
| `agentId` | string | ID of the cloned Anthropic Agent that ran. |
| `sessionId` | string | ID of the Anthropic session. |
| `environmentId` | string | ID of the Anthropic Environment (cached across runs). |
| `durationMs` | number | Wall-clock duration of the run in milliseconds. |
| `finishedAt` | string | ISO timestamp when the run finished. |

## How to use Claude Agent with MCP Connectors

1. **Authorize one or more MCP Connectors** in your Apify account under **Settings → API & Integrations → MCP Connectors**. Each Connector points at an upstream MCP server (e.g. `https://mcp.slack.com/mcp`) and is authorized once via OAuth, API key, or your own OAuth client.
2. **Open this Actor in the Apify Console** and go to the **Input** tab.
3. **Type your task** in the *Prompt* field.
4. **Pick the Connectors** the agent should be able to use (optional — leave empty to give it only `https://mcp.apify.com/`, the Apify Store browser).
5. **Click Start.** When the run finishes, open the **Dataset** tab to read the agent's answer.

## How much will it cost?

This Actor is billed by Apify **compute units** (CU) — you pay only for the time the agent's session is active.

Approximate cost per run depends on the prompt complexity and how many tools the agent invokes; a short single-step task typically completes in well under one CU. Anthropic's Claude token cost is **billed separately** by Anthropic on your Anthropic account (the Actor uses your `ANTHROPIC_API_KEY`).

## Input

See the **Input** tab for the live form. The Actor accepts:

| Field | Type | Required | Description |
|---|---|---|---|
| `prompt` | string | ✅ | The task the Claude agent will perform. |
| `mcpConnectors` | string[] | optional | Apify MCP Connector IDs (resolved via the Console picker). Each becomes an MCP server the agent can call. |

## Output

You can download the dataset in JSON, HTML, CSV, or Excel. Example item:

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

## How it works (architecture)

```
[Anthropic cloud Managed Agent]
            │  HTTPS, Bearer APIFY_TOKEN
            ▼
${CONTAINER_URL}/mcp/<connectorId>          ← this Actor's public web server
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

Per run, in `src/main.ts`:

1. Validate input and required env vars.
2. If any MCP Connectors were requested, start a local MCP proxy on `ACTOR_WEB_SERVER_PORT`. The proxy is reachable from Anthropic's cloud at `${CONTAINER_URL}/mcp/<connectorId>` (Bearer APIFY_TOKEN) and forwards every MCP message to `${APIFY_MCP_PROXY_URL}/<connectorId>`.
3. Build the per-run MCP server list — `https://mcp.apify.com/` (always, direct) plus one `${CONTAINER_URL}/mcp/<id>` URL per requested connector.
4. Clone the developer's template Anthropic Agent, overriding `mcp_servers` with that list.
5. Create a per-run Vault with one `static_bearer` credential per MCP URL (all `APIFY_TOKEN`).
6. Reuse a cached Environment (per-Actor named KV store) or create one.
7. Create a Session, send the user prompt, poll until idle, fetch the final answer.
8. Push the result to Dataset + `OUTPUT` and cleanup (delete vault, archive cloned agent, stop the proxy).

> **Why a local proxy?** Apify's documented MCP Connector pattern has the Actor itself be the MCP *client* (in-process). This template inverts that: the Actor re-exposes connectors as a *server* so a cloud-side LLM (Anthropic Managed Agent) can consume them. That gives the Actor a single public MCP surface per run for logging, filtering, or scoping connector traffic.

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

## Local development

```bash
pnpm install

# Fast iteration: run TS directly via tsx (no build)
lockbox run -c '
  ANTHROPIC_AGENT_ID=agent_xxx pnpm start:dev
'

# Or build then run compiled JS (matches Docker runtime)
pnpm build
lockbox run -c '
  ANTHROPIC_AGENT_ID=agent_xxx pnpm start
'

# Or the official Apify local-run path (reads INPUT.json from storage/)
apify run
```

`APIFY_TOKEN` and `ANTHROPIC_API_KEY` come from `lockbox` / your environment. The Actor reads input from `storage/key_value_stores/default/INPUT.json` when run outside Apify (standard Apify SDK behavior).

**Note on local runs:** `apify run` stores datasets and key-value records on your local filesystem only — they are **not** synced to Apify Console. Deploy with `apify push` and trigger from the Console to see real platform results.

## Deploy

```bash
apify push
```

The Actor name and version are read from `.actor/actor.json`.

## FAQ and disclaimers

**Why does this Actor host its own MCP server instead of just using Apify's MCP Proxy directly?**
Because Anthropic's Managed Agent runs in Anthropic's cloud and needs to reach the MCP server over the public internet. Hosting an MCP endpoint inside the Actor gives us a single public surface per run that we own — useful for logging, scoping, or transforming MCP traffic without exposing the user's third-party credentials.

**Where is my Sentry / Slack / Notion API token kept?**
Never inside this Actor. Credentials are injected by Apify's MCP Proxy server-side using the Connector you authorized. Both the Anthropic side and the Actor side only see opaque MCP messages and a per-run `APIFY_TOKEN`.

**Disclaimer.** This Actor lets a Claude agent call third-party services on your behalf using your authorized MCP Connectors. The agent can take any action your Connectors permit. Review the Connector's tool list before allowing destructive operations, and start with read-only Connectors when trying it out.

For issues or feedback, open the Actor's **Issues** tab in the Apify Console.

## Resources

- [Anthropic Managed Agents documentation](https://platform.claude.com/docs/en/managed-agents/overview)
- [Apify MCP Connectors documentation](https://docs.apify.com/platform/integrations/mcp)
- [Model Context Protocol specification](https://modelcontextprotocol.io)
- [What is the Model Context Protocol?](https://blog.apify.com/what-is-model-context-protocol/)
