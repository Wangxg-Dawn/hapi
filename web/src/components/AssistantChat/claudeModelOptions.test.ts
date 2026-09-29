import { describe, expect, it } from 'vitest'
import { getClaudeComposerModelOptions, getNextClaudeComposerModel } from './claudeModelOptions'

describe('getClaudeComposerModelOptions', () => {
    it('includes the active non-preset Claude model in the options list', () => {
        expect(getClaudeComposerModelOptions('claude-opus-4-1-20250805')).toEqual([
            { value: null, label: 'Default' },
            { value: 'claude-opus-4-1-20250805', label: 'claude-opus-4-1-20250805' },
            { value: 'mimo-v2.6-pro[1M]', label: 'MiMo v2.6 Pro' },
            { value: 'glm-5.3[1M]', label: 'GLM-5.3' },
            { value: 'deepseek-v4.1-flash[1M]', label: 'DeepSeek V4.1 Flash' },
            { value: 'glm-5.3-flashx[1M]', label: 'GLM-5.3-FlashX' },
            { value: 'glm-5.3-flash[1M]', label: 'GLM-5.3-Flash' },
            { value: 'mimo-v2.6-flash[1M]', label: 'MiMo v2.6 Flash' },
        ])
    })

    it('does not duplicate preset Claude models', () => {
        expect(getClaudeComposerModelOptions('glm-5.3[1M]')).toEqual([
            { value: null, label: 'Default' },
            { value: 'mimo-v2.6-pro[1M]', label: 'MiMo v2.6 Pro' },
            { value: 'glm-5.3[1M]', label: 'GLM-5.3' },
            { value: 'deepseek-v4.1-flash[1M]', label: 'DeepSeek V4.1 Flash' },
            { value: 'glm-5.3-flashx[1M]', label: 'GLM-5.3-FlashX' },
            { value: 'glm-5.3-flash[1M]', label: 'GLM-5.3-Flash' },
            { value: 'mimo-v2.6-flash[1M]', label: 'MiMo v2.6 Flash' },
        ])
    })
})

describe('getNextClaudeComposerModel', () => {
    it('cycles from a non-preset Claude model to the next selectable model instead of auto', () => {
        expect(getNextClaudeComposerModel('claude-opus-4-1-20250805')).toBe('mimo-v2.6-pro[1M]')
    })
})
