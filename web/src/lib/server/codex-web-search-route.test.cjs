const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const ts = require('typescript')
const { createJiti } = require('jiti')

const src = path.resolve(__dirname, '../..')
const jiti = createJiti(__filename, { alias: { '@': src } })

function route(connection, authorized = true) {
    const calls = []
    const file = path.join(src, 'app/api/internal/codex/web-search/route.ts')
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText
    const mocks = {
        '@/lib/db': { getPrismaClient: () => ({ codexConnection: { findFirst: async ({ where }) => {
            assert.deepEqual(where, { id: 'connection', ownerId: 'owner', providerType: 'custom' })
            return connection
        } } }) },
        '@/lib/server/codex-internal-auth': { isValidCodexInternalToken: () => authorized },
        '@/lib/server/ai-credentials': { decryptApiKey: (key) => { assert.equal(key, 'encrypted'); return 'secret' } },
        '@/lib/server/deepseek-web-search': { searchDeepSeekWeb: async (input) => {
            calls.push(input)
            return { text: 'Found.', sources: [{ url: 'https://example.com', title: 'Example' }] }
        } },
    }
    const module = { exports: {} }
    new Function('require', 'module', 'exports', code)((name) => mocks[name] ?? (name.startsWith('@/') ? jiti(name) : require(name)), module, module.exports)
    return { ...module.exports, calls }
}

function request(body = { ownerId: 'owner', connectionId: 'connection', query: 'Search query' }) {
    return new Request('http://localhost/web-search', { method: 'POST', body: JSON.stringify(body) })
}
const connection = { upstreamFormat: 'responses', baseUrl: 'https://api.deepseek.com/v1', encryptedApiKey: 'encrypted' }

test('search route authorizes the owner and uses only the configured connection key', async () => {
    const handler = route(connection)
    const response = await handler.POST(request())
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.ok, true)
    assert.equal(handler.calls[0].apiKey, 'secret')
    assert.equal(handler.calls[0].baseUrl, connection.baseUrl)
    assert.equal(JSON.stringify(payload).includes('secret'), false)
})

test('search route rejects unauthenticated, missing, nonofficial, and non-Responses connections', async () => {
    for (const [configured, authorized, status] of [
        [connection, false, 403],
        [null, true, 404],
        [{ ...connection, baseUrl: 'https://api.deepseek.com.example/v1' }, true, 400],
        [{ ...connection, baseUrl: 'https://api.commandcode.ai/provider/v1' }, true, 400],
        [{ ...connection, upstreamFormat: 'anthropic-messages' }, true, 400],
        [{ ...connection, encryptedApiKey: null }, true, 400],
    ]) {
        const handler = route(configured, authorized)
        assert.equal((await handler.POST(request())).status, status)
        assert.equal(handler.calls.length, 0)
    }
    assert.equal((await route(connection).POST(request({ ownerId: 'owner', connectionId: 'connection', query: ' ' }))).status, 400)
})
