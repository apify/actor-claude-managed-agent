/**
 * Full end-to-end test of the real Actor process.
 *
 *   tsx src/main.ts  (real Actor + real src/server.ts proxy)
 *        │  creates vault/session on ─────────────▶  fake Anthropic API
 *        │                                                │ on user.message, acts as an MCP client and
 *        │  ◀─── SSE events (incl. echoed result) ───────┤ calls back into the Actor's /mcp/<id> …
 *        ▼                                                ▼
 *   writes dataset                              Actor /mcp ──▶ fake upstream (echo tool)
 *
 * Only Anthropic + the Apify MCP Proxy are faked. The Actor, its container web
 * server, the MCP proxying, the orchestration and the dataset output are all real.
 */
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { freePort, startFakeUpstream, type FakeUpstream } from './helpers/mcp-upstream.js';

const REPO = join(import.meta.dirname, '..');

interface FakeAnthropic {
    baseUrl: string;
    close: () => Promise<void>;
    sawDeleteVault: () => boolean;
}

/**
 * Fake Anthropic Managed Agents API. On `user.message` it behaves like the real
 * agent: it connects (as an MCP client) to the URL the Actor injected into the
 * session's mcp_servers, calls the `echo` tool, and streams the result back as
 * SSE `agent.message` + `session.status_idle`.
 */
async function startFakeAnthropic(): Promise<FakeAnthropic> {
    const app = express();
    app.use(express.json());

    const streams = new Map<string, express.Response>();
    let mcpUrl: string | null = null;
    let mcpToken: string | null = null;
    let deletedVault = false;

    app.post('/v1/vaults', (_req, res) => res.json({ id: 'vlt_e2e' }));
    app.post('/v1/vaults/:id/credentials', (req, res) => {
        mcpToken = req.body?.auth?.token ?? null;
        res.json({ id: 'cred_e2e' });
    });
    app.delete('/v1/vaults/:id', (_req, res) => { deletedVault = true; res.json({}); });

    app.post('/v1/sessions', (_req, res) => res.json({ id: 'ses_e2e', status: 'idle' }));
    // session update — capture the injected mcp server URL
    app.post('/v1/sessions/:id', (req, res) => {
        const servers = req.body?.agent?.mcp_servers as Array<{ url: string }> | undefined;
        if (servers?.[0]) mcpUrl = servers[0].url;
        res.json({ id: req.params.id });
    });
    // session detail GET (inherited agent tools)
    app.get('/v1/sessions/:id', (req, res) => {
        res.json({ id: req.params.id, agent: { tools: [{ type: 'agent_toolset_20260401' }] } });
    });
    // SSE stream — keep open, store by session id
    app.get('/v1/sessions/:id/events/stream', (req, res) => {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
        });
        res.write(': open\n\n');
        streams.set(req.params.id, res);
    });
    // user.message — drive the agent turn, then stream results
    app.post('/v1/sessions/:id/events', (req, res) => {
        res.json({}); // ack immediately
        void driveAgentTurn(req.params.id);
    });

    async function driveAgentTurn(sessionId: string): Promise<void> {
        const res = streams.get(sessionId);
        if (!res) return;
        const emit = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
        try {
            emit({ id: 'm1', type: 'agent.message', content: [{ type: 'text', text: 'Calling the tool…' }] });

            // Behave like the real agent: call the MCP server the Actor advertised.
            const client = new Client({ name: 'fake-anthropic', version: '1.0.0' });
            const transport = new StreamableHTTPClientTransport(new URL(mcpUrl!), {
                requestInit: { headers: { Authorization: `Bearer ${mcpToken}` } },
            });
            await client.connect(transport);
            const tools = await client.listTools();
            emit({ id: 't1', type: 'agent.mcp_tool_use', name: 'echo', available: tools.tools.map((t) => t.name) });
            const call = await client.callTool({ name: 'echo', arguments: { text: 'e2e' } });
            await client.close();

            const toolText = (call.content as Array<{ type: string; text?: string }>)
                .find((c) => c.type === 'text')?.text ?? '';
            emit({ id: 'm2', type: 'agent.message', content: [{ type: 'text', text: `Tool said: ${toolText}` }] });
            emit({ id: 's1', type: 'session.status_idle', stop_reason: 'end_turn' });
        } catch (err) {
            emit({ id: 'err', type: 'session.error', error: { message: (err as Error).message } });
            emit({ id: 'term', type: 'session.status_terminated' });
        } finally {
            res.end();
        }
    }

    const http: HttpServer = await new Promise((resolve) => {
        const s = createServer(app);
        s.listen(0, '127.0.0.1', () => resolve(s));
    });
    const port = (http.address() as AddressInfo).port;
    return {
        baseUrl: `http://127.0.0.1:${port}`,
        sawDeleteVault: () => deletedVault,
        close: () => new Promise<void>((resolve) => http.close(() => resolve())),
    };
}

interface ActorResult { code: number | null; stdout: string; stderr: string; }

function runActor(env: Record<string, string>, cwd: string): Promise<ActorResult> {
    return new Promise((resolve) => {
        const child = spawn(join(REPO, 'node_modules/.bin/tsx'), ['src/main.ts'], {
            cwd: REPO,
            env: { ...process.env, ...env, CRAWLEE_STORAGE_DIR: cwd, CRAWLEE_PURGE_ON_START: 'false' },
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => { stdout += d.toString(); });
        child.stderr.on('data', (d) => { stderr += d.toString(); });
        child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
}

async function readDataset(storageDir: string, name = 'default'): Promise<Array<Record<string, unknown>>> {
    const dir = join(storageDir, 'datasets', name);
    const files = (await readdir(dir).catch(() => [])).filter((f) => f.endsWith('.json')).sort();
    const items: Array<Record<string, unknown>> = [];
    for (const f of files) items.push(JSON.parse(await readFile(join(dir, f), 'utf8')));
    return items;
}

describe('end-to-end Actor run', () => {
    let upstream: FakeUpstream;
    let anthropic: FakeAnthropic;
    let storageDir: string;
    let result: ActorResult;

    beforeAll(async () => {
        upstream = await startFakeUpstream();
        anthropic = await startFakeAnthropic();
        const actorPort = await freePort();
        storageDir = await mkdtemp(join(tmpdir(), 'actor-e2e-'));

        // Seed the Actor input into the default KV store.
        const kvDir = join(storageDir, 'key_value_stores', 'default');
        await mkdir(kvDir, { recursive: true });
        await writeFile(join(kvDir, 'INPUT.json'), JSON.stringify({ prompt: 'use the echo tool', mcpConnectors: ['conn_test'] }));

        result = await runActor(
            {
                ANTHROPIC_BASE_URL: anthropic.baseUrl,
                ANTHROPIC_API_KEY: 'sk-test',
                ANTHROPIC_AGENT_ID: 'ag_test',
                ANTHROPIC_ENVIRONMENT_ID: 'env_test',
                APIFY_MCP_PROXY_URL: upstream.baseUrl,
                APIFY_CONTAINER_URL: `http://127.0.0.1:${actorPort}`,
                ACTOR_WEB_SERVER_PORT: String(actorPort),
                APIFY_TOKEN: 'apify-run-token',
                APIFY_ACTOR_RUN_ID: 'run_e2e',
            },
            storageDir,
        );
    }, 60_000);

    afterAll(async () => {
        await anthropic?.close();
        await upstream?.close();
    });

    it('exits 0', () => {
        expect(result.code, `stderr:\n${result.stderr}\nstdout:\n${result.stdout}`).toBe(0);
    });

    it('writes the tool-derived answer to the default dataset', async () => {
        const items = await readDataset(storageDir);
        expect(items).toHaveLength(1);
        expect(items[0].answer).toBe('Tool said: echo:e2e');
        expect(items[0].error).toBeNull();
        expect(items[0].sessionId).toBe('ses_e2e');
        expect(items[0].partial).toBe(false);
    });

    it('writes the full transcript to the debug dataset', async () => {
        const debug = await readDataset(storageDir, 'debug');
        const types = debug.map((d) => d.type);
        expect(types).toContain('agent.message');
        expect(types).toContain('agent.mcp_tool_use');
        expect(types).toContain('session.status_idle');
    });

    it('forwarded the Apify run token through to the upstream proxy', () => {
        expect(upstream.lastAuth()).toBe('Bearer apify-run-token');
    });

    it('deleted the vault during cleanup', () => {
        expect(anthropic.sawDeleteVault()).toBe(true);
    });
});
