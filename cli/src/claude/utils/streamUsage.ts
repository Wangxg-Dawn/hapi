import type { SDKMessage } from '@/claude/sdk'

/**
 * Per-request token usage from the partial stream.
 *
 * Claude Code reports usage on the partial stream (`--include-partial-messages`)
 * only: the complete `assistant` messages it also emits carry zeroed usage, and
 * the real per-request numbers arrive on `stream_event/message_delta` at the end
 * of each API request. Without this the hub sees no claude usage at all — the
 * token summary and the token-speed page would stay codex/pi only.
 */
export type ClaudeRequestUsage = {
    /** Model reported for this request, when the stream named one. */
    model: string | null
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheCreationTokens: number
}

type StreamEvent = {
    type?: string
    message?: { model?: unknown }
    usage?: Record<string, unknown>
}

function count(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? Math.floor(value)
        : 0
}

export class ClaudeStreamUsage {
    private model: string | null = null

    /**
     * Feed SDK messages in stream order. Returns one record per completed API
     * request, or null for every other message.
     */
    onMessage(message: SDKMessage): ClaudeRequestUsage | null {
        if (message.type !== 'stream_event') return null
        const event = message.event as StreamEvent | undefined
        if (!event || typeof event.type !== 'string') return null

        if (event.type === 'message_start') {
            const model = event.message?.model
            this.model = typeof model === 'string' && model.trim() ? model.trim() : null
            return null
        }
        if (event.type !== 'message_delta') return null

        const usage = event.usage
        if (!usage) return null
        const record: ClaudeRequestUsage = {
            model: this.model,
            inputTokens: count(usage.input_tokens),
            outputTokens: count(usage.output_tokens),
            cacheReadTokens: count(usage.cache_read_input_tokens),
            cacheCreationTokens: count(usage.cache_creation_input_tokens)
        }
        const total = record.inputTokens + record.outputTokens + record.cacheReadTokens + record.cacheCreationTokens
        return total > 0 ? record : null
    }
}
