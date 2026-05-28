#!/usr/bin/env node
/**
 * Spike 2: End-to-end thin slice validating PLAN.md against real APIs.
 *
 * Flow: create vault -> add credential per connector -> create session ->
 * GET session, replace mcp slice in agent block, POST update ->
 * open SSE stream -> POST user.message -> log every event ->
 * delete vault in finally.
 *
 * Required env:
 *   ANTHROPIC_API_KEY         sk-ant-...
 *   ANTHROPIC_AGENT_ID        ag_...   (created in Anthropic Console, mcp_servers empty)
 *   ANTHROPIC_ENVIRONMENT_ID  env_...  (cloud environment)
 *   APIFY_MCP_PROXY_URL       https://<host>
 *   APIFY_TOKEN               apify_api_... (acts as ACTOR_RUN_API_TOKEN here)
 *   CONNECTOR_IDS             comma-separated, e.g. conn_abc,conn_def
 *
 * Optional env:
 *   PROMPT                    defaults to a generic "list tools and call one"
 *   TIMEOUT_MS                hard ceiling for the SSE loop, default 300000 (5 min)
 *
 * Requires Node 18+ (native fetch + AsyncIterable response body).
 * See ./README.md.
 */

const required = (name) => {
  const v = process.env[name];
  if (!v) { console.error(`missing env: ${name}`); process.exit(2); }
  return v;
};

const ANTHROPIC_API_KEY        = required('ANTHROPIC_API_KEY');
const ANTHROPIC_AGENT_ID       = required('ANTHROPIC_AGENT_ID');
const ANTHROPIC_ENVIRONMENT_ID = required('ANTHROPIC_ENVIRONMENT_ID');
const APIFY_MCP_PROXY_URL      = required('APIFY_MCP_PROXY_URL').replace(/\/$/, '');
const APIFY_TOKEN              = required('APIFY_TOKEN');
const CONNECTOR_IDS            = required('CONNECTOR_IDS').split(',').map(s => s.trim()).filter(Boolean);
const PROMPT                   = process.env.PROMPT ?? 'List the tools you have available, then call one of them and tell me the result.';
const TIMEOUT_MS               = Number(process.env.TIMEOUT_MS ?? 300_000);

const BASE = 'https://api.anthropic.com';
const HEADERS = {
  'x-api-key': ANTHROPIC_API_KEY,
  'anthropic-version': '2023-06-01',
  'anthropic-beta': 'managed-agents-2026-04-01',
  'content-type': 'application/json',
};

const log = (label, value) => {
  console.log(`\n--- ${label} ---`);
  if (typeof value === 'string') console.log(value);
  else console.log(JSON.stringify(value, null, 2));
};

const api = async (path, init = {}) => {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { ...HEADERS, ...(init.headers ?? {}) } });
  const text = await res.text();
  if (!res.ok) {
    console.error(`HTTP ${res.status} ${init.method ?? 'GET'} ${path}\n${text}`);
    throw new Error(`api ${path} -> ${res.status}`);
  }
  return text ? JSON.parse(text) : undefined;
};

const proxyUrl = (connectorId) => `${APIFY_MCP_PROXY_URL}/connection/${connectorId}`;

let vaultId;

const cleanup = async () => {
  if (!vaultId) return;
  try {
    await api(`/v1/vaults/${vaultId}`, { method: 'DELETE' });
    log('cleanup: vault deleted', vaultId);
  } catch (e) {
    console.error('cleanup: vault delete failed', e?.message ?? e);
  }
};

process.on('SIGINT', async () => { await cleanup(); process.exit(130); });

const main = async () => {
  // 1. create vault
  const vault = await api('/v1/vaults', {
    method: 'POST',
    body: JSON.stringify({ display_name: `spike-${Date.now()}` }),
  });
  vaultId = vault.id;
  log('vault', vault);

  // 2. one static_bearer credential per connector
  for (const connectorId of CONNECTOR_IDS) {
    const url = proxyUrl(connectorId);
    const cred = await api(`/v1/vaults/${vault.id}/credentials`, {
      method: 'POST',
      body: JSON.stringify({
        display_name: `cred-${connectorId}`,
        auth: { type: 'static_bearer', mcp_server_url: url, token: APIFY_TOKEN },
      }),
    });
    log(`credential ${connectorId}`, { mcp_server_url: url, id: cred.id });
  }

  // 3. create session
  const session = await api('/v1/sessions', {
    method: 'POST',
    body: JSON.stringify({
      agent: ANTHROPIC_AGENT_ID,
      environment_id: ANTHROPIC_ENVIRONMENT_ID,
      vault_ids: [vault.id],
      title: `spike ${new Date().toISOString()}`,
    }),
  });
  log('session', session);

  // 4. read current agent block; replace mcp slice; POST update
  const detail = await api(`/v1/sessions/${session.id}`);
  const existingTools = detail.agent?.tools ?? [];
  const nonMcpTools = existingTools.filter((t) => t.type !== 'mcp_toolset');
  const newMcpServers = CONNECTOR_IDS.map((id) => ({ type: 'url', name: id, url: proxyUrl(id) }));
  const newMcpToolsets = CONNECTOR_IDS.map((id) => ({
    type: 'mcp_toolset',
    mcp_server_name: id,
    default_config: { permission_policy: { type: 'always_allow' } },
  }));
  await api(`/v1/sessions/${session.id}`, {
    method: 'POST',
    body: JSON.stringify({
      agent: { tools: [...nonMcpTools, ...newMcpToolsets], mcp_servers: newMcpServers },
    }),
  });
  log('session updated', { mcp_servers: newMcpServers, tools_kept: nonMcpTools.length, tools_added: newMcpToolsets.length });

  // 5. OPEN STREAM BEFORE SENDING PROMPT
  const streamRes = await fetch(`${BASE}/v1/sessions/${session.id}/events/stream`, {
    headers: { ...HEADERS, accept: 'text/event-stream' },
  });
  if (!streamRes.ok || !streamRes.body) {
    const t = await streamRes.text();
    throw new Error(`stream open failed HTTP ${streamRes.status}: ${t}`);
  }
  log('stream opened', `HTTP ${streamRes.status}`);

  // 6. send user.message
  await api(`/v1/sessions/${session.id}/events`, {
    method: 'POST',
    body: JSON.stringify({
      events: [{ type: 'user.message', content: [{ type: 'text', text: PROMPT }] }],
    }),
  });
  log('prompt sent', PROMPT);

  // 7. SSE consumer
  const started = Date.now();
  const decoder = new TextDecoder();
  let buf = '';
  let finished = false;
  let finalText = '';

  for await (const chunk of streamRes.body) {
    if (Date.now() - started > TIMEOUT_MS) {
      console.error(`TIMEOUT after ${TIMEOUT_MS}ms`);
      break;
    }
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, i); buf = buf.slice(i + 2);
      const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
      if (!dataLine) continue;
      const data = dataLine.slice(6);
      if (data === '[DONE]') { finished = true; break; }
      let ev;
      try { ev = JSON.parse(data); } catch { continue; }
      const ts = ev.processed_at ?? '';
      console.log(`[${ev.type ?? '?'}] ${ts}`);
      if (ev.type === 'agent.message' || ev.type === 'agent.mcp_tool_use' || ev.type === 'agent.tool_use' || (ev.type ?? '').startsWith('session.status') || (ev.type ?? '').startsWith('session.error')) {
        console.log(JSON.stringify(ev, null, 2));
      }
      if (ev.type === 'agent.message') {
        const textBlock = (ev.content ?? []).find((c) => c?.type === 'text');
        if (textBlock?.text) finalText = textBlock.text;
      }
      if (ev.type === 'session.status.idle' || ev.type === 'session.status.terminated') {
        finished = true; break;
      }
    }
    if (finished) break;
  }

  log('result', { finished, finalText: finalText.slice(0, 500) });
};

main()
  .catch((e) => { console.error('SPIKE FAILED:', e?.message ?? e); process.exitCode = 1; })
  .finally(cleanup);
