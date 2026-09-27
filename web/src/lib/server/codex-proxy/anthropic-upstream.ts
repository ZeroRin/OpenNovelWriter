type JsonObject = Record<string, unknown>

export async function openAnthropicUpstream(input: {
    baseUrl: string
    apiKey: string
    body: JsonObject
    webSearch: boolean
    signal: AbortSignal
    userAgent?: string | null
    search?: string
    headers?: Record<string, string>
}) {
    const requestedStream = input.body.stream === true
    const body = input.webSearch ? { ...input.body, stream: true } : input.body
    const baseUrl = input.baseUrl.replace(/\/+$/, '')
    const endpoint = /\/v1\/messages$/i.test(baseUrl)
        ? baseUrl
        : /\/v1$/i.test(baseUrl) ? `${baseUrl}/messages` : `${baseUrl}/v1/messages`
    const headers = new Headers({
        'x-api-key': input.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        accept: 'application/json',
    })
    if (input.userAgent) headers.set('user-agent', input.userAgent)
    for (const [name, value] of Object.entries(input.headers ?? {})) headers.set(name, value)
    const send = (body: JsonObject) => fetch(`${endpoint}${input.search ?? ''}`, {
        method: 'POST', headers,
        body: JSON.stringify(body),
        signal: input.signal,
        cache: 'no-store',
    })
    const upstream = await send(body)
    const messages = [...body.messages as JsonObject[]]
    const continueMessage = input.webSearch ? async (message: JsonObject) => {
        messages.push(message)
        const next = await send({ ...body, messages, tool_choice: { type: 'auto' } })
        if (!next.ok) throw new Error(`Anthropic search continuation failed (${next.status}): ${(await next.text()).slice(0, 500)}`)
        if (!next.body) throw new Error('Anthropic search continuation returned an empty response body.')
        return next.body
    } : undefined
    return { upstream, requestedStream, continueMessage }
}
