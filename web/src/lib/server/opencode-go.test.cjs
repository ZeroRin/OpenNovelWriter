const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const ts = require('typescript')
const { createJiti } = require('jiti')

const src = path.resolve(__dirname, '../..')
const jiti = createJiti(__filename, { alias: { '@': src } })
const { createLanguageModel } = jiti('@/lib/server/ai-providers')
const { createDefaultCodexProviderModel } = jiti('@/lib/codex-config')
const baseUrl = 'https://opencode.ai/zen/go/v1'
const sessionHeader = 'x-opencode-session'

function load(relative, mocks) {
    const output = ts.transpileModule(fs.readFileSync(path.join(src, relative), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText
    const module = { exports: {} }
    new Function('require', 'module', 'exports', output)((name) => {
        if (Object.hasOwn(mocks, name)) return mocks[name]
        return name.startsWith('@/') ? jiti(name) : require(name)
    }, module, module.exports)
    return module.exports
}

function chatResponse() {
    return Response.json({ id: 'chat-test', object: 'chat.completion', created: 0, model: 'go-test',
        choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })
}

test('AI chat sends stable conversation headers only to the official Go endpoint', async (t) => {
    const requests = []
    t.mock.method(globalThis, 'fetch', async (url, init) => {
        requests.push({ url: String(url), headers: new Headers(init.headers) })
        return chatResponse()
    })
    const targets = [baseUrl, `${baseUrl}/`, baseUrl,
        'https://opencode.ai/zen/v1', 'https://opencode.ai.example/zen/go/v1',
        'http://opencode.ai/zen/go/v1', 'https://proxy.example/v1']
    for (const [index, target] of targets.entries()) {
        const model = createLanguageModel({ providerType: 'openai-chat', apiKey: 'test-key',
            baseUrl: target, modelId: 'go-test', sessionId: index < 2 ? 'conversation-a' : 'conversation-b' })
        await model.doGenerate({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }] })
    }
    assert.deepEqual(requests.map(({ headers }) => headers.get(sessionHeader)),
        ['conversation-a', 'conversation-a', 'conversation-b', null, null, null, null])
    for (const request of requests.slice(0, 3)) {
        assert.match(request.headers.get('user-agent'), /^OpenNovelWriter\/0\.1\.0(?: |$)/)
        assert.equal(request.headers.get('authorization'), 'Bearer test-key')
        assert.equal(request.url, `${baseUrl}/chat/completions`)
    }
    for (const request of requests.slice(3)) assert.doesNotMatch(request.headers.get('user-agent'), /OpenNovelWriter/)
})

test('Codex forwards each session through Responses, Chat and Anthropic without changing other providers', async (t) => {
    const requests = []
    t.mock.method(globalThis, 'fetch', async (url, init) => {
        requests.push({ url: String(url), headers: new Headers(init.headers) })
        if (String(url).endsWith('/chat/completions')) return chatResponse()
        if (String(url).endsWith('/messages')) return Response.json({ id: 'message-test', type: 'message', role: 'assistant',
            model: 'go-test', content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } })
        return Response.json({ id: 'response-test', object: 'response', status: 'completed', output: [] })
    })
    const formats = ['responses', 'chat-completions', 'anthropic-messages']
    const { handleCodexUpstreamRequest } = load('lib/server/codex-proxy/handler.ts', {
        '@/lib/db': { getPrismaClient: () => ({ codexConnection: { findFirst: async ({ where }) => ({
            id: where.id, ownerId: 'owner', upstreamFormat: where.id.replace('other-', ''),
            baseUrl: where.id.startsWith('other-') ? 'https://proxy.example/v1' : baseUrl,
            encryptedApiKey: 'test-key', modelsJson: JSON.stringify([createDefaultCodexProviderModel('go-test')]),
        }) } }) },
        '@/lib/server/ai-credentials': { decryptApiKey: (value) => value },
        '@/lib/server/codex-internal-auth': { isValidCodexProxyToken: () => true },
    })
    const { NextRequest } = require('next/server')
    for (const sessionId of ['session-a', 'session-b', 'session-a']) {
        await Promise.all(formats.flatMap((format) => [format, `other-${format}`]).map(async (connectionId) => {
            const request = new NextRequest('http://localhost/upstream/responses', {
                method: 'POST', headers: { authorization: 'Bearer local-token', [sessionHeader]: sessionId, 'user-agent': 'codex-test' },
                body: JSON.stringify({ model: 'go-test', stream: false, input: [{ role: 'user', content: 'Hello' }] }),
            })
            const response = await handleCodexUpstreamRequest({ request, connectionId, path: ['responses'] })
            assert.equal(response.status, 200)
        }))
    }
    for (const suffix of ['/responses', '/chat/completions', '/messages']) {
        const goRequests = requests.filter(({ url }) => url === `${baseUrl}${suffix}`)
        assert.deepEqual(goRequests.map(({ headers }) => headers.get(sessionHeader)), ['session-a', 'session-b', 'session-a'])
        assert.ok(goRequests.every(({ headers }) => headers.get('user-agent') === 'OpenNovelWriter/0.1.0'))
        const otherRequests = requests.filter(({ url }) => url === `https://proxy.example/v1${suffix}`)
        assert.equal(otherRequests.length, 3)
        assert.ok(otherRequests.every(({ headers }) => !headers.has(sessionHeader) && headers.get('user-agent') === 'codex-test'))
    }
})

test('browser and run_llm routes pass the conversation identity to model execution', async () => {
    const calls = []
    const mocks = {
        '@/lib/auth': { getCurrentUser: async () => ({ userId: 'owner' }) },
        '@/lib/server/codex-internal-auth': { isValidCodexInternalToken: () => true },
        '@/lib/server/model-group-runner': {
            loadModelGroupForOwner: async () => ({ name: 'test' }),
            runModelGroupWithFallbackOnServer: async (options) => {
                calls.push(options.input)
                return { text: 'OK', usedAssignment: { modelId: 'go-test' } }
            },
        },
    }
    for (const routePath of ['app/api/ai/run-group/route.ts', 'app/api/internal/codex/run-llm/route.ts']) {
        const { POST } = load(routePath, mocks)
        const response = await POST(new Request('http://localhost/run', { method: 'POST', body: JSON.stringify({
            ownerId: 'owner', groupId: 'group', sessionId: 'conversation-a', messages: [{ role: 'user', content: 'Hello' }],
        }) }))
        assert.equal(response.status, 200)
        await response.text()
    }
    assert.deepEqual(calls.map(({ sessionId }) => sessionId), ['conversation-a', 'conversation-a'])
})
