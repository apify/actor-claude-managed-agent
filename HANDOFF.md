# Handoff: simplification of actor-claude-managed-agent

> Purpose: continue an architecture discussion in a fresh Claude Code session that has unrestricted web-fetch access. The previous session got 403 on `platform.claude.com/docs/en/managed-agents/overview` and could only infer the Managed Agents API from the existing `src/anthropic.ts`.

## Goal

Turn this repo into a **simple scaffolding template** that anyone can fork to wire an Apify Actor to a Claude Managed Agent. Current code (~1100 LOC, see `src/main.ts`, `src/anthropic.ts`, `src/server.ts`, `src/mcp.ts`) is functional but tangled. Success = small, opinionated, copy-pasteable.

## What today's code does (one-paragraph recap)

Each Actor run: clones a template agent with dynamic `mcp_servers` → creates a vault with `static_bearer` credentials → creates/reuses an environment → creates a session → sends one `user.message` → polls `/v1/sessions/{id}/events` every 4s for up to 10 min → extracts text from latest `agent.message` → archives the clone, deletes the vault. In parallel, an Express server inside the Actor exposes `/mcp/<connectorId>` so Anthropic's cloud agent can call back into the Apify MCP Proxy.

The tangle is mostly: per-run agent cloning, per-run dynamic MCP URL, env caching in a shared KV store, racy session tracking in the in-Actor HTTP server, silent error swallowing in cleanup.

## Decisions already made with the user

| Axis | Choice |
|---|---|
| **A. Where agent loop lives** | A1+A2: **Managed Agent runs the loop AND calls back into Actor-exposed tools** |
| **B. Agent lifecycle** | B2: **one persistent template agent**, provisioned at deploy, never cloned per run |
| **C. MCP delivery** | **Standby mode** so the Actor URL is stable; template agent has `mcp_servers = [<standby url>/mcp]` baked in; per-request token rotation via vault credentials. (Normal-run mode would force B1 because container URL changes each run.) |
| **D. Sync model** | D1: **polling** (matches today's design) |
| **E. User surface** | E1: **one-shot prompt → answer** |

## Target architecture (proposed, awaiting confirmation)

> Actor is a **Standby web server** with two endpoints:
> - `POST /run` — user submits a prompt. Handler creates vault → creates session → polls → returns final answer → deletes vault.
> - `POST /mcp` (or `GET` for SSE) — Managed Agent calls back here for tools. Bearer-authed against the per-session secret stored in the vault.
>
> Template agent + environment are provisioned **once at deploy time** (a `scripts/provision.ts` one-shot), and the resulting IDs go into Actor secrets (`ANTHROPIC_AGENT_ID`, `ANTHROPIC_ENVIRONMENT_ID`). The runtime code never touches `/v1/agents` or `/v1/environments` — only `/v1/vaults` and `/v1/sessions`.

Estimated size: 2–3 files, <300 LOC. No `server.ts` session-tracking dict, no `mcp.ts` proxy, no agent cloning, no environment cache KV store.

## Open questions still owed to the user (priority order)

1. **Confirm Standby mode** is acceptable as a hard requirement.
2. **Which tools does the Actor expose at `/mcp`?**
   - T1: proxy to Apify MCP Proxy (today's behavior — exposes ~all Apify Actors)
   - T2: **hand-written Actor-local tools** (e.g. `save_to_dataset`, `read_input`, `push_log`) — recommended for a scaffolding template, since the whole point is teaching forkers how to add their own tools
   - T3: both
3. **Vault lifecycle** — per-session create+delete (recommended) vs reuse one vault and rotate creds.
4. **MCP callback auth** — recommend: generate a one-time secret per `/run`, store in the vault as `static_bearer`, `/mcp` rejects anything else.
5. **Failure semantics on poll timeout** — error / partial / configurable?

## What the next session should do FIRST

1. Fetch `https://platform.claude.com/docs/en/managed-agents/overview` (and any linked subpages on sessions, vaults, environments, MCP). The previous session got HTTP 403 on WebFetch — verify your environment can reach it.
2. Specifically verify: **can `mcp_servers` be overridden at session-creation time?** If yes, Standby mode becomes optional and we get more flexibility. If no, Standby is the only path to B2.
3. Verify whether the Managed Agents API supports **server-sent events / streaming** on sessions. If yes, D2 (live transcript) becomes cheap and we should reconsider E1.
4. Read **`src/anthropic.ts`** end-to-end — it's the most accurate "spec" of the API surface we have, written against beta header `managed-agents-2026-04-01`.
5. Then resume the discussion with the user by answering the 5 open questions above, starting with #2 (tool surface), because that one most shapes the file layout.

## Context for the user's voice/preferences

- Strong preference for **simple, non-over-engineered** code. "Scaffolding others can pick up and do their own solution."
- OK with deleting features (per-run dynamic connectors, env caching) if they're driving complexity.
- This is a **template**, not a production system — teaching value > completeness.

## Files worth reading in this repo

- `src/main.ts` (298 LOC) — orchestrator
- `src/anthropic.ts` (404 LOC) — the de-facto API spec
- `src/server.ts` (266 LOC) — the in-Actor MCP gateway being deleted
- `src/mcp.ts` (125 LOC) — proxy to Apify MCP Proxy (delete or keep depending on Q2)
- `.actor/input_schema.json` — current input contract (will simplify if we drop dynamic connectors)
