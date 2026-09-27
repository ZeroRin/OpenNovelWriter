import assert from 'node:assert/strict'
import { test } from 'node:test'
import { searchDeepSeekWeb } from './deepseek-web-search'
import { sse } from './codex-proxy/sse'

type JsonObject = Record<string, unknown>
const input = { baseUrl: 'https://api.deepseek.com/v1', apiKey: 'test-key', query: '任天堂 新闻', signal: new AbortController().signal }
const call = { type: 'server_tool_use', id: 'search_1', name: 'web_search', input: { query: input.query } }
const source = { type: 'web_search_result', title: '任天堂公告', url: 'https://www.nintendo.com/news', encrypted_content: 'opaque-source' }
const result = { type: 'web_search_tool_result', tool_use_id: call.id, content: [source, source] }
const answer = { type: 'text', text: '查到公告。', citations: [{ type: 'web_search_result_location', url: source.url }] }

function events(id: string, content: JsonObject[], stopReason = 'end_turn') {
    return [
        { type: 'message_start', message: { id, model: 'deepseek-flash', usage: { input_tokens: 5, output_tokens: 0 } } },
        ...content.flatMap((block, index) => [
            { type: 'content_block_start', index, content_block: block },
            { type: 'content_block_stop', index },
        ]),
        { type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: 2 } },
        { type: 'message_stop' },
    ].map((event) => sse(event.type, event)).join('')
}

test('search uses an isolated Anthropic request, continues opaque results, and returns sources and citations', async (t) => {
    const requests: JsonObject[] = []
    t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
        assert.equal(url, 'https://api.deepseek.com/anthropic/v1/messages')
        assert.equal(new Headers(init.headers).get('x-api-key'), input.apiKey)
        assert.equal(init.signal, input.signal)
        const body = JSON.parse(String(init.body))
        requests.push(body)
        if (requests.length === 1) {
            assert.equal(body.model, 'deepseek-flash')
            assert.equal(body.max_tokens, 4096)
            assert.equal(body.stream, true)
            assert.deepEqual(body.tools, [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }])
            assert.deepEqual(body.tool_choice, { type: 'tool', name: 'web_search' })
            assert.equal(body.messages.length, 1)
            assert.ok(body.messages[0].content[0].text.includes(input.query))
            return new Response(events('first', [call, result], 'pause_turn'), { headers: { 'content-type': 'text/event-stream' } })
        }
        assert.deepEqual(body.messages[1], { role: 'assistant', content: [call, result] })
        assert.deepEqual(body.tool_choice, { type: 'auto' })
        return new Response(events('second', [answer]), { headers: { 'content-type': 'text/event-stream' } })
    })
    const response = await searchDeepSeekWeb(input)
    assert.equal(requests.length, 2)
    assert.deepEqual(response.sources, [{ url: source.url, title: source.title }])
    assert.equal(response.text, `查到公告。[[1]](${source.url})`)
    assert.equal((response.usage as JsonObject).input_tokens, 10)
    assert.equal(JSON.stringify(response).includes('opaque-source'), false)
})

test('search also reads JSON Responses converted from Anthropic and tolerates a later search cap', async (t) => {
    const extraCall = { ...call, id: 'search_2' }
    const error = { type: 'web_search_tool_result', tool_use_id: extraCall.id, content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' } }
    t.mock.method(globalThis, 'fetch', async () => Response.json({
        id: 'json', type: 'message', content: [call, result, extraCall, error, answer], stop_reason: 'end_turn',
    }))
    const response = await searchDeepSeekWeb({ ...input, baseUrl: 'https://api.deepseek.com' })
    assert.equal(response.sources.length, 1)
    assert.ok(response.text.includes(source.url))
})

test('search fails on ignored tools, search errors, incomplete streams, and HTTP errors', async (t) => {
    const fetchMock = t.mock.method(globalThis, 'fetch')
    for (const content of [
        [answer],
        [call, { ...result, content: { type: 'web_search_tool_result_error', error_code: 'unavailable' } }],
    ]) {
        fetchMock.mock.mockImplementation(async () => new Response(events('failed', content)))
        await assert.rejects(searchDeepSeekWeb(input), /no successful web search results/)
    }
    fetchMock.mock.mockImplementation(async () => new Response(events('short', [call, result], 'max_tokens')))
    await assert.rejects(searchDeepSeekWeb(input), /did not complete/)
    fetchMock.mock.mockImplementation(async () => new Response('rate limited', { status: 429 }))
    await assert.rejects(searchDeepSeekWeb(input), /429/)
})

test('search rejects nonofficial hosts before dispatch and propagates cancellation', async (t) => {
    const fetchMock = t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
        init.signal?.throwIfAborted()
        throw new Error('Unexpected request')
    })
    for (const baseUrl of ['https://api.deepseek.com.example/v1', 'https://api.commandcode.ai/provider/v1']) {
        await assert.rejects(searchDeepSeekWeb({ ...input, baseUrl }), /official DeepSeek/)
    }
    assert.equal(fetchMock.mock.callCount(), 0)
    await assert.rejects(searchDeepSeekWeb({ ...input, signal: AbortSignal.abort() }), { name: 'AbortError' })
})
