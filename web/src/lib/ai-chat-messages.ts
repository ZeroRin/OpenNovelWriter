import type { Prompt } from '@/lib/api'
import type { PromptMessage } from '@/lib/prompts'
import type { PromptTemplateChatState } from '@/lib/prompt-template-render'
import { extractNunjucksIncludeNamesFromText } from '@/lib/prompt-template'

export type ChatPromptSnapshot = Prompt & {
    chatContext: { components: Prompt[]; prefixMessages: PromptMessage[] }
}

type ChatHistoryMessage = {
    id: string
    role: 'user' | 'assistant'
    content: string
    sentContent?: string | null
    renderState?: PromptTemplateChatState | null
}

export function createChatPromptSnapshot(prompt: Prompt, components: Prompt[], prefixMessages: PromptMessage[]): ChatPromptSnapshot {
    const byName = new Map(components.map((component) => [component.name.trim().toLowerCase(), component]))
    const included = new Map<string, Prompt>()
    function visit(messages: PromptMessage[]) {
        for (const message of messages) {
            for (const name of extractNunjucksIncludeNamesFromText(message.content)) {
                const component = byName.get(name.trim().toLowerCase())
                if (!component || included.has(component.id)) continue
                included.set(component.id, component)
                visit(component.messages)
            }
        }
    }
    visit(prompt.messages)
    return structuredClone({ ...prompt, chatContext: { components: [...included.values()], prefixMessages } })
}

export function buildChatRequestMessages(prefixMessages: PromptMessage[], history: ChatHistoryMessage[], current?: PromptMessage) {
    return [
        ...prefixMessages,
        ...history.map((message) => ({
            id: `chat_history_${message.id}`,
            role: message.role,
            content: message.role === 'user' ? message.sentContent ?? message.content : message.content,
        })),
        ...(current ? [current] : []),
    ].filter((message) => message.content.trim())
}

export function getChatContextHistory(history: ChatHistoryMessage[]) {
    return history.flatMap((message) => message.role === 'user' ? message.renderState?.contextItems ?? [] : [])
}

export function editChatUserMessage(message: Pick<ChatHistoryMessage, 'role' | 'content' | 'sentContent' | 'renderState'>, content: string) {
    if (message.role !== 'user') return { content }
    const input = message.renderState?.userInput
    const sentContent = input ? `${input.before}${content}${input.after}` : content
    return { content, sentContent, fullRenderedContent: sentContent }
}
