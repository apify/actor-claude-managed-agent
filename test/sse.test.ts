import { describe, expect, it } from 'vitest';

import {
    agentMessageText,
    consumeSessionStream,
    finalAnswerText,
    frameToEvent,
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

describe('SseParser', () => {
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

    it('flush() parses a trailing frame not terminated by a blank line', () => {
        const p = new SseParser();
        expect(p.push('data: {"type":"session.status_idle"}')).toEqual([]); // buffered, no \n\n
        expect(p.flush().map((e) => e.type)).toEqual(['session.status_idle']);
        expect(p.flush()).toEqual([]); // buffer cleared
    });
});

describe('agentMessageText / finalAnswerText', () => {
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

    it('returns the final-answer run after the last tool use', () => {
        const events: SessionStreamEvent[] = [
            { type: 'agent.message', content: [{ type: 'text', text: 'let me check' }] },
            { type: 'agent.mcp_tool_use' },
            { type: 'agent.message', content: [{ type: 'text', text: 'the answer' }] },
        ];
        expect(finalAnswerText(events)).toBe('the answer');
    });

    it('joins a multi-frame final answer (no tool boundary)', () => {
        const events: SessionStreamEvent[] = [
            { type: 'agent.message', content: [{ type: 'text', text: 'part 1' }] },
            { type: 'span.model_request_end' }, // non-message, non-tool: skipped, not a boundary
            { type: 'agent.message', content: [{ type: 'text', text: 'part 2' }] },
        ];
        expect(finalAnswerText(events)).toBe('part 1\npart 2');
    });

    it('returns empty when there is no trailing message', () => {
        expect(finalAnswerText([{ type: 'agent.mcp_tool_use' }])).toBe('');
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

    it('clears the recovered session.error message on a successful idle', async () => {
        const stream = chunks(
            'data: {"type":"session.error","error":{"message":"transient"}}\n\n',
            'data: {"type":"agent.message","content":[{"type":"text","text":"recovered"}]}\n\n',
            'data: {"type":"session.status_idle"}\n\n',
        );
        const res = await consumeSessionStream(stream, () => {});
        expect(res.outcome).toBe('idle');
        expect(res.errorMessage).toBeNull();
    });

    it('treats a clean close after an answer (no idle frame) as success', async () => {
        const stream = chunks(
            'data: {"type":"agent.message","content":[{"type":"text","text":"done"}]}\n\n',
        );
        const res = await consumeSessionStream(stream, () => {});
        expect(res.outcome).toBe('idle');
    });

    it('reports stream_dropped when the stream ends with no answer and no terminal', async () => {
        const res = await consumeSessionStream(chunks('data: {"type":"agent.thinking"}\n\n'), () => {});
        expect(res.outcome).toBe('stream_dropped');
    });

    it('parses a terminal frame that lacks a trailing blank line before close', async () => {
        // Final idle frame arrives WITHOUT the trailing \n\n, then the stream closes.
        const stream = chunks(
            'data: {"type":"agent.message","content":[{"type":"text","text":"x"}]}\n\n',
            'data: {"type":"session.status_idle"}',
        );
        const res = await consumeSessionStream(stream, () => {});
        expect(res.outcome).toBe('idle');
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

    it('preserves a multibyte char split across the final chunk boundary', async () => {
        // '✓' is e2 9c 93; split the 3 bytes across two chunks, last frame unterminated.
        const bytes = enc('data: {"type":"agent.message","content":[{"type":"text","text":"✓"}]}');
        const cut = bytes.length - 1; // split the last UTF-8 byte off
        async function* split(): AsyncIterable<Uint8Array> {
            yield bytes.slice(0, cut);
            yield bytes.slice(cut);
        }
        const seen: SessionStreamEvent[] = [];
        const res = await consumeSessionStream(split(), (e) => seen.push(e));
        expect(res.outcome).toBe('idle'); // saw an answer
        expect(agentMessageText(seen[0]!)).toBe('✓'); // not corrupted/dropped
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
