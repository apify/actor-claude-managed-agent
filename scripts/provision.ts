/**
 * One-time developer setup. Run locally before publishing your fork:
 *
 *   ANTHROPIC_API_KEY=sk-ant-... \
 *     npx tsx scripts/provision.ts --name "My Agent" --system "You are…" [--model claude-opus-4-8]
 *
 * Creates the Managed Agent (with EMPTY mcp_servers — the Actor injects them
 * per run) and one cloud Environment, then prints the two IDs to paste into
 * your Apify Actor secrets:
 *
 *   ANTHROPIC_AGENT_ID
 *   ANTHROPIC_ENVIRONMENT_ID
 *
 * The Actor runtime never calls /v1/agents or /v1/environments — only this
 * script does.
 */

import { ANTHROPIC_BETA, ANTHROPIC_DEFAULT_BASE, ANTHROPIC_VERSION } from '../src/anthropic.js';

const BASE = process.env.ANTHROPIC_BASE_URL?.replace(/\/$/, '') || ANTHROPIC_DEFAULT_BASE;
const BETA = ANTHROPIC_BETA;
const VERSION = ANTHROPIC_VERSION;

interface Args {
    name: string;
    system: string;
    model: string;
    envName: string;
}

function parseArgs(argv: string[]): Args {
    const get = (flag: string): string | undefined => {
        const i = argv.indexOf(flag);
        if (i < 0) return undefined;
        const next = argv[i + 1];
        // Guard against a missing value swallowing the following flag.
        if (next === undefined || next.startsWith('--')) fail(`Flag ${flag} requires a value.`);
        return next;
    };
    if (argv.includes('--help') || argv.includes('-h')) {
        printHelpAndExit(0);
    }
    const name = get('--name') ?? process.env.AGENT_NAME ?? '';
    const system = get('--system') ?? process.env.AGENT_SYSTEM ?? '';
    const model = get('--model') ?? process.env.AGENT_MODEL ?? 'claude-opus-4-8';
    const envName = get('--env-name') ?? process.env.AGENT_ENV_NAME ?? `${slug(name) || 'claude-agent'}-env`;
    if (!name) fail('Missing --name (or AGENT_NAME).');
    if (!system) fail('Missing --system (or AGENT_SYSTEM).');
    return { name, system, model, envName };
}

function slug(s: string): string {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 40);
}

function fail(msg: string): never {
    console.error(`Error: ${msg}\n`);
    printHelpAndExit(1);
}

function printHelpAndExit(code: number): never {
    console.log(`Usage:
  ANTHROPIC_API_KEY=sk-ant-... tsx scripts/provision.ts \\
    --name "My Agent" --system "You are a helpful assistant." [--model claude-opus-4-8] [--env-name my-env]

Flags (or env vars):
  --name       AGENT_NAME      Human-readable agent name (required)
  --system     AGENT_SYSTEM    System prompt (required)
  --model      AGENT_MODEL     Model id (default: claude-opus-4-8)
  --env-name   AGENT_ENV_NAME  Environment name (default: <name>-env)`);
    process.exit(code);
}

async function api<T>(path: string, body: unknown): Promise<T> {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) fail('Missing ANTHROPIC_API_KEY in environment.');
    const res = await fetch(`${BASE}${path}`, {
        method: 'POST',
        headers: {
            'x-api-key': apiKey,
            'anthropic-version': VERSION,
            'anthropic-beta': BETA,
            'content-type': 'application/json',
        },
        body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
        throw new Error(`POST ${path} → ${res.status}: ${text}`);
    }
    try {
        return JSON.parse(text) as T;
    } catch {
        throw new Error(`POST ${path} → ${res.status}: response was not JSON: ${text.slice(0, 200)}`);
    }
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));

    console.error(`Creating environment "${args.envName}"…`);
    const env = await api<{ id: string }>('/v1/environments', {
        name: args.envName,
        config: { type: 'cloud', networking: { type: 'unrestricted' } },
    });

    console.error(`Creating agent "${args.name}" (model ${args.model})…`);
    const agent = await api<{ id: string; version: number }>('/v1/agents', {
        name: args.name,
        model: args.model,
        system: args.system,
        // IMPORTANT: empty — the Actor injects mcp_servers per session.
        mcp_servers: [],
        tools: [{ type: 'agent_toolset_20260401' }],
    });

    console.error('\nDone. Set these as Actor secrets (Apify Console → Actor → Settings → Environment variables):\n');
    console.log(`ANTHROPIC_AGENT_ID=${agent.id}`);
    console.log(`ANTHROPIC_ENVIRONMENT_ID=${env.id}`);
}

main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
});
