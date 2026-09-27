import { isOfficialDeepSeekResponsesProvider } from '@/lib/codex-deepseek'
import { readAnthropicSseAsResponses } from './codex-proxy/anthropic-stream'
import { anthropicResponseToResponses, responsesToAnthropicRequest } from './codex-proxy/anthropic-transform'
import { openAnthropicUpstream } from './codex-proxy/anthropic-upstream'
import { decodeAnthropicWebSearch } from './codex-proxy/anthropic-web-search'
import { CodexToolContext, isObject } from './codex-proxy/tool-context'

type JsonObject = Record<string, unknown>

/** Search with the connection's DeepSeek key independently of its Responses conversation. */
export async function searchDeepSeekWeb(input: {
    baseUrl: string
    apiKey: string
    query: string
    signal: AbortSignal
}) {
    if (!isOfficialDeepSeekResponsesProvider('responses', input.baseUrl)) {
        throw new Error('Web search requires an official DeepSeek connection.')
    }
    const context = CodexToolContext.fromRequest({})
    const body = responsesToAnthropicRequest({
        model: 'deepseek-flash',
        input: `Search the web for: ${input.query}\nReturn a concise summary with source links.`,
        tools: [{ type: 'web_search' }],
        tool_choice: { type: 'web_search' },
        max_tool_calls: 5,
        max_output_tokens: 4096,
        stream: false,
    }, context, { webSearch: true })
    const { upstream, continueMessage } = await openAnthropicUpstream({
        baseUrl: `${new URL(input.baseUrl).origin}/anthropic`,
        apiKey: input.apiKey, body, webSearch: true, signal: input.signal,
    })
    if (!upstream.ok) throw new Error(`DeepSeek web search failed (${upstream.status}): ${(await upstream.text()).slice(0, 500)}`)
    if (!upstream.body) throw new Error('DeepSeek web search returned an empty response.')
    const response = upstream.headers.get('content-type')?.includes('application/json')
        ? anthropicResponseToResponses(await upstream.json() as JsonObject, context)
        : await readAnthropicSseAsResponses({ upstream: upstream.body, context, continueMessage })
    if (response.status !== 'completed') throw new Error('DeepSeek web search did not complete.')

    const output = Array.isArray(response.output) ? response.output.filter(isObject) : []
    const results = output.flatMap((item) => (
        item.type === 'reasoning' && typeof item.encrypted_content === 'string'
            ? decodeAnthropicWebSearch(item.encrypted_content) ?? [] : []
    )).filter((block) => block.type === 'web_search_tool_result')
    const successful = results.filter((block) => Array.isArray(block.content)
        && (block.content.length === 0 || block.content.some((item) => isObject(item) && item.type === 'web_search_result')))
    if (successful.length === 0) throw new Error('DeepSeek returned no successful web search results.')

    const sources = new Map<string, { url: string; title: string }>()
    for (const block of successful) {
        for (const item of block.content as unknown[]) {
            if (!isObject(item) || item.type !== 'web_search_result' || typeof item.url !== 'string') continue
            if (!/^https?:\/\//i.test(item.url)) continue
            sources.set(item.url, { url: item.url, title: typeof item.title === 'string' ? item.title : '' })
        }
    }
    const text = output.filter((item) => item.type === 'message')
        .flatMap((item) => Array.isArray(item.content) ? item.content : [])
        .filter((part) => isObject(part) && part.type === 'output_text' && typeof part.text === 'string')
        .map((part) => part.text).join('\n')
    return { text, sources: [...sources.values()], usage: response.usage }
}
