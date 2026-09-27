const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { PassThrough } = require('node:stream')
const ts = require('typescript')
const { createJiti } = require('jiti')
const src = path.resolve(__dirname, '../..')
const jiti = createJiti(__filename, { alias: { '@': src } })
const { subagentsFromThreadItem, mergeSubagentTurns } = jiti('@/lib/codex-subagents')
const { readSubagentHistory, CodexSubagentNotFoundError, subagentTurnMessages } = jiti('@/lib/server/codex-subagent-history')
const { parseCodexSessionMessages } = jiti('@/lib/server/codex-session')
const { projectCodexRunEvent } = jiti('@/lib/server/codex-message-projection')

function load(file, mocks) {
    const output = ts.transpileModule(fs.readFileSync(path.join(src, file), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText
    const module = { exports: {} }
    new Function('require', 'module', 'exports', output)((name) => {
        if (Object.hasOwn(mocks, name)) return mocks[name]
        if (name === '@/lib/server/continuation-handoff') return {}
        if (name === '@/lib/server/novel-workspace') return { getNovelWorkspacePath: () => '/unused-novel' }
        return name.startsWith('@/') ? jiti(name) : require(name)
    }, module, module.exports)
    return module.exports
}

const spawnItem = { type: 'collabAgentToolCall', id: 'spawn', tool: 'spawnAgent', status: 'completed', senderThreadId: 'root', receiverThreadIds: ['child'], prompt: 'Inspect the chapter.', model: 'native-choice', agentsStates: { child: { status: 'running', message: null } } }
const nativeThread = { id: 'child', parentThreadId: 'root', agentNickname: 'Reader', model: 'native-choice', createdAt: 100, status: { type: 'active' } }
const nativeTurn = { id: 'child-turn', status: 'inProgress', startedAt: 110, items: [
    { type: 'userMessage', id: 'task', content: [{ type: 'text', text: 'Inspect the chapter.' }] },
    { type: 'agentMessage', id: 'progress', text: 'Reading the chapter.' },
    { type: 'reasoning', id: 'reason', summary: ['Checking continuity.'], content: ['Do not surface private reasoning.'] },
    { type: 'commandExecution', id: 'command', command: 'read chapter', status: 'completed', aggregatedOutput: 'Chapter text' },
] }

test('collaboration extraction uses agent status, not the completed spawn call', () => {
    assert.deepEqual(subagentsFromThreadItem(spawnItem), [{ threadId: 'child', prompt: 'Inspect the chapter.', model: 'native-choice', status: 'running' }])
    const agents = subagentsFromThreadItem({ ...spawnItem, tool: 'wait', receiverThreadIds: ['child', 'other'], agentsStates: { child: { status: 'completed', message: 'Done' }, other: { status: 'errored', message: 'Failed' } } })
    assert.deepEqual(agents.map((a) => a.status), ['completed', 'errored'])
    assert.equal(agents[0].prompt, undefined)
    assert.equal(subagentsFromThreadItem({ ...spawnItem, agentsStates: {} })[0].status, undefined)
    assert.deepEqual(subagentsFromThreadItem({ type: 'subAgentActivity', agentThreadId: 'child', agentPath: '/root/reader', kind: 'interrupted' }), [{ threadId: 'child', name: '/root/reader', status: 'interrupted' }])
    assert.deepEqual(subagentsFromThreadItem({ type: 'agentMessage' }), [])
})

test('agent metadata survives event projection and persisted history', () => {
    const agent = subagentsFromThreadItem(spawnItem)[0]
    const event = { id: 'child', kind: 'subagent', title: '', content: '', subagent: agent, createdAt: '2026-09-27T00:00:00Z' }
    assert.deepEqual(projectCodexRunEvent(event), event)
    assert.deepEqual(parseCodexSessionMessages(JSON.stringify([{ ...event, role: 'event' }]))[0].subagent, agent)
})

test('history checks native ancestry and reads full paginated turns without resuming', async () => {
    const calls = []
    const reader = { request: async (method, params) => {
        calls.push({ method, params })
        if (method === 'thread/read') return { thread: params.threadId === 'child' ? { ...nativeThread, parentThreadId: 'parent' } : { ...nativeThread, id: 'parent' } }
        if (method === 'thread/turns/list') return { data: [nativeTurn, { ...nativeTurn, id: 'older' }], nextCursor: 'next' }
        throw new Error(`Unexpected mutation ${method}`)
    } }
    const page = await readSubagentHistory(reader, 'root', 'child', () => null)
    assert.deepEqual(page.turns.map((t) => t.id), ['older', 'child-turn'])
    assert.equal(page.agent.status, 'running')
    assert.equal(page.agent.name, 'Reader')
    assert.equal(page.nextCursor, 'next')
    assert.deepEqual(calls.map((c) => c.method), ['thread/read', 'thread/read', 'thread/turns/list'])
    assert.equal(calls.at(-1).params.itemsView, 'full')
    await readSubagentHistory(reader, 'root', 'child', () => null, 'next')
    assert.equal(calls.at(-1).params.cursor, 'next')
})

test('unrelated threads and ancestry cycles cannot expose turns', async () => {
    for (const parentThreadId of [null, 'child']) {
        const reader = { request: async (method) => { assert.equal(method, 'thread/read'); return { thread: { ...nativeThread, parentThreadId } } } }
        await assert.rejects(readSubagentHistory(reader, 'root', 'child', () => null), CodexSubagentNotFoundError)
    }
    await assert.rejects(readSubagentHistory({ request: () => assert.fail('Must not read root') }, 'root', 'root', () => null), CodexSubagentNotFoundError)
})

test('child transcript includes tasks, replies, public summaries, tools and nested agents', () => {
    const messages = subagentTurnMessages({ ...nativeTurn, items: [...nativeTurn.items, { ...spawnItem, receiverThreadIds: ['nested'], agentsStates: { nested: { status: 'running' } } }, { type: 'subAgentActivity', agentThreadId: 'nested', kind: 'completed' }] }, 100, (item) => item.type === 'commandExecution' ? { id: item.id, kind: 'command', title: item.command, content: item.aggregatedOutput } : null)
    assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant', 'event', 'event', 'event'])
    assert.equal(messages[2].content, 'Checking continuity.')
    assert.equal(messages[3].content, 'read chapter\n\nChapter text')
    assert.equal(messages[4].subagent.status, 'completed')
    assert.ok(!JSON.stringify(messages).includes('private reasoning'))
})

test('polling updates an existing turn and keeps loaded earlier pages', () => {
    const turn = (id, text = id) => ({ id, messages: [{ content: text }] })
    let turns = mergeSubagentTurns([], [turn('b')])
    turns = mergeSubagentTurns(turns, [turn('a'), turn('b')], true)
    turns = mergeSubagentTurns(turns, [turn('b', 'updated'), turn('c')])
    assert.deepEqual(turns.map((t) => t.id), ['a', 'b', 'c'])
    assert.equal(turns[1].messages[0].content, 'updated')
})

function runtimeFixture() {
    const requests = [], spawns = [], events = []
    let onTurnStart = () => {}
    const runtime = load('lib/server/codex-app-server.ts', {
        child_process: { spawn: (_command, args) => {
            spawns.push(args)
            const child = new EventEmitter()
            child.stdout = new PassThrough(); child.stderr = new PassThrough()
            child.kill = () => true
            const emit = (message) => child.stdout.write(JSON.stringify(message) + '\n')
            child.stdin = { write: (line) => {
                const request = JSON.parse(line); requests.push(request)
                const result = request.method === 'thread/start' ? { thread: { id: 'root' } }
                    : request.method === 'turn/start' ? { turn: { id: 'root-turn' } }
                        : request.method === 'config/read' ? { config: {} }
                            : request.method === 'thread/read' ? { thread: nativeThread }
                                : request.method === 'thread/turns/list' ? { data: [nativeTurn], nextCursor: null } : {}
                queueMicrotask(() => emit({ id: request.id, result }))
                if (request.method === 'turn/start') setImmediate(() => onTurnStart(emit))
            } }
            return child
        } },
        '@/lib/db': { getPrismaClient: () => ({ codexConnection: { findFirst: async () => ({ id: 'connection', providerType: 'custom' }) }, novel: { findFirstOrThrow: async () => ({ codexUserInputEnabled: true }) } }) },
        '@/lib/server/codex-session-skills': { getCodexSessionSkillConfig: async () => ({}), rewriteCodexSkillReferences: (v) => v },
        '@/lib/server/codex-runtime-config': { syncCodexConnectionRuntimeFiles: async () => '/unused-home' },
        '@/lib/server/codex-session-workspace': { ensureCodexSessionWorkspace: async () => '/unused-workspace' },
        '@/lib/server/codex-mcp-sync': { syncCodexConnectionMcp: async () => {} },
        '@/lib/server/codex-question-policy': { prepareCodexQuestionPolicy: async () => ({}) },
    })
    return { runtime, requests, spawns, events, replay: (fn) => { onTurnStart = fn } }
}

async function replayConversation(replay) {
    const f = runtimeFixture()
    const now = new Date()
    let row = {
        id: 'segmented-session', ownerId: 'owner', novelId: 'novel', category: 'general',
        status: 'idle', composerMode: 'default', messagesJson: '[]',
        draftAttachmentsJson: '[]', draftArtifactsJson: '[]', createdAt: now, updatedAt: now,
    }
    f.replay((emit) => {
        const notify = (method, params) => emit({ method, params: { threadId: 'root', turnId: 'root-turn', ...params } })
        replay(notify)
        notify('turn/completed', { turn: { id: 'root-turn', status: 'completed' } })
    })
    const route = load('app/api/codex/sessions/[id]/messages/route.ts', {
        '@/lib/auth': { getCurrentUser: async () => ({ userId: 'owner' }) },
        '@/lib/db': { getPrismaClient: () => ({ codexSession: {
            findFirst: async () => row,
            updateMany: async ({ data }) => { row = { ...row, ...data }; return { count: 1 } },
            update: async ({ data }) => { row = { ...row, ...data }; return row },
        } }) },
        '@/lib/server/codex-app-server': f.runtime,
        '@/lib/server/codex-session-workspace': { getCodexSessionWorkspacePath: () => '/unused' },
        '@/lib/server/codex-session-skills': { resolveCodexSessionSkillReferences: async () => [], rewriteCodexSkillReferences: (value) => value },
    })
    const response = await route.POST(new Request('http://localhost/messages', {
        method: 'POST', body: JSON.stringify({ messageId: 'input', content: 'Check the chapter.' }),
    }), { params: Promise.resolve({ id: row.id }) })
    assert.equal(response.status, 200)
    const body = await response.text()
    assert.doesNotMatch(body, /event: error/)
    const events = body.split('\n\n').filter(Boolean).map((block) => {
        const [event, data] = block.split('\n')
        return { type: event.slice(7), data: JSON.parse(data.slice(6)) }
    })
    return { messages: parseCodexSessionMessages(row.messagesJson), events }
}

test('commentary and final answer retain native boundaries through streaming and persistence after a child finishes', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-27T00:00:00Z') })
    const commentary = 'The sub-agent is running now. I’ll wait for its response.'
    const result = await replayConversation((notify) => {
        notify('item/completed', { item: spawnItem })
        notify('item/started', { item: { type: 'agentMessage', id: 'commentary', phase: 'commentary', text: '' } })
        notify('item/agentMessage/delta', { itemId: 'commentary', delta: commentary })
        notify('item/completed', { item: { type: 'agentMessage', id: 'commentary', phase: 'commentary', text: commentary } })
        t.mock.timers.tick(120000)
        notify('item/agentMessage/delta', { threadId: 'child', turnId: 'child-turn', itemId: 'child-reply', delta: 'Child output must stay separate.' })
        notify('turn/completed', { threadId: 'child', turn: { id: 'child-turn', status: 'completed' } })
        notify('item/started', { item: { type: 'agentMessage', id: 'final', phase: 'final_answer', text: '' } })
        notify('item/agentMessage/delta', { itemId: 'final', delta: 'hel' })
        notify('item/agentMessage/delta', { itemId: 'final', delta: 'lo' })
        notify('item/completed', { item: { type: 'agentMessage', id: 'final', phase: 'final_answer', text: 'hello' } })
    })
    const replies = result.messages.filter((message) => message.role === 'assistant')
    assert.deepEqual(replies.map((message) => message.content), [commentary, 'hello'])
    assert.notEqual(replies[0].id, replies[1].id)
    assert.equal(Date.parse(replies[1].createdAt) - Date.parse(replies[0].createdAt), 120000)
    const deltas = result.events.filter((event) => event.type === 'assistant_delta').map((event) => event.data)
    assert.deepEqual(deltas.map((event) => event.id), [replies[0].id, replies[1].id, replies[1].id])
    assert.deepEqual(deltas.map((event) => event.delta), [commentary, 'hel', 'lo'])
    assert.deepEqual(result.events.find((event) => event.type === 'done').data.session.messages.filter((message) => message.role === 'assistant'), replies)
})

test('tool events do not split a native message and identical text in another message is not deduplicated', async () => {
    const result = await replayConversation((notify) => {
        notify('item/agentMessage/delta', { itemId: 'first', delta: 'Re' })
        notify('item/started', { item: { type: 'mcpToolCall', id: 'read', tool: 'read_scene', server: 'onw' } })
        notify('item/reasoning/summaryTextDelta', { itemId: 'reason', summaryIndex: 0, delta: 'Check the scene.' })
        notify('item/agentMessage/delta', { itemId: 'first', delta: 'ady' })
        notify('item/completed', { item: { type: 'mcpToolCall', id: 'read', tool: 'read_scene', server: 'onw', result: { text: 'Done' } } })
        notify('item/completed', { item: { type: 'agentMessage', id: 'first', text: 'Ready.' } })
        notify('item/completed', { item: { type: 'agentMessage', id: 'first', text: 'Ready.' } })
        notify('item/completed', { item: { type: 'agentMessage', id: 'second', text: 'Ready.' } })
        notify('item/completed', { turnId: 'other-turn', item: { type: 'agentMessage', id: 'wrong', text: 'Wrong turn.' } })
    })
    const replies = result.messages.filter((message) => message.role === 'assistant')
    assert.deepEqual(replies.map((message) => message.content), ['Ready.', 'Ready.'])
    assert.notEqual(replies[0].id, replies[1].id)
    const deltas = result.events.filter((event) => event.type === 'assistant_delta').map((event) => event.data)
    assert.deepEqual(deltas.map((event) => event.delta), ['Re', 'ady', '.', 'Ready.'])
    assert.deepEqual(deltas.map((event) => event.id), [replies[0].id, replies[0].id, replies[0].id, replies[1].id])
})

test('completed-only replies keep their boundaries when no deltas were sent', async () => {
    const result = await replayConversation((notify) => {
        for (const [id, text] of [['first', 'hello'], ['second', 'hello world'], ['third', 'hello']]) {
            notify('item/completed', { item: { type: 'agentMessage', id, text } })
        }
    })
    assert.deepEqual(result.messages.filter((message) => message.role === 'assistant').map((message) => message.content), ['hello', 'hello world', 'hello'])
    assert.equal(result.events.filter((event) => event.type === 'assistant_delta').length, 3)
})

test('live native subagent events become one entry and child text never enters the main answer', { timeout: 5000 }, async (t) => {
    const f = runtimeFixture()
    const run = f.runtime.reserveActiveCodexRun('subagent-live')
    t.after(() => f.runtime.finishActiveCodexRun(run))
    let history
    f.replay(async (emit) => {
        const notify = (method, params) => emit({ method, params: { threadId: 'root', turnId: 'root-turn', ...params } })
        notify('item/completed', { item: spawnItem })
        notify('item/agentMessage/delta', { threadId: 'child', turnId: 'child-turn', delta: 'Child only' })
        history = await f.runtime.readCodexSubagent({ sessionId: run.sessionId, ownerId: 'owner', codexConnectionId: null, codexThreadId: null, threadId: 'child' })
        notify('turn/completed', { threadId: 'child', turn: { id: 'child-turn', status: 'completed' } })
        notify('item/agentMessage/delta', { itemId: 'main-reply', delta: 'Main answer' })
        notify('turn/completed', { turn: { id: 'root-turn', status: 'completed' } })
    })
    const result = await f.runtime.runNovelCodexTurn({ activeRun: run, sessionId: run.sessionId, ownerId: 'owner', novelId: 'novel', modelId: 'native-choice', prompt: 'Use an agent', stream: { onEvent: (event) => f.events.push(event) } })
    assert.deepEqual(result.assistantMessages.map((message) => message.content), ['Main answer'])
    assert.equal(history.turns[0].messages[0].content, 'Inspect the chapter.')
    const events = f.events.filter((e) => e.kind === 'subagent')
    assert.equal(new Set(events.map((e) => e.id)).size, 1)
    assert.equal(events.at(-1).subagent.status, 'completed')
    assert.equal(events.at(-1).subagent.name, 'Reader')
    assert.equal(f.spawns.length, 1, 'reading a live child reuses the parent client')
    assert.equal(f.requests.filter((r) => r.method === 'turn/start').length, 1)
    assert.ok(!f.requests.some((r) => r.method === 'thread/resume'))
})

test('reading saved child history starts only a read client without configuration overrides', async () => {
    const f = runtimeFixture()
    await f.runtime.readCodexSubagent({ sessionId: 'saved', ownerId: 'owner', codexConnectionId: 'connection', codexThreadId: 'root', threadId: 'child' })
    assert.deepEqual(f.spawns, [['app-server']])
    assert.deepEqual(f.requests.map((r) => r.method), ['initialize', 'thread/read', 'thread/turns/list'])
})

test('the endpoint reads a first-turn child before native IDs are persisted, then reads saved history after completion', async (t) => {
    const { NextRequest } = require('next/server')
    const f = runtimeFixture()
    const run = f.runtime.reserveActiveCodexRun('first-turn-child')
    t.after(() => f.runtime.finishActiveCodexRun(run))
    const liveReads = []
    Object.assign(run, { threadId: 'root', client: { request: async (method, params) => {
        liveReads.push({ method, params })
        if (method === 'thread/read') return { thread: nativeThread }
        if (method === 'thread/turns/list') return { data: [nativeTurn], nextCursor: null }
        assert.fail(`Unexpected live operation: ${method}`)
    } } })
    let session = { codexThreadId: null, codexConnectionId: null }
    const route = load('app/api/codex/sessions/[id]/subagents/[threadId]/route.ts', {
        '@/lib/auth': { getCurrentUser: async () => ({ userId: 'owner' }) },
        '@/lib/db': { getPrismaClient: () => ({ codexSession: { findFirst: async ({ where }) => {
            assert.deepEqual(where, { id: run.sessionId, ownerId: 'owner' })
            return session
        } } }) },
        '@/lib/server/codex-app-server': f.runtime,
    })
    const get = () => route.GET(new NextRequest(`http://localhost/api/codex/sessions/${run.sessionId}/subagents/child`), { params: Promise.resolve({ id: run.sessionId, threadId: 'child' }) })
    for (const persistedIds of [
        { codexThreadId: null, codexConnectionId: null },
        { codexThreadId: null, codexConnectionId: 'connection' },
        { codexThreadId: 'previous-root', codexConnectionId: 'previous-connection' },
    ]) {
        session = persistedIds
        const response = await get()
        assert.equal(response.status, 200)
        assert.equal((await response.json()).turns[0].messages[0].content, 'Inspect the chapter.')
    }
    assert.equal(f.spawns.length, 0)
    assert.deepEqual(liveReads.map((read) => read.method), Array(3).fill(['thread/read', 'thread/turns/list']).flat())
    f.runtime.finishActiveCodexRun(run)
    session = { codexThreadId: 'root', codexConnectionId: 'connection' }
    assert.equal((await get()).status, 200)
    assert.deepEqual(f.spawns, [['app-server']])
    assert.deepEqual(f.requests.map((read) => read.method), ['initialize', 'thread/read', 'thread/turns/list'])
})

test('subagent endpoint requires an owned root session before reading native data', async () => {
    const { NextRequest } = require('next/server')
    let user = null, session = null, reads = 0
    const route = load('app/api/codex/sessions/[id]/subagents/[threadId]/route.ts', {
        '@/lib/auth': { getCurrentUser: async () => user },
        '@/lib/db': { getPrismaClient: () => ({ codexSession: { findFirst: async ({ where }) => { assert.deepEqual(where, { id: 'session', ownerId: 'owner' }); return session } } }) },
        '@/lib/server/codex-app-server': { readCodexSubagent: async () => { reads++; return { turns: [] } } },
    })
    const get = () => route.GET(new NextRequest('http://localhost/api/codex/sessions/session/subagents/child'), { params: Promise.resolve({ id: 'session', threadId: 'child' }) })
    assert.equal((await get()).status, 401)
    user = { userId: 'owner' }
    assert.equal((await get()).status, 404)
    assert.equal(reads, 0)
    session = { codexThreadId: 'root', codexConnectionId: 'connection' }
    const response = await get()
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.equal(reads, 1)
})
