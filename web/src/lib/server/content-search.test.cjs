/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createRequire } = require('node:module')
const { test } = require('node:test')
const { CONTENT_SEARCH_KINDS, searchContent } = require('./content-search.cjs')
const { buildTermProjectionSnapshots } = require('./novel-workspace-terms.cjs')
const {
    buildNovelWorkspaceOutlineMarkdown, buildNovelWorkspaceChapterMarkdown,
    buildNovelWorkspaceDetailedOutlineMarkdown, buildNovelWorkspaceSnippetMarkdown,
} = require('./novel-workspace-projection.cjs')

function fixture(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'onw-content-search-'))
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
    const workspaceRoot = path.join(directory, 'codex', 'novels', 'owner')
    const novelPath = path.join(workspaceRoot, 'novel')
    const sessionPath = path.join(directory, 'session')
    fs.mkdirSync(novelPath, { recursive: true })
    fs.mkdirSync(sessionPath)
    fs.symlinkSync(novelPath, path.join(sessionPath, 'novel'))
    const terms = [
        { id: 'term-b', title: '重逢', categoryId: 'characters', aliases: 'SECRET_ALIAS', description: 'SECRET_BODY', tags: ['重要', '共享'] },
        { id: 'term-a', title: '重逢', categoryId: 'characters', tags: ['重要'] },
        { id: 'term-0', title: '归档人物', archived: true, tags: ['归档专用', '共享'] },
    ]
    const novel = {
        id: 'novel', title: '重逢故事', language: 'zh-CN',
        acts: [{ id: 'act-id', number: 2, title: '重逢之路' }],
        chapters: [
            { id: 'chapter-b', title: '重逢', actNumber: 2, order: 1, scenes: [{ id: 'scene-b', order: 0, content: '<p>SECRET_BODY</p>', summary: 'SECRET_SUMMARY' }] },
            { id: 'chapter-a', title: '重逢', actNumber: 2, order: 0, scenes: [{ id: 'scene-a', order: 0, content: '<p>正文</p>' }] },
        ],
        outlines: [{ id: 'outline-act', type: 'ACT', actNumber: 2 }, { id: 'outline-chapter', type: 'CHAPTER', chapterId: 'chapter-a' }, { id: 'outline-empty', type: 'CHAPTER', chapterId: 'chapter-b' }],
        snippets: [{ id: 'snippet', title: '重逢笔记', content: '<p>SECRET_BODY</p>' }],
        labels: [{ id: 'label', name: '重逢' }],
        termState: { stateJson: JSON.stringify({ entries: terms }) },
    }
    const queries = []
    const prisma = { novel: { findFirst: async (query) => {
        queries.push(query)
        return query.where.id === novel.id && query.where.ownerId === 'owner' ? novel : null
    } } }
    const write = (file, text) => {
        const filePath = path.join(novelPath, file)
        fs.mkdirSync(path.dirname(filePath), { recursive: true })
        fs.writeFileSync(filePath, text)
    }
    write('outline.md', buildNovelWorkspaceOutlineMarkdown(novel))
    for (const chapter of novel.chapters) write(`chapters/${chapter.id}.md`, buildNovelWorkspaceChapterMarkdown({ ...chapter, language: novel.language }))
    write('DetailedOutline/acts/2.md', buildNovelWorkspaceDetailedOutlineMarkdown({ novelId: novel.id, language: novel.language, kind: 'act', outlineId: 'outline-act', actNumber: 2, title: '重逢之路', content: '卷纲' }))
    write('DetailedOutline/chapters/chapter-a.md', buildNovelWorkspaceDetailedOutlineMarkdown({ novelId: novel.id, language: novel.language, kind: 'chapter', outlineId: 'outline-chapter', chapterId: 'chapter-a', chapterNumber: 1, title: '重逢', content: '章纲' }))
    write('snippets/snippet.md', buildNovelWorkspaceSnippetMarkdown({ novelId: novel.id, language: novel.language, snippet: novel.snippets[0] }))
    for (const item of buildTermProjectionSnapshots({ novelId: novel.id, language: novel.language, state: { entries: terms } })) write(`terms/${item.fileName}`, item.markdown)
    const search = (args = {}) => searchContent({ prisma, ownerId: 'owner', workspaceRoot }, { novelId: novel.id, query: '重逢', ...args })
    return { directory, workspaceRoot, novelPath, sessionPath, novel, prisma, queries, search, write }
}

test('search returns resource identities, selection targets and readable projection locations', async (t) => {
    const f = fixture(t)
    const { items, hasMore } = await f.search()
    assert.equal(hasMore, false)
    assert.deepEqual(new Set(items.map((item) => item.kind)), new Set(CONTENT_SEARCH_KINDS.filter((kind) => kind !== 'term_tag')))
    for (const item of items) {
        assert.equal(item.kind, item.target.kind)
        assert.equal(Object.hasOwn(item, 'archived'), false)
        if (!item.relativePath) { assert.equal(item.anchor, null); continue }
        const file = fs.readFileSync(path.join(f.sessionPath, item.relativePath), 'utf8')
        assert.ok(file.includes(item.anchor), JSON.stringify(item))
    }
    const act = items.find((item) => item.kind === 'act')
    assert.equal(act.id, 'act-id')
    assert.deepEqual(act.target, { kind: 'act', actNumber: 2 })
    const outline = items.find((item) => item.id === 'outline-chapter')
    assert.deepEqual(outline.target, { kind: 'chapter_outline', chapterId: 'chapter-a' })
    const scene = items.find((item) => item.id === 'scene-b')
    assert.equal(scene.relativePath, 'novel/chapters/chapter-b.md')
    assert.equal(scene.context.chapterNumber, 2)
    assert.equal(scene.context.sceneNumber, 1)
    const empty = items.find((item) => item.id === 'outline-empty')
    assert.equal(empty.relativePath, null)
    assert.equal(empty.id, 'outline-empty')
    assert.equal(items.find((item) => item.id === 'label').relativePath, null)
    assert.equal(items.find((item) => item.id === 'term-a').relativePath, 'novel/terms/重逢.md')
    assert.equal(items.find((item) => item.id === 'term-b').relativePath, 'novel/terms/重逢-2.md')
})

test('search matches titles and structural names, with exact checks and stable ranked pagination', async (t) => {
    const f = fixture(t)
    f.novel.snippets = [
        { id: 's1', title: 'A reunion' }, { id: 's2', title: 'Reunion notes' },
        { id: 's3', title: 'Reunion' }, { id: 's4', title: 'Reunion' },
    ]
    const args = { query: '  REUNION  ', kinds: ['snippet'] }
    const exact = await f.search({ ...args, match: 'exact' })
    assert.deepEqual(exact.items.map((item) => item.id), ['s3', 's4'])
    const first = await f.search({ ...args, limit: 2 })
    assert.deepEqual(first.items.map((item) => item.id), ['s3', 's4'])
    assert.equal(first.hasMore, true)
    const second = await f.search({ ...args, limit: 2, offset: 2 })
    assert.deepEqual(second.items.map((item) => item.id), ['s2', 's1'])
    assert.equal(second.hasMore, false)
    assert.deepEqual((await f.search({ ...args, offset: 4 })).items, [])
    for (const query of ['SECRET_ALIAS', 'SECRET_BODY', 'SECRET_SUMMARY']) assert.deepEqual((await f.search({ query })).items, [])
    assert.equal((await f.search({ query: '第2卷', kinds: ['act'], match: 'exact' })).items[0].id, 'act-id')
    assert.equal((await f.search({ query: '第2章', kinds: ['chapter'], match: 'exact' })).items[0].id, 'chapter-b')
    assert.equal((await f.search({ query: '第2章 · 重逢 · 场景1', kinds: ['scene'], match: 'exact' })).items[0].id, 'scene-b')
})

test('archived terms and exclusive tags are excluded; shared tags need no id or file', async (t) => {
    const f = fixture(t)
    for (const query of ['归档人物', '归档专用']) assert.deepEqual((await f.search({ query, match: 'exact' })).items, [])
    const shared = await f.search({ query: '共享', kinds: ['term_tag'], match: 'exact' })
    assert.deepEqual(shared.items, [{ kind: 'term_tag', id: null, title: '共享', context: {}, target: { kind: 'term_tag', tag: '共享' }, relativePath: null, anchor: null }])
    const tags = await f.search({ query: '重要', kinds: ['term_tag'] })
    assert.equal(tags.items.length, 1)
})

test('ownership, invalid inputs and unavailable files do not become false existence results', async (t) => {
    const f = fixture(t)
    await assert.rejects(f.search({ novelId: 'other' }), /Novel not found/)
    await assert.rejects(searchContent({ prisma: f.prisma, ownerId: 'other-owner', workspaceRoot: f.workspaceRoot }, { novelId: 'novel', query: '重逢' }), /Novel not found/)
    for (const args of [{ query: '' }, { kinds: [] }, { kinds: ['material'] }, { match: 'fuzzy' }, { limit: 0 }, { limit: 101 }, { offset: -1 }, { offset: 1.5 }, { includeArchived: true }]) await assert.rejects(f.search(args))
    fs.unlinkSync(path.join(f.novelPath, 'terms/重逢.md'))
    const term = (await f.search({ kinds: ['term'], match: 'exact' })).items.find((item) => item.id === 'term-a')
    assert.equal(term.relativePath, null)
    assert.deepEqual(term.target, { kind: 'term', termId: 'term-a' })
    assert.deepEqual(f.queries[0].where, { id: 'other', ownerId: 'owner' })
    assert.equal(Object.hasOwn(f.queries[0].select.chapters.select.scenes.select, 'content'), false)
})

test('native MCP exposes search_content and returns structured results without model calls', async (t) => {
    const f = fixture(t)
    const script = path.resolve(__dirname, '../../../scripts/opennovelwriter-mcp-server.cjs')
    const scriptRequire = createRequire(script)
    const process = { env: { OPENNOVELWRITER_OWNER_ID: 'owner', OPENNOVELWRITER_DATA_DIR: f.directory }, stdin: { setEncoding() {}, on() {} }, on() {} }
    const code = fs.readFileSync(script, 'utf8').replace(/^#![^\n]*\n/, '')
    const server = new Function('require', 'process', '__dirname', `${code}\nreturn { handleRequest };`)((name) => {
        if (name === 'dotenv') return { config() {} }
        if (name === '../generated/prisma/client.js') return { PrismaClient: class { constructor() { return f.prisma } } }
        if (name === '../src/lib/server/prisma-sqlite.cjs') return { createPrismaSqliteAdapter() {} }
        return scriptRequire(name)
    }, process, path.dirname(script))
    const { tools } = await server.handleRequest({ method: 'tools/list' })
    const tool = tools.find((item) => item.name === 'search_content')
    assert.equal(tool.annotations.readOnlyHint, true)
    const call = (args) => server.handleRequest({ method: 'tools/call', params: { name: 'search_content', arguments: args } })
    const result = await call({ novelId: 'novel', query: '重逢', kinds: ['term'], match: 'exact' })
    assert.notEqual(result.isError, true)
    const payload = JSON.parse(result.content[0].text)
    assert.equal(payload.items.length, 2)
    assert.equal(payload.items[0].relativePath, 'novel/terms/重逢.md')
    assert.equal((await call({ novelId: 'foreign', query: '重逢' })).isError, true)
})
