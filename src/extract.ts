/**
 * Pull the assistant's text out of an agent.message event returned by
 * GET /v1/sessions/{id}/events. The exact nesting varies in practice so we
 * try a few common paths and concatenate any non-empty "text" blocks.
 */

interface TextBlock {
    type: string;
    text?: string;
}

interface MaybeContentful {
    content?: TextBlock[];
    message?: { content?: TextBlock[] };
    data?: { content?: TextBlock[] };
    result?: { content?: TextBlock[] };
}

export interface SessionEvent {
    id: string;
    type: string;
    /** ISO-8601 timestamp; present on all events returned by the events list endpoint. */
    created_at?: string;
    data?: MaybeContentful & Record<string, unknown>;
}

export function extractTextFromEvent(event: SessionEvent | null | undefined): string | null {
    const d = event?.data ?? event;
    if (!d) return null;
    const m = d as MaybeContentful;

    const candidates = [m.content, m.message?.content, m.data?.content, m.result?.content];
    for (const c of candidates) {
        if (!Array.isArray(c)) continue;
        const texts = c
            .filter((b): b is TextBlock & { text: string } => b?.type === 'text' && !!b.text?.trim())
            .map((b) => b.text.trim());
        if (texts.length) return texts.join('\n');
    }
    return null;
}
