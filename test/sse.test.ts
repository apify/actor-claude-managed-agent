import { describe, expect, it } from 'vitest';

import {
    agentMessageText,
    consumeSessionStream,
    frameToEvent,
    lastAgentMessageText,
    readableToAsyncIterable,
    splitFrames,
    SseParser,
    type SessionStreamEvent,
} from '../src/sse.js';

const enc = (s: string) => new TextEncoder().encode(s);

/** Build an async iterable from string chunks. */
async function* chunks(...parts: string[]): AsyncIterable<Uint8Array> {
    for (const p of parts) yield enc(p);
}

describe('splitFrames', () => {
    it('splits complete frames and keeps the remainder', () => {
        const { frames, rest } = splitFrames('data: 1\n\ndata: 2\n\ndata: 3');
        expect(frames).toEqual(['data: 1', 'data: 2']);
        expect(rest).toBe('data: 3');
    });

    it('normalizes CRLF', () => {
        const { frames } = splitFrames('data: a\r\n\r\n');
        expect(frames).toEqual(['data: a']);
    });
});

describe('frameToEvent', () => {
    it('parses a data line as JSON', () => {
        expect(frameToEvent('data: {"type":"agent.message"}')).toEqual({ type: 'agent.message' });
    });

    it('joins multiple data lines', () => {
        expect(frameToEvent('data: {"a":1,\ndata: "b":2}')).toEqual({ a: 1, b: 2 });
    });

    it('ignores event:/comment lines and [DONE]', () => {
        expect(frameToEvent('event: ping\n: comment')).toBeNull();
        expect(frameToEvent('data: [DONE]')).toBeNull();
    });

    it('returns null on invalid JSON', () => {
        expect(frameToEvent('data: not json')).toBeNull();
    });
});

describe('SseParser chunk boundaries', () => {
    it('reassembles an event split across chunks', () => {
        const p = new SseParser();
        expect(p.push('data: {"ty')).toEqual([]);
        expect(p.push('pe":"agent.message"}')).toEqual([]); // no frame terminator yet
        expect(p.push('\n\n')).toEqual([{ type: 'agent.message' }]);
    });

    it('emits multiple events from one chunk', () => {
        const p = new SseParser();
        const out = p.push('data: {"type":"a"}\n\ndata: {"type":"b"}\n\n');
        expect(out.map((e) => e.type)).toEqual(['a', 'b']);
    });
});

describe('agentMessageText / lastAgentMessageText', () => {
    it('concatenates text blocks of agent.message', () => {
        const ev: SessionStreamEvent = {
            type: 'agent.message',
            content: [
                { type: 'text', text: 'Hello' },
                { type: 'tool_use' },
                { type: 'text', text: 'world' },
            ],
        };
        expect(agentMessageText(ev)).toBe('Hello\nworld');
    });

    it('returns null for non-message events', () => {
        expect(agentMessageText({ type: 'agent.thinking' })).toBeNull();
    });

    it('picks the LAST non-empty agent.message', () => {
        const events: SessionStreamEvent[] = [
            { type: 'agent.message', content: [{ type: 'text', text: 'first' }] },
            { type: 'agent.tool_use' },
            { type: 'agent.message', content: [{ type: 'text', text: 'final' }] },
        ];
        expect(lastAgentMessageText(events)).toBe('final');
    });
});

describe('consumeSessionStream', () => {
    it('collects events and ends on session.status_idle', async () => {
        const stream = chunks(
            'data: {"id":"1","type":"agent.message","content":[{"type":"text","text":"hi"}]}\n\n',
            'data: {"id":"2","type":"session.status_idle","stop_reason":"end_turn"}\n\n',
        );
        const seen: string[] = [];
        const res = await consumeSessionStream(stream, (e) => seen.push(e.type ?? ''));
        expect(res.outcome).toBe('idle');
        expect(seen).toEqual(['agent.message', 'session.status_idle']);
    });

    it('ends on session.status_terminated and records prior session.error', async () => {
        const stream = chunks(
            'data: {"type":"session.error","error":{"message":"boom"}}\n\n',
            'data: {"type":"session.status_terminated"}\n\n',
        );
        const res = await consumeSessionStream(stream, () => {});
        expect(res.outcome).toBe('terminated');
        expect(res.errorMessage).toBe('boom');
    });

    it('does NOT terminate on a recoverable session.error alone', async () => {
        const stream = chunks(
            'data: {"type":"session.error","error":{"message":"transient"}}\n\n',
            'data: {"type":"agent.message","content":[{"type":"text","text":"recovered"}]}\n\n',
            'data: {"type":"session.status_idle"}\n\n',
        );
        const res = await consumeSessionStream(stream, () => {});
        expect(res.outcome).toBe('idle');
        expect(res.errorMessage).toBe('transient');
    });

    it('reports stream_dropped when stream ends with no terminal event', async () => {
        const res = await consumeSessionStream(chunks('data: {"type":"agent.message"}\n\n'), () => {});
        expect(res.outcome).toBe('stream_dropped');
    });

    it('maps an aborted stream to timeout', async () => {
        const controller = new AbortController();
        // eslint-disable-next-line require-yield
        async function* throwing(): AsyncIterable<Uint8Array> {
            controller.abort();
            throw new Error('aborted');
        }
        const res = await consumeSessionStream(throwing(), () => {}, controller.signal);
        expect(res.outcome).toBe('timeout');
    });
});

describe('readableToAsyncIterable', () => {
    it('yields chunks from a web ReadableStream', async () => {
        const rs = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(enc('data: {"type":"x"}\n\n'));
                controller.close();
            },
        });
        const parser = new SseParser();
        const types: string[] = [];
        for await (const chunk of readableToAsyncIterable(rs)) {
            for (const e of parser.push(new TextDecoder().decode(chunk))) types.push(e.type ?? '');
        }
        expect(types).toEqual(['x']);
    });
});
