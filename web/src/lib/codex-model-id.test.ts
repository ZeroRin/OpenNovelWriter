import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isGptCodexModelId, getDefaultCodexConfig } from './codex-config'

test('GPT routing recognizes provider prefixes without maintaining a model whitelist', () => {
    for (const id of ['gpt-5.5', 'gpt-6-sol', 'openai/gpt-future', ' GPT-NEXT ', 'gpt-future:fast']) {
        assert.equal(isGptCodexModelId(id), true, id)
    }
    for (const id of ['deepseek-v4-flash', 'claude-sonnet', 'not-gpt-6-astra']) {
        assert.equal(isGptCodexModelId(id), false, id)
    }
})

test('new official connections use native Codex model defaults', () => {
    assert.equal(getDefaultCodexConfig('openai-official').trim(), '')
})
