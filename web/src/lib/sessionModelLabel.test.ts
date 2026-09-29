import { describe, expect, it } from 'vitest'
import { getSessionModelLabel } from './sessionModelLabel'

describe('getSessionModelLabel', () => {
    it('prefers the explicit session model', () => {
        expect(getSessionModelLabel({ model: 'gpt-5.4' })).toEqual({
            key: 'session.item.model',
            value: 'gpt-5.4'
        })
    })

    it('renders friendly labels for known Claude models', () => {
        expect(getSessionModelLabel({ model: 'glm-5.3[1M]' })).toEqual({
            key: 'session.item.model',
            value: 'GLM-5.3'
        })
    })

    it('falls back to the raw string for retired tier aliases', () => {
        expect(getSessionModelLabel({ model: 'opus' })).toEqual({
            key: 'session.item.model',
            value: 'opus'
        })
    })

    it('returns null when no model is available', () => {
        expect(getSessionModelLabel({})).toBeNull()
    })
})
