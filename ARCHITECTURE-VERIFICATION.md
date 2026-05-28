# Architecture verification

Cross-checks every decision in [HANDOFF.md](./HANDOFF.md) against the live
Anthropic Managed Agents docs (beta header `managed-agents-2026-04-01`) and
the Apify platform docs. The previous session inferred the API from
`src/anthropic.ts` and could not reach the docs; several of its conclusions
are wrong as a result.

Three findings change the recommended architecture:

1. **`mcp_servers` and `tools` CAN be overridden per session** (session-update endpoint), so the rationale for "Standby is the only path to a persistent template agent" collapses.
2. **Sessions have native SSE streaming** (`GET /v1/sessions/{id}/events/stream`), so the 4-second polling loop in `src/anthropic.ts` is unnecessary scaffolding, not a fundamental constraint.
3. **Sessions are stateful by design and keep conversation history**, so the "one-shot prompt → answer" surface (E1) leaves the main feature of Managed Agents on the table.

The rest of this doc walks through every choice with the citation that
either confirms or refutes it.

---

## A. Where the agent loop lives (A1 + A2)

> HANDOFF: Managed Agent runs the loop AND calls back into Actor-exposed tools.

**Confirmed.** The whole point of Managed Agents is "the harness and infrastructure for running Claude as an autonomous agent. Instead of building your own agent loop, tool execution, and runtime, you get a fully managed environment" ([overview](https://platform.claude.com/docs/en/managed-agents/overview)). Tool callbacks into an HTTP server you control are exactly what the `mcp_servers` array on the agent is for — Claude calls our `/mcp` endpoint to invoke our tools.

No changes needed.

---

## B. Agent lifecycle (B2 — one persistent template)

> HANDOFF: one persistent template agent, provisioned at deploy, never cloned per run.

**Confirmed AND simplified.** The previous code clones the agent per run because it needs to inject the run-specific MCP URL into `mcp_servers`. But the [sessions docs](https://platform.claude.com/docs/en/managed-agents/sessions) explicitly support updating `agent.mcp_servers` and `agent.tools` on a session via `POST /v1/sessions/{id}` — "Updates are session-local and do not propagate back to the underlying agent." So even without Standby, we don't need to clone agents.

Also relevant: **agents are versioned**. "Agents are versioned resources; passing in the `agent` ID as a string starts the session with the latest agent version." We can iterate on the template's system prompt without redeploying the Actor.

The remaining open question is **what counts as "deploy time"** on Apify (see § Apify deploy lifecycle below).

---

## C. MCP delivery via Standby mode

> HANDOFF: Standby mode so the Actor URL is stable; template agent has `mcp_servers = [<standby url>/mcp]` baked in; per-request token rotation via vault credentials. "Normal-run mode would force B1 because container URL changes each run."

**Partially refuted.** The "Normal mode forces B1" claim is wrong: per-session `mcp_servers` update (B above) lets you keep one template agent under Normal mode too. So Standby is no longer mandatory for B2 — it's one of three viable options:

| Pattern | Agent | URL per session | Pros | Cons |
|---|---|---|---|---|
| **Standby + persistent agent** | One persistent | Stable Actor URL baked into template agent | Simplest runtime code; no `mcp_servers` mutation; URL warm | Requires Standby; Actor billed while idle; concurrency requires care |
| **Normal + per-session override** | One persistent | Per-run URL, injected via session update | No Standby required; clean per-run isolation | One extra API call per session; need session in `idle` before updating |
| **Normal + per-run agent clone** (current) | Cloned per run | Per-run URL baked into clone | What the code does today | Extra round-trips; orphaned agents on crashes |

For a **scaffolding template**, Standby is still the most legible choice: a single `POST /run` → tool callbacks all hit the same hostname. But the doc should not claim it's the only option.

### Apify Standby specifics

- URL is exposed as `ACTOR_STANDBY_URL` and follows the `https://<actor-slug>.apify.actor` pattern ([Standby docs](https://docs.apify.com/platform/actors/running/standby) — example given is `https://rag-web-browser.apify.actor/search?query=apify`).
- Authentication is the **Apify token**, either as `Authorization: Bearer ...` (recommended) or `?token=...` query param. This is the auth the Actor enforces on incoming `/mcp` calls.
- 5-minute timeout for the first response; 2-minute run-selection timeout.
- Apify auto-scales by starting new runs behind the same hostname when load arrives. So we cannot assume in-process state is shared across requests — anything per-session must live in a vault / a session-keyed Apify KV record, not in a JS map.

### Vault credential lifecycle (important nuance)

The doc on [vaults](https://platform.claude.com/docs/en/managed-agents/vaults) states:

- "**One active credential per `mcp_server_url` per vault.**" (409 on duplicate.)
- "`mcp_server_url` is immutable."
- "Maximum 20 credentials per vault."
- **Vaults are workspace-scoped** — "anyone with API key access can use them." This is a real concern for a marketplace Actor: vault credentials are not per-end-user-isolated at the API key boundary.

Implication: if `mcp_server_url` changes per run (Normal mode), we have to create a new vault + credential each run — we can't rotate credentials on a reused vault. **In Standby mode the URL is stable**, so a vault could in principle be reused; in practice we still want a fresh vault per session for token isolation, which is fine because vault create+delete is cheap.

The HANDOFF's recommendation — per-session vault create+delete with a one-time secret — is the right call. Cite this rationale in code.

---

## D. Sync model (D1 — polling) — REFUTED

> HANDOFF: polling (matches today's design).

**Native SSE streaming exists.** From [Session event stream](https://platform.claude.com/docs/en/managed-agents/events-and-streaming): `GET /v1/sessions/{id}/events/stream?beta=true` with `Accept: text/event-stream`. The SDK helper is `client.beta.sessions.events.stream(session.id)`. Important: "Open the stream first, then send the user message" to avoid a race — only events emitted after the stream is opened are delivered.

The doc also describes a clean resume pattern: "open a new stream and then list the full history to seed a set of seen event IDs. Tail the live stream while skipping any events already returned by the history list." This handles disconnects without losing events.

Today's `src/anthropic.ts` polls `GET /v1/sessions/{id}` every 4 s with an initial 5 s "settle" delay. Both are workarounds for not using the stream:

- The `initialDelayMs = 5000` race is exactly the "send before stream open" race the docs warn about — flipped. Streaming removes the need.
- The 4 s tick means up to 4 s of latency on every status transition. Streaming is real-time.
- The dedup-by-event-ID `Set` is exactly the seed-then-tail pattern, just done with worse latency.

**Recommendation: switch to SSE.** This is also a precondition for any future "live transcript to the user" UX (D2/E2).

If we genuinely want a synchronous `POST /run` → final-answer response (E1), we can still consume the SSE stream internally and only return when we observe the `session.status.idle` event. No external behaviour change, much less code.

---

## E. User surface (E1 — one-shot) — RECONSIDER

> HANDOFF: one-shot prompt → answer.

The session API is built for multi-turn ("maintains conversation history across multiple interactions"). The two-step create-then-event lifecycle is also tuned for keeping the session warm — "Creating a session provisions the environment's container but does not start any work."

For a scaffolding template, E1 is fine as the **default** surface — but the underlying design should make E2 (multi-turn) trivial to add. Concretely:

- Don't bind the session to the request — store `sessionId` keyed on something the caller can resend (a `conversation_id` query param). Next call: look up the existing session, send a new `user.message`, stream again.
- Per-session vault still makes sense — it scopes both turns of the conversation to one credential set.

This costs ~20 LOC and keeps E1 as the default behavior; E2 becomes "client sends the same `conversation_id` twice."

---

## Open questions, answered

1. **Standby confirmation.** No longer "mandatory"; recommended for legibility. See §C.
2. **Tools at `/mcp`.** Docs don't decide this. Either is mechanically valid — the only API constraint is `Maximum 20 credentials per vault` ≡ max 20 MCP servers per agent. T2 (hand-written Actor-local tools) remains the recommendation for a scaffolding template, since one of the project's goals is teaching forkers how to wire up their own tools.
3. **Vault lifecycle.** Per-session create+delete is correct because:
   - Vaults are workspace-scoped (no built-in per-user isolation), so cross-session leakage is the default failure mode.
   - The 20-credentials-per-vault cap forces splitting anyway.
   - Per-session vaults align lifetimes with the data they protect.
4. **MCP callback auth.** Generate per-session secret, register as `static_bearer` credential bound to the Actor's `/mcp` URL, store the same secret in-memory keyed by session ID, reject mismatches at `/mcp`. **One subtlety:** Anthropic injects the bearer when matching credentials by `mcp_server_url`, so the Standby `/mcp` URL string must be byte-identical between the agent's `mcp_servers` entry and the credential's `mcp_server_url`.
5. **Failure semantics on timeout.** Session statuses per docs: `idle`, `running`, `rescheduling`, `terminated` (note: NOT `error` as the current code checks — `src/anthropic.ts:289`). With streaming, the `session.status.terminated` event is explicit. For a template, return a 504-equivalent with the partial transcript collected so far.

---

## Apify deploy lifecycle (gap in HANDOFF)

HANDOFF proposes a `scripts/provision.ts` "one-shot" that runs "at deploy time" and writes IDs to Actor secrets. **Apify has no native post-deploy / post-build hook** — see [Apify publishing](https://docs.apify.com/platform/actors/publishing) and the build/run model: builds compile the image, runs execute it; nothing fires automatically between them.

Three options for the "provision once" step:

| Option | How | Cost |
|---|---|---|
| **A. Developer runs locally** | `npm run provision` against Anthropic API with developer's key, paste IDs into Actor environment variables | Manual; clear; the right default for a template |
| **B. Bootstrap-on-first-run** | At Actor startup, if `ANTHROPIC_AGENT_ID` is unset, create agent+environment and persist IDs in the default Apify KV store | Self-healing; complicates the runtime; multiple parallel boots race |
| **C. Encode as part of the Actor's input schema** | First user click on the Actor in the Console triggers a "setup" mode | Worst for a template — leaks setup mechanics into the user-facing input |

**Recommendation: Option A.** A `scripts/provision.ts` README'd as "run this once before publishing your fork" matches the template-first ethos and avoids any racy startup logic. Document the exact env-var contract (`ANTHROPIC_AGENT_ID`, `ANTHROPIC_ENVIRONMENT_ID`) in `.actor/actor.json`.

---

## Other corrections to `src/anthropic.ts` (independent of architecture)

These are bugs / API mismatches surfaced during verification, useful regardless of the refactor:

- `src/anthropic.ts:289` checks `sess.status === 'error'` — that status is not in the documented set (`idle | running | rescheduling | terminated`). Should be `terminated`.
- `cleanup()` archives the agent via `POST /v1/agents/{id}/archive`. If we move to a persistent template agent (B2), `cleanup()` should NOT archive the agent — only the vault. The function's `CleanupRefs` shape should change accordingly.
- `createVaultWithCredentials()` uses the same `token` (typically `APIFY_TOKEN`) as the `static_bearer` for every MCP server. For the proposed design, the bearer should be a per-session **secret we generate ourselves** (not the long-lived APIFY_TOKEN), and `/mcp` validates against that secret rather than against Apify's token. APIFY_TOKEN should only authenticate Apify Standby's outer transport, not be reused as the application-layer auth that the Anthropic agent injects.
- `cloneAgentWithDynamicMcp` becomes dead code under both B2 paths and can be deleted.
- The `tools` array in the cloned agent appends new `mcp_toolset` entries with `default_config: { permission_policy: { type: 'always_allow' } }`. The docs also document `always_ask` for confirmation-required tools — worth noting in the template's README for forkers who want a human-in-the-loop.

---

## Updated target architecture (delta vs HANDOFF)

Same shape — Actor as Standby web server with `POST /run` and `POST /mcp` — but with:

- **Streaming consumed via SSE**, not polling. `waitForSessionIdle` → `streamUntilIdle`. ~30 LOC saved, much better latency, foundation for E2.
- **`cloneAgentWithDynamicMcp` deleted.** Template agent is referenced by ID. Either Standby URL is baked in at provision time, or we use per-session `mcp_servers` update (and Standby becomes optional).
- **Session resume documented**: if the runtime crashes mid-session, the next request with the same `conversation_id` reconnects the SSE stream and seeds dedup from the history list — exactly the pattern in the docs.
- **`scripts/provision.ts` is a developer-run script**, not magic that fires at deploy. README explains the contract.

Estimated size: 2 runtime files + 1 provision script, still under 300 LOC.

---

## Sources

- Managed Agents overview: https://platform.claude.com/docs/en/managed-agents/overview
- Sessions: https://platform.claude.com/docs/en/managed-agents/sessions
- Events and streaming: https://platform.claude.com/docs/en/managed-agents/events-and-streaming
- Environments: https://platform.claude.com/docs/en/managed-agents/environments
- Vaults: https://platform.claude.com/docs/en/managed-agents/vaults
- Apify Standby: https://docs.apify.com/platform/actors/running/standby and https://docs.apify.com/platform/actors/development/programming-interface/standby
- Apify publishing: https://docs.apify.com/platform/actors/publishing
