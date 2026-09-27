import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { createDefaultCodexProviderModel } from '@/lib/codex-config'
import { inheritCodexModelConfig, syncCodexConnectionRuntimeFiles } from './codex-runtime-config'

test('official connections remove model overrides while preserving MCP and application configuration', () => {
    const config = [
        'model = "gpt-old"', 'model_context_window = 300000', 'model_auto_compact_token_limit = 285000',
        'model_reasoning_effort = "medium"', 'disable_response_storage = true',
        'model_catalog_json = "custom.json"', 'developer_instructions = "Project instructions"',
        '[mcp_servers.opennovelwriter]', 'command = "node"', 'model = "keep nested values"',
    ].join('\n')
    assert.equal(inheritCodexModelConfig(config), [
        'developer_instructions = "Project instructions"', '[mcp_servers.opennovelwriter]',
        'command = "node"', 'model = "keep nested values"', '',
    ].join('\n'))
})

test('existing ChatGPT connections inherit defaults without altering login credentials', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'onw-native-config-'))
    const original = process.env.OPENNOVELWRITER_DATA_DIR
    process.env.OPENNOVELWRITER_DATA_DIR = directory
    try {
        const home = path.join(directory, 'codex', 'connections', 'test', 'official')
        await fs.mkdir(home, { recursive: true })
        await fs.writeFile(path.join(home, 'config.toml'), 'model_context_window = 300000\n')
        await fs.writeFile(path.join(home, 'auth.json'), '{"testCredential":"preserve"}')
        await syncCodexConnectionRuntimeFiles({
            id: 'official', ownerId: 'test', providerType: 'openai-official',
            upstreamFormat: null, baseUrl: null, defaultModelId: null, modelsJson: '[]',
        })
        assert.equal((await fs.readFile(path.join(home, 'config.toml'), 'utf8')).trim(), '')
        assert.equal(await fs.readFile(path.join(home, 'auth.json'), 'utf8'), '{"testCredential":"preserve"}')
    } finally {
        if (original === undefined) delete process.env.OPENNOVELWRITER_DATA_DIR
        else process.env.OPENNOVELWRITER_DATA_DIR = original
        await fs.rm(directory, { recursive: true, force: true })
    }
})

test('enables hosted Anthropic search only for the official DeepSeek connection', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'onw-runtime-search-'))
    const original = process.env.OPENNOVELWRITER_DATA_DIR
    process.env.OPENNOVELWRITER_DATA_DIR = directory
    try {
        for (const [id, baseUrl, mode] of [
            ['deepseek', 'https://api.deepseek.com/anthropic', 'live'],
            ['anthropic', 'https://api.anthropic.com', 'disabled'],
            ['aggregator', 'https://api.deepseek.com.example/anthropic', 'disabled'],
        ]) {
            const home = await syncCodexConnectionRuntimeFiles({
                id, ownerId: 'test', providerType: 'custom', upstreamFormat: 'anthropic-messages',
                baseUrl, defaultModelId: 'deepseek-flash', modelsJson: JSON.stringify([createDefaultCodexProviderModel('deepseek-flash')]),
            })
            const config = await fs.readFile(path.join(home, 'config.toml'), 'utf8')
            assert.ok(config.includes(`web_search = "${mode}"`))
            const catalog = JSON.parse(await fs.readFile(path.join(home, 'opennovelwriter-model-catalog.json'), 'utf8'))
            assert.equal(catalog.models[0].web_search_tool_type, mode === 'live' ? 'text' : undefined)
        }
        for (const baseUrl of ['https://api.deepseek.com', 'https://api.deepseek.com/v1', 'https://api.commandcode.ai/provider/v1']) {
            const home = await syncCodexConnectionRuntimeFiles({
                id: 'responses', ownerId: 'test', providerType: 'custom', upstreamFormat: 'responses',
                baseUrl, defaultModelId: 'deepseek-flash', modelsJson: JSON.stringify([createDefaultCodexProviderModel('deepseek-flash')]),
            })
            const config = await fs.readFile(path.join(home, 'config.toml'), 'utf8')
            assert.equal(config.includes('web_search = "disabled"'), baseUrl.startsWith('https://api.deepseek.com'))
            assert.ok(config.includes('wire_api = "responses"'))
            assert.equal(config.includes('model_context_window'), false)
            assert.equal(config.includes('model_auto_compact_token_limit'), false)
            assert.equal(config.includes('model_reasoning_effort'), false)
        }
    } finally {
        if (original === undefined) delete process.env.OPENNOVELWRITER_DATA_DIR
        else process.env.OPENNOVELWRITER_DATA_DIR = original
        await fs.rm(directory, { recursive: true, force: true })
    }
})
