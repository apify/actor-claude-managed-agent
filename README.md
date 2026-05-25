# Claude Agent Actor

Run a [Claude Managed Agent](https://platform.claude.com/docs/en/managed-agents/overview) on Apify with dynamically-selected MCP connectors.

## How it works

1. **Developer** pre-creates a *template* Anthropic Agent in their Anthropic Console (system prompt, model, tools, skills, behavior) and pastes its ID into this Actor's env vars (`ANTHROPIC_AGENT_ID`).
2. **User** runs the Actor with a `prompt` and a list of Apify MCP connector IDs (e.g. `["slack", "notion"]`).
3. **Actor** clones the template Agent at runtime, replacing `mcp_servers` with:
   - `https://mcp.apify.com/` (always — gives the agent access to the Apify Store)
   - `https://connectors-proxy.apify.run/?name=<id>` for each requested connector
4. A per-run Anthropic Vault is created with one `static_bearer` credential per MCP URL, all using the run's `APIFY_TOKEN`. The Apify side enforces real-credential injection downstream.
5. The agent runs the task, the Actor polls until it finishes, then pushes the answer to the Dataset and `OUTPUT` key-value store.
6. Per-run resources (cloned Agent + Vault) are cleaned up in a `finally` block.

## Inputs

| Field | Type | Required | Description |
|---|---|---|---|
| `prompt` | `string` | ✅ | The task for the agent. |
| `mcpConnectors` | `string[]` | optional (default `[]`) | Apify MCP connector IDs to enable. |

## Environment variables

| Var | Source | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | Developer secret | Auth to Anthropic Managed Agents API |
| `ANTHROPIC_AGENT_ID` | Developer secret | Template Agent ID to clone per run |
| `APIFY_TOKEN` | Auto-injected by Apify per run | Bearer for `mcp.apify.com` and `connectors-proxy.apify.run` |

## Output

Single row written to the default Dataset + `OUTPUT` key-value store:

```json
{
  "prompt": "...",
  "answer": "...",
  "mcpConnectors": ["slack", "notion"],
  "mcpServerUrls": [
    "https://mcp.apify.com/",
    "https://connectors-proxy.apify.run/?name=slack",
    "https://connectors-proxy.apify.run/?name=notion"
  ],
  "sessionId": "sesn_...",
  "agentId": "agent_...",
  "templateAgentId": "agent_...",
  "environmentId": "env_...",
  "durationMs": 87432,
  "finishedAt": "2026-05-25T13:42:11.234Z"
}
```

## Project layout

```
.actor/
├── actor.json           # Actor metadata + Dataset view
├── input_schema.json    # { prompt, mcpConnectors }
└── Dockerfile           # apify/actor-node:24 + corepack pnpm + TS build step
src/
├── main.ts              # Apify entrypoint + orchestrator (strict TS)
├── anthropic.ts         # Anthropic Managed Agents API wrapper (zero runtime deps)
└── extract.ts           # Robust agent.message text extractor
tsconfig.json            # NodeNext ESM, strict mode, ES2023 target
pnpm-workspace.yaml      # pnpm 11 config (allowBuilds for esbuild)
package.json             # apify (runtime) + typescript / tsx / @types/node (dev)
```

## Local development

```bash
cd apify/claude-agent-actor
pnpm install

# Fast iteration: run TS directly (uses tsx, no build step)
lockbox run -c '
  ANTHROPIC_AGENT_ID=agent_xxx pnpm start:dev
'

# Or build first, then run the compiled JS (matches Docker runtime)
pnpm build
lockbox run -c '
  ANTHROPIC_AGENT_ID=agent_xxx pnpm start
'
```

`APIFY_TOKEN` and `ANTHROPIC_API_KEY` come from lockbox. The Actor pulls input from the local `storage/key_value_stores/default/INPUT.json` file when run outside Apify (standard Apify SDK behavior).

## Scripts

| Script | What it does |
|---|---|
| `pnpm build` | Compile `src/*.ts` → `dist/*.js` |
| `pnpm start` | Run the compiled `dist/main.js` (production path) |
| `pnpm start:dev` | Run `src/main.ts` directly via tsx (dev path, no build) |
| `pnpm typecheck` | `tsc --noEmit` — fast type-only check |
| `pnpm clean` | Remove `dist/` |

## Deploy

```bash
apify push
```

## Status

V0 scaffold. Known TODOs:

- Confirm the exact URL pattern + auth header that `connectors-proxy.apify.run` expects (current code assumes `?name=<id>` + `Authorization: Bearer <APIFY_TOKEN>`).
- Confirm Anthropic's URL normalization for credentials with query strings (the trailing-slash quirk surfaced earlier for `mcp.apify.com`).
- Add Pay-Per-Event monetization config to `.actor/actor.json` before publishing.
- Optional: stream `agent.tool_use` events to the Dataset live for transparency.
- Optional: also surface tool-call summary in the Dataset row.


