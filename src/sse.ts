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
 * of byte chunks via a reader. Cancels the underlying stream on early exit
 * (e.g. when the consumer `return`s on a terminal event), so the HTTP body is
 * torn down rather than left dangling.
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
        // cancel() (not just releaseLock()) closes the body / underlying socket.
        await reader.cancel().catch(() => {});
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
        return frames.map(frameToEvent).filter((e): e is SessionStreamEvent => e !== null);
    }

    /**
     * Parse any buffered trailing frame that was NOT terminated by a blank
     * line before the stream ended. A well-behaved server terminates every
     * frame with `\n\n`, but some close the connection right after the final
     * event without the trailing blank line; without this the final
     * (possibly terminal) event would be silently dropped.
     */
    flush(): SessionStreamEvent[] {
        const tail = this.buffer.trim();
        this.buffer = '';
        if (!tail) return [];
        const ev = frameToEvent(tail);
        return ev ? [ev] : [];
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

/** Tool events mark the boundary between the final answer and earlier turns. */
const TOOL_EVENT_TYPES = new Set([
    'agent.tool_use',
    'agent.mcp_tool_use',
    'agent.tool_result',
    'agent.mcp_tool_result',
]);

/**
 * The agent's final answer: the text of the trailing run of `agent.message`
 * events (those after the last tool use/result). This is robust whether the
 * answer arrives as a single `agent.message` or is split across several
 * consecutive frames, and it excludes interim chatter that preceded a tool
 * call. Non-message, non-tool events (thinking, spans) between message frames
 * are skipped, not treated as a boundary.
 */
export function finalAnswerText(events: SessionStreamEvent[]): string {
    const texts: string[] = [];
    for (let i = events.length - 1; i >= 0; i--) {
        const event = events[i];
        if (event.type && TOOL_EVENT_TYPES.has(event.type)) break;
        const text = agentMessageText(event);
        if (text) texts.unshift(text);
    }
    return texts.join('\n');
}

export type StreamOutcome = 'idle' | 'terminated' | 'timeout' | 'stream_dropped';

export interface StreamResult {
    outcome: StreamOutcome;
    /** Latest session.error message observed on an abnormal outcome; null on success. */
    errorMessage: string | null;
}

/** Terminal event types. `session.status_idle` = success; the rest = failure. */
const TERMINAL_TYPES = new Set(['session.status_idle', 'session.status_terminated']);

/**
 * Consume a byte stream of SSE events, invoking `onEvent` for every parsed
 * event, until a terminal event arrives or the stream ends/aborts.
 *
 * Outcomes:
 *  - `idle`           — saw `session.status_idle`, OR the stream closed cleanly
 *                       after delivering at least one answer message (some
 *                       servers signal end-of-turn by closing the connection
 *                       without a trailing idle frame).
 *  - `terminated`     — saw `session.status_terminated`.
 *  - `timeout`        — the caller's AbortSignal fired (deadline).
 *  - `stream_dropped` — the stream ended/failed with no terminal event and no
 *                       answer captured.
 *
 * `session.error` is recorded but NOT treated as terminal: the docs note it
 * carries a `retry_status`, so the harness may recover. The message is
 * surfaced only on an abnormal outcome (cleared on success).
 */
export async function consumeSessionStream(
    stream: AsyncIterable<Uint8Array>,
    onEvent: (event: SessionStreamEvent) => void,
    signal?: AbortSignal,
): Promise<StreamResult> {
    const parser = new SseParser();
    const decoder = new TextDecoder();
    let lastErrorMessage: string | null = null;
    let sawAnswer = false;

    // Process a batch of parsed events; return a terminal StreamResult or null.
    const handle = (events: SessionStreamEvent[]): StreamResult | null => {
        for (const event of events) {
            onEvent(event);
            if (agentMessageText(event)) sawAnswer = true;
            if (event.type === 'session.error' && event.error?.message) {
                lastErrorMessage = event.error.message;
            }
            if (event.type && TERMINAL_TYPES.has(event.type)) {
                const idle = event.type === 'session.status_idle';
                return { outcome: idle ? 'idle' : 'terminated', errorMessage: idle ? null : lastErrorMessage };
            }
        }
        return null;
    };

    try {
        for await (const chunk of stream) {
            const result = handle(parser.push(decoder.decode(chunk, { stream: true })));
            if (result) return result;
        }
        // Flush any buffered multibyte tail + any frame not terminated by `\n\n`.
        const tailResult = handle([...parser.push(decoder.decode()), ...parser.flush()]);
        if (tailResult) return tailResult;
    } catch (err) {
        if (signal?.aborted) return { outcome: 'timeout', errorMessage: lastErrorMessage };
        return { outcome: 'stream_dropped', errorMessage: lastErrorMessage ?? (err as Error).message };
    }

    if (signal?.aborted) return { outcome: 'timeout', errorMessage: lastErrorMessage };
    // Clean close with an answer = success; otherwise a genuine drop.
    if (sawAnswer) return { outcome: 'idle', errorMessage: null };
    return { outcome: 'stream_dropped', errorMessage: lastErrorMessage };
}
