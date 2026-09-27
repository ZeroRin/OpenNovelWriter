export const OPENCODE_GO_SESSION_HEADER = 'x-opencode-session'

export function isOpenCodeGoBaseUrl(baseUrl?: string | null) {
    return baseUrl?.trim().replace(/\/+$/, '') === 'https://opencode.ai/zen/go/v1'
}

export function getOpenCodeGoHeaders(baseUrl?: string | null, sessionId?: string | null) {
    if (!isOpenCodeGoBaseUrl(baseUrl)) return undefined
    if (!sessionId?.trim()) throw new Error('OpenCode Go requires a conversation ID.')
    return {
        [OPENCODE_GO_SESSION_HEADER]: sessionId.trim(),
        'User-Agent': 'OpenNovelWriter/0.1.0',
    }
}

export function getCodexOpenCodeGoConfig(connection: { providerType: string; baseUrl?: string | null }, sessionId: string): Record<string, unknown> {
    if (connection.providerType !== 'custom' || !isOpenCodeGoBaseUrl(connection.baseUrl)) return {}
    return {
        'model_providers.opennovelwriter.http_headers': { [OPENCODE_GO_SESSION_HEADER]: sessionId },
    }
}
