/**
 * Server-Sent Events parsing + the session-stream consumer.
 *
 * Anthropic's `GET /v1/sessions/{id}/events/stream` emits `text/event-stream`
 * frames. Each frame is one or more lines separated by `\n`, frames are
 * separated by a blank line (`\n\n`). We only need the `data:` lines, which
 * carry a JSON event object with a top-level `type` (e.g. `agent.message`,
 * `session.status_idle`).
 *
 * The parser is split out as a pure function so chunk-boundary handling can
 * be unit tested without a real network stream.
 */

export interface SessionStreamEvent {
    id?: string;
    type?: string;
    content?: Array<{ type?: string; text?: string }>;
    error?: { message?: string; type?: string };
    stop_reason?: string;
    [k: string]: unknown;
}

/**
 * Split a buffer into complete SSE frames plus the trailing incomplete
 * remainder. Frames are delimited by a blank line. Handles `\r\n` as well as
 * `\n`. Pure: feed it the leftover `rest` prepended to the next chunk.
 */
export function splitFrames(buffer: string): { frames: string[]; rest: string } {
    const normalized = buffer.replace(/\r\n/g, '\n');
    const parts = normalized.split('\n\n');
    const rest = parts.pop() ?? '';
    return { frames: parts.filter((f) => f.length > 0), rest };
}

/**
 * Extract and JSON-parse the `data:` payload of one frame. Per the SSE spec a
 * frame may carry multiple `data:` lines that are joined with `\n`. Returns
 * null for comment-only / dataless frames or invalid JSON.
 */
export function frameToEvent(frame: string): SessionStreamEvent | null {
    const dataLines: string[] = [];
    for (const line of frame.split('\n')) {
        if (line.startsWith('data:')) {
            // Strip "data:" and an optional single leading space.
            dataLines.push(line.slice(5).replace(/^ /, ''));
        }
    }
    if (dataLines.length === 0) return null;
    const payload = dataLines.join('\n');
    if (payload === '[DONE]') return null;
    try {
        return JSON.parse(payload) as SessionStreamEvent;
    } catch {
        return null;
    }
}

/**
 * Adapt a web `ReadableStream` (what `fetch().body` is) to an async iterable
 * of byte chunks via a reader. Works regardless of whether the runtime's
 * ReadableStream implements `Symbol.asyncIterator`.
 */
export async function* readableToAsyncIterable(
    stream: ReadableStream<Uint8Array>,
): AsyncIterable<Uint8Array> {
    const reader = stream.getReader();
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) return;
            if (value) yield value;
        }
    } finally {
        reader.releaseLock();
    }
}

/** Stateful parser that turns arbitrary string chunks into events. */
export class SseParser {
    private buffer = '';

    push(chunk: string): SessionStreamEvent[] {
        this.buffer += chunk;
        const { frames, rest } = splitFrames(this.buffer);
        this.buffer = rest;
        const events: SessionStreamEvent[] = [];
        for (const frame of frames) {
            const ev = frameToEvent(frame);
            if (ev) events.push(ev);
        }
        return events;
    }
}

/** Concatenate the text blocks of one `agent.message` event, or null. */
export function agentMessageText(event: SessionStreamEvent): string | null {
    if (event.type !== 'agent.message' || !Array.isArray(event.content)) return null;
    const texts = event.content
        .filter((b): b is { type: string; text: string } => b?.type === 'text' && !!b.text?.trim())
        .map((b) => b.text.trim());
    return texts.length ? texts.join('\n') : null;
}

/** Last non-empty `agent.message` text across a list of observed events. */
export function lastAgentMessageText(events: SessionStreamEvent[]): string {
    for (let i = events.length - 1; i >= 0; i--) {
        const text = agentMessageText(events[i]);
        if (text) return text;
    }
    return '';
}

export type StreamOutcome = 'idle' | 'terminated' | 'timeout' | 'stream_dropped';

export interface StreamResult {
    outcome: StreamOutcome;
    /** Latest session.error message observed, if any. */
    errorMessage: string | null;
}

/** Terminal event types. `session.status_idle` = success; the rest = failure. */
const TERMINAL_TYPES = new Set(['session.status_idle', 'session.status_terminated']);

/**
 * Consume a byte stream of SSE events, invoking `onEvent` for every parsed
 * event, until a terminal event arrives or the stream ends/aborts.
 *
 * `session.error` is recorded but NOT treated as terminal: the docs note it
 * carries a `retry_status`, so the harness may recover. We surface the last
 * error message only if the run ultimately ends abnormally.
 *
 * Timeout/abort is the caller's job: pass an `AbortSignal` to the fetch that
 * produced `stream`. When aborted, iteration throws and we map it to the
 * `timeout` outcome (if `signal.aborted`) or `stream_dropped`.
 */
export async function consumeSessionStream(
    stream: AsyncIterable<Uint8Array>,
    onEvent: (event: SessionStreamEvent) => void,
    signal?: AbortSignal,
): Promise<StreamResult> {
    const parser = new SseParser();
    const decoder = new TextDecoder();
    let errorMessage: string | null = null;

    try {
        for await (const chunk of stream) {
            for (const event of parser.push(decoder.decode(chunk, { stream: true }))) {
                onEvent(event);
                if (event.type === 'session.error' && event.error?.message) {
                    errorMessage = event.error.message;
                }
                if (event.type && TERMINAL_TYPES.has(event.type)) {
                    return {
                        outcome: event.type === 'session.status_idle' ? 'idle' : 'terminated',
                        errorMessage,
                    };
                }
            }
        }
    } catch (err) {
        if (signal?.aborted) return { outcome: 'timeout', errorMessage };
        return { outcome: 'stream_dropped', errorMessage: errorMessage ?? (err as Error).message };
    }

    // Stream closed without a terminal event.
    if (signal?.aborted) return { outcome: 'timeout', errorMessage };
    return { outcome: 'stream_dropped', errorMessage };
}
