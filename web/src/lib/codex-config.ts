import { applyDeepSeekModelDefaults } from '@/lib/codex-deepseek'

export type CodexConnectionProviderType = 'openai-official' | 'custom'
export type CodexUpstreamFormat = 'responses' | 'chat-completions' | 'anthropic-messages'

type CodexChatGptAuthConnection = {
    providerType: string
    authStatus: string
    authType: string | null
}

export function isAuthenticatedChatGptCodexConnection(
    connection: CodexChatGptAuthConnection | null | undefined
) {
    return connection?.providerType === 'openai-official'
        && connection.authStatus === 'authenticated'
        && connection.authType === 'chatgpt'
}

export function isCodexFastModeAllowed(
    connection: CodexChatGptAuthConnection | null | undefined,
    customFastModeEnabled: boolean
) {
    return isAuthenticatedChatGptCodexConnection(connection)
        || (connection?.providerType === 'custom' && customFastModeEnabled)
}

export const CODEX_CUSTOM_FAST_SERVICE_TIER = {
    id: 'priority',
    name: 'Fast',
    description: 'Availability, actual speed, and usage depend on the upstream provider.',
} as const

export function getCustomCodexServiceTiers(upstreamFormat: string | null | undefined) {
    return upstreamFormat === 'responses' || upstreamFormat === 'chat-completions'
        ? [CODEX_CUSTOM_FAST_SERVICE_TIER]
        : []
}

export type CodexReasoningEffort =
    | 'none'
    | 'minimal'
    | 'low'
    | 'medium'
    | 'high'
    | 'xhigh'
    | 'max'
    | 'ultra'

export type CodexChatReasoningConfig = {
    supportsThinking: boolean
    supportsEffort: boolean
    thinkingParam: 'thinking' | 'enable_thinking' | 'none'
    effortParam: 'reasoning_effort' | 'none'
    outputFormat: 'reasoning_content' | 'think-tags'
}

export type CodexProviderModel = {
    id: string
    displayName: string
    contextWindow: number
    supportedReasoningEfforts: CodexReasoningEffort[]
    defaultReasoningEffort: CodexReasoningEffort
    supportsParallelToolCalls: boolean
    inputModalities: Array<'text' | 'image'>
    chatReasoning?: CodexChatReasoningConfig
}

export type CodexCustomProviderSettings = {
    apiKey: string
    baseUrl: string
    upstreamFormat: CodexUpstreamFormat
    defaultModelId: string
    models: CodexProviderModel[]
}

export const DEFAULT_CODEX_CUSTOM_BASE_URL = 'https://api.openai.com/v1'
export const DEFAULT_CODEX_MODEL = 'gpt-6-astra'
export const DEFAULT_CODEX_CHAT_SETTINGS = {
    modelId: DEFAULT_CODEX_MODEL,
    reasoningEffort: 'medium' as CodexReasoningEffort,
}
export const DEFAULT_CODEX_SCENE_SETTINGS = {
    modelId: 'gpt-5.6-sol',
    reasoningEffort: 'high' as CodexReasoningEffort,
}
export const DEFAULT_CODEX_CONTEXT_WINDOW = 300_000

export function getDefaultCodexAuthJson(_providerType: CodexConnectionProviderType = 'openai-official') {
    void _providerType
    return '{}\n'
}

export function getDefaultCodexConfig(_providerType: CodexConnectionProviderType = 'openai-official') {
    void _providerType
    return '\n'
}

export function createDefaultCodexProviderModel(modelId = DEFAULT_CODEX_MODEL): CodexProviderModel {
    // Seed known model capabilities when adding a model.
    return applyDeepSeekModelDefaults({
        id: modelId,
        displayName: modelId,
        contextWindow: DEFAULT_CODEX_CONTEXT_WINDOW,
        supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
        defaultReasoningEffort: 'high',
        supportsParallelToolCalls: true,
        inputModalities: ['text', 'image'],
    })
}

export function isGptCodexModelId(modelId: string) {
    return (modelId.trim().split('/').at(-1) ?? '').toLowerCase().startsWith('gpt-')
}

export function getNewCodexSessionModelSettings(
    connection: { providerType: string; defaultModelId: string | null } | null,
    category: string = 'general'
) {
    const modelId = connection?.defaultModelId?.trim() || DEFAULT_CODEX_MODEL
    if (!connection || connection.providerType === 'openai-official' || isGptCodexModelId(modelId)) {
        return category === 'scene_operation' ? DEFAULT_CODEX_SCENE_SETTINGS : DEFAULT_CODEX_CHAT_SETTINGS
    }
    return { modelId, reasoningEffort: 'high' as CodexReasoningEffort }
}

export function getDefaultCodexCustomSettings(): CodexCustomProviderSettings {
    return {
        apiKey: '',
        baseUrl: DEFAULT_CODEX_CUSTOM_BASE_URL,
        upstreamFormat: 'responses',
        // New custom connections start with no models; the user must fetch or
        // add one before the connection can be saved.
        defaultModelId: '',
        models: [],
    }
}

export function parseCodexUpstreamFormat(value: unknown): CodexUpstreamFormat | null {
    return value === 'responses' || value === 'chat-completions' || value === 'anthropic-messages'
        ? value
        : null
}

// DeepSeek vendor adapters live in codex-deepseek.ts; re-export so existing
// call sites keep working while new adapters stay isolated per vendor.
export {
    applyCodexUpstreamModelCapabilities,
    applyDeepSeekModelDefaults,
    isOfficialDeepSeekResponsesProvider,
} from '@/lib/codex-deepseek'

export function normalizeCodexProviderModels(value: unknown): CodexProviderModel[] {
    if (!Array.isArray(value)) return []

    const seen = new Set<string>()
    const models: CodexProviderModel[] = []
    for (const item of value) {
        if (!item || typeof item !== 'object') continue
        const record = item as Record<string, unknown>
        const id = typeof record.id === 'string' ? record.id.trim() : ''
        if (!id || seen.has(id)) continue

        const contextWindow = Number(record.contextWindow)
        if (!Number.isFinite(contextWindow) || contextWindow <= 0) continue

        const efforts = Array.isArray(record.supportedReasoningEfforts)
            ? record.supportedReasoningEfforts.filter(isCodexReasoningEffort)
            : []
        const defaultReasoningEffort = isCodexReasoningEffort(record.defaultReasoningEffort)
            ? record.defaultReasoningEffort
            : efforts[0] ?? 'high'
        const supportedReasoningEfforts = efforts.includes(defaultReasoningEffort)
            ? efforts
            : [defaultReasoningEffort, ...efforts]
        const inputModalities: Array<'text' | 'image'> = Array.isArray(record.inputModalities)
            ? record.inputModalities.filter((item): item is 'text' | 'image' => item === 'text' || item === 'image')
            : ['text']

        let chatReasoning: CodexChatReasoningConfig | undefined
        if (record.chatReasoning && typeof record.chatReasoning === 'object') {
            const reasoning = record.chatReasoning as Record<string, unknown>
            chatReasoning = {
                supportsThinking: reasoning.supportsThinking === true,
                supportsEffort: reasoning.supportsEffort === true,
                thinkingParam:
                    reasoning.thinkingParam === 'enable_thinking' || reasoning.thinkingParam === 'none'
                        ? reasoning.thinkingParam
                        : 'thinking',
                effortParam: reasoning.effortParam === 'none' ? 'none' : 'reasoning_effort',
                outputFormat: reasoning.outputFormat === 'think-tags' ? 'think-tags' : 'reasoning_content',
            }
        }

        seen.add(id)
        models.push({
            id,
            displayName:
                typeof record.displayName === 'string' && record.displayName.trim()
                    ? record.displayName.trim()
                    : id,
            contextWindow: Math.floor(contextWindow),
            supportedReasoningEfforts,
            defaultReasoningEffort,
            supportsParallelToolCalls: record.supportsParallelToolCalls === true,
            inputModalities: inputModalities.length > 0 ? [...new Set(inputModalities)] : ['text'],
            ...(chatReasoning ? { chatReasoning } : {}),
        })
    }
    return models
}

export function parseCodexProviderModelsJson(value: string | null | undefined): CodexProviderModel[] {
    try {
        return normalizeCodexProviderModels(JSON.parse(value || '[]'))
    } catch {
        return []
    }
}

function isCodexReasoningEffort(value: unknown): value is CodexReasoningEffort {
    return (
        value === 'none' ||
        value === 'minimal' ||
        value === 'low' ||
        value === 'medium' ||
        value === 'high' ||
        value === 'xhigh' ||
        value === 'max' ||
        value === 'ultra'
    )
}
