import { describe, expect, it } from 'vitest'
import { ClaudeStreamUsage } from './streamUsage'
import type { SDKMessage } from '@/claude/sdk'

const messageStart = (model: string): SDKMessage => ({
    type: 'stream_event',
    event: { type: 'message_start', message: { model } }
})

const messageDelta = (usage: Record<string, unknown>): SDKMessage => ({
    type: 'stream_event',
    event: { type: 'message_delta', usage }
})

describe('ClaudeStreamUsage', () => {
    it('reports one record per completed request, tagged with the request model', () => {
        const usage = new ClaudeStreamUsage()

        expect(usage.onMessage(messageStart('deepseek-v4.1-flash'))).toBeNull()
        expect(usage.onMessage({
            type: 'stream_event',
            event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } }
        })).toBeNull()

        expect(usage.onMessage(messageDelta({
            input_tokens: 32246,
            output_tokens: 431,
            cache_read_input_tokens: 256,
            cache_creation_input_tokens: 0
        }))).toEqual({
            model: 'deepseek-v4.1-flash',
            inputTokens: 32246,
            outputTokens: 431,
            cacheReadTokens: 256,
            cacheCreationTokens: 0
        })
    })

    it('keeps model per request across a tool-using turn', () => {
        const usage = new ClaudeStreamUsage()
        usage.onMessage(messageStart('glm-5.3'))
        usage.onMessage(messageDelta({ input_tokens: 10, output_tokens: 3 }))
        usage.onMessage(messageStart('mimo-v2.6-flash'))
        const second = usage.onMessage(messageDelta({ input_tokens: 20, output_tokens: 5 }))

        expect(second?.model).toBe('mimo-v2.6-flash')
        expect(second?.outputTokens).toBe(5)
    })

    it('drops requests whose usage is absent or all zeros', () => {
        const usage = new ClaudeStreamUsage()

        expect(usage.onMessage(messageDelta({ input_tokens: 0, output_tokens: 0 }))).toBeNull()
        expect(usage.onMessage({
            type: 'stream_event',
            event: { type: 'message_delta', delta: { stop_reason: 'end_turn' } }
        })).toBeNull()
    })

    it('ignores the complete messages Claude Code also emits (their usage is zeroed)', () => {
        const usage = new ClaudeStreamUsage()

        expect(usage.onMessage({
            type: 'assistant',
            message: { id: 'msg-1', model: 'glm-5.3', usage: { input_tokens: 0, output_tokens: 0 } }
        })).toBeNull()
        expect(usage.onMessage({ type: 'result', usage: { input_tokens: 100, output_tokens: 10 } })).toBeNull()
    })

    it('reports a request with no model when the stream never named one', () => {
        const usage = new ClaudeStreamUsage()

        expect(usage.onMessage(messageDelta({ input_tokens: 7, output_tokens: 2 }))).toEqual({
            model: null,
            inputTokens: 7,
            outputTokens: 2,
            cacheReadTokens: 0,
            cacheCreationTokens: 0
        })
    })
})
