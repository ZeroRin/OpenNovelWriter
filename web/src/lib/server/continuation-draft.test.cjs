const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createRequire } = require('node:module')
const { test } = require('node:test')
const { parseLlmConversation } = require('./llm-conversation.cjs')

const script = path.resolve(__dirname, '../../../scripts/opennovelwriter-mcp-server.cjs')
const scriptRequire = createRequire(script)

function fixture(t, fetch = async () => { throw new Error('Unexpected model call') }) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'onw-continuation-draft-'))
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
    const artifacts = path.join(directory, 'codex', 'sessions', 'owner', 'session', 'artifacts')
    fs.mkdirSync(artifacts, { recursive: true })
    const draft = { panelId: 'panel', novelId: 'novel', sceneId: 'scene', chapterId: 'chapter', codexSessionId: 'session', content: '第一段。\n\n第二段。', planning: '保留人物动机。', updatedBy: 'user' }
    const writes = []
    let owned = true
    const db = {
        novel: { findFirst: async ({ where }) => owned && where.id === draft.novelId && where.ownerId === 'owner' ? { id: draft.novelId } : null },
        codexSession: { findFirst: async ({ where }) => owned && where.id === 'session' && where.ownerId === 'owner' ? { id: 'session' } : null },
        sceneContinuationDraft: {
            findUnique: async ({ where }) => where.panelId === draft.panelId ? draft : null,
            update: async ({ where, data }) => {
                assert.equal(where.panelId, draft.panelId)
                writes.push(data)
                Object.assign(draft, data)
                return draft
            },
        },
    }
    const process = {
        env: { OPENNOVELWRITER_OWNER_ID: 'owner', OPENNOVELWRITER_DATA_DIR: directory, OPENNOVELWRITER_INTERNAL_TOKEN: 'test-token' },
        stdin: { setEncoding() {}, on() {} },
        on() {},
    }
    const code = fs.readFileSync(script, 'utf8').replace(/^#![^\n]*\n/, '')
    const server = new Function('require', 'process', '__dirname', 'fetch', `${code}\nreturn { handleRequest };`)((name) => {
        if (name === 'dotenv') return { config() {} }
        if (name === '../generated/prisma/client.js') return { PrismaClient: class { constructor() { return db } } }
        if (name === '../src/lib/server/prisma-sqlite.cjs') return { createPrismaSqliteAdapter() {} }
        return scriptRequire(name)
    }, process, path.dirname(script), fetch)
    const call = (name, args) => server.handleRequest({ method: 'tools/call', params: { name, arguments: args } })
    const invoke = async (name, args) => {
        const result = await call(name, args)
        assert.notEqual(result.isError, true, result.content?.[0]?.text)
        return JSON.parse(result.content[0].text)
    }
    return { directory, artifacts, draft, writes, call, invoke, server, denyAccess: () => { owned = false } }
}

test('export refreshes the draft file from author edits and commits file edits with planning intact', async (t) => {
    const f = fixture(t)
    const first = await f.invoke('get_continuation_draft', { panelId: 'panel' })
    assert.equal(first.isEmpty, false)
    assert.equal(Object.hasOwn(first, 'content'), false)
    assert.equal(Object.hasOwn(first, 'planning'), false)
    assert.equal(path.dirname(first.mdPath), f.artifacts)
    assert.deepEqual(parseLlmConversation(fs.readFileSync(first.mdPath, 'utf8')), [
        { role: 'assistant', content: `<Planning>\n${f.draft.planning}\n</Planning>\n\n<Content>\n${f.draft.content}\n</Content>` },
    ])
    assert.equal(f.writes.length, 0)

    f.draft.content = '作者修改。\n\n第二段。'
    const latest = await f.invoke('get_continuation_draft', { panelId: 'panel' })
    assert.equal(latest.mdPath, first.mdPath)
    const markdown = fs.readFileSync(latest.mdPath, 'utf8')
    assert.ok(markdown.includes('作者修改。'))
    fs.writeFileSync(latest.mdPath, markdown.replace('第二段。', '修改后的第二段，保留字面符号 \\n。'))
    const saved = await f.invoke('set_continuation_draft', { panelId: 'panel', source: { mdPath: latest.mdPath } })
    assert.equal(saved.panelId, 'panel')
    assert.deepEqual(f.writes, [{ content: '作者修改。\n\n修改后的第二段，保留字面符号 \\n。', planning: '保留人物动机。', updatedBy: 'codex' }])
})

test('an empty draft can submit the latest run_llm reply directly from the continuation file', async (t) => {
    const f = fixture(t, async (_url, init) => {
        const body = JSON.parse(init.body)
        assert.equal(body.groupId, 'bound-group')
        assert.equal(body.system, '写作要求')
        assert.deepEqual(body.messages, [{ role: 'user', content: '已拼装的上下文' }])
        return Response.json({ ok: true, text: '<Planning>生成规划</Planning>\n\n<Content>第一段。\n\n第二段。</Content>', groupName: 'Writer' })
    })
    f.draft.content = ''
    f.draft.planning = ''
    const empty = await f.invoke('get_continuation_draft', { panelId: 'panel' })
    assert.equal(empty.isEmpty, true)
    const mdPath = path.join(f.artifacts, 'continuation.md')
    fs.writeFileSync(mdPath, '## system\n\n写作要求\n\n## user\n\n已拼装的上下文\n')
    await f.invoke('run_llm', { mdPath, groupId: 'bound-group' })
    await f.invoke('set_continuation_draft', { panelId: 'panel', source: { mdPath } })
    assert.equal(f.draft.content, '第一段。\n\n第二段。')
    assert.equal(f.draft.planning, '生成规划')
    assert.deepEqual(fs.readdirSync(f.artifacts).sort(), [path.basename(empty.mdPath), 'continuation.md'].sort())
    assert.ok(!fs.readFileSync(empty.mdPath, 'utf8').includes('第一段'))

    fs.appendFileSync(mdPath, '\n## assistant\n\n最终版本。\n')
    await f.invoke('set_continuation_draft', { panelId: 'panel', source: { mdPath } })
    assert.equal(f.draft.content, '最终版本。')
    assert.equal(f.draft.planning, '')
})

test('empty tagged sections stay empty when the exported draft is submitted', async (t) => {
    const f = fixture(t)
    f.draft.content = ''
    const exported = await f.invoke('get_continuation_draft', { panelId: 'panel' })
    assert.equal(exported.isEmpty, true)
    await f.invoke('set_continuation_draft', { panelId: 'panel', source: { mdPath: exported.mdPath } })
    assert.equal(f.draft.content, '')
    assert.equal(f.draft.planning, '保留人物动机。')
    fs.writeFileSync(exported.mdPath, '## assistant\n\n<Content>\n\n</Content>\n')
    await f.invoke('set_continuation_draft', { panelId: 'panel', source: { mdPath: exported.mdPath } })
    assert.equal(f.draft.content, '')
    assert.equal(f.draft.planning, '')
})

test('draft tools require a file source and retain panel ownership checks', async (t) => {
    const f = fixture(t)
    const { tools } = await f.server.handleRequest({ method: 'tools/list' })
    const schema = tools.find((tool) => tool.name === 'set_continuation_draft').inputSchema
    assert.deepEqual(schema.required, ['panelId', 'source'])
    assert.equal(Object.hasOwn(schema.properties, 'text'), false)
    assert.equal(Object.hasOwn(schema.properties, 'planning'), false)
    assert.equal((await f.call('set_continuation_draft', { panelId: 'panel', text: 'Literal text' })).isError, true)
    assert.equal(f.writes.length, 0)
    const exported = await f.invoke('get_continuation_draft', { panelId: 'panel' })
    f.denyAccess()
    assert.equal((await f.call('get_continuation_draft', { panelId: 'panel' })).isError, true)
    assert.equal((await f.call('set_continuation_draft', { panelId: 'panel', source: { mdPath: exported.mdPath } })).isError, true)
    assert.equal(f.writes.length, 0)
})
