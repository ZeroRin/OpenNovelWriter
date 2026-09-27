const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')
const { test } = require('node:test')
const { createJiti } = require('jiti')

const webRoot = path.resolve(__dirname, '../../..')
const script = path.join(webRoot, 'scripts/opennovelwriter-mcp-server.cjs')
const scriptRequire = createRequire(script)
const jiti = createJiti(__filename, { alias: { '@': path.join(webRoot, 'src') } })
const { upsertOpenNovelWriterMcpConfig } = jiti('./codex-mcp-sync.ts')

function loadServer(connectionId) {
    const code = fs.readFileSync(script, 'utf8').replace(/^#![^\n]*\n/, '')
    const process = {
        env: {
            OPENNOVELWRITER_OWNER_ID: 'owner',
            OPENNOVELWRITER_INTERNAL_TOKEN: 'internal-token',
            OPENNOVELWRITER_DEEPSEEK_SEARCH_CONNECTION_ID: connectionId,
        },
        stdin: { setEncoding() {}, on() {} },
        on() {},
    }
    return new Function('require', 'process', '__dirname', `${code}\nreturn { handleRequest };`)((name) => {
        if (name === 'dotenv') return { config() {} }
        if (name === '../generated/prisma/client.js') return { PrismaClient: class {} }
        if (name === '../src/lib/server/prisma-sqlite.cjs') return { createPrismaSqliteAdapter() {} }
        return scriptRequire(name)
    }, process, path.dirname(script))
}

test('MCP search is exposed only for configured connections and calls the authenticated search route', async (t) => {
    const enabled = loadServer('connection')
    const disabled = loadServer('')
    const list = await enabled.handleRequest({ method: 'tools/list' })
    assert.equal(list.tools.filter((tool) => tool.name === 'web_search').length, 1)
    assert.equal((await disabled.handleRequest({ method: 'tools/list' })).tools.some((tool) => tool.name === 'web_search'), false)
    t.mock.method(globalThis, 'fetch', async (url, init) => {
        assert.equal(url, 'http://127.0.0.1:3000/api/internal/codex/web-search')
        assert.equal(init.headers['x-onw-internal-token'], 'internal-token')
        assert.deepEqual(JSON.parse(init.body), { ownerId: 'owner', connectionId: 'connection', query: 'web query' })
        return Response.json({ ok: true, text: 'Found.', sources: [{ url: 'https://example.com', title: 'Example' }] })
    })
    const request = { method: 'tools/call', params: { name: 'web_search', arguments: { query: 'web query' } } }
    const response = await enabled.handleRequest(request)
    assert.notEqual(response.isError, true)
    assert.ok(response.content[0].text.includes('https://example.com'))
    assert.equal((await disabled.handleRequest(request)).isError, true)
})

test('MCP config carries the search connection without changing unrelated server configuration', () => {
    const options = { ownerId: 'owner', webRoot, dataDir: '/tmp/onw', deepSeekWebSearchConnectionId: 'connection' }
    const config = upsertOpenNovelWriterMcpConfig('[mcp_servers.other]\ncommand = "other"\n', options)
    assert.ok(config.includes('OPENNOVELWRITER_DEEPSEEK_SEARCH_CONNECTION_ID = "connection"'))
    assert.ok(config.includes('[mcp_servers.other]\ncommand = "other"'))
    const withoutSearch = upsertOpenNovelWriterMcpConfig(config, { ...options, deepSeekWebSearchConnectionId: undefined })
    assert.equal(withoutSearch.includes('OPENNOVELWRITER_DEEPSEEK_SEARCH_CONNECTION_ID'), false)
    assert.ok(withoutSearch.includes('[mcp_servers.other]'))
})
