import type { ContentSelectionTarget, PromptInputDefinition, PromptInputValue } from '@/lib/prompt-inputs'

export type ContinuationInputs = {
    custom?: Record<string, { dropdownOptionIds?: string[]; text?: string }>
    checkbox?: Record<string, boolean>
    contentSelection?: Record<string, ContentSelectionTarget[]>
}

export type ContinuationPromptSnapshot = {
    promptId: string
    promptName: string
    instruction: string
    inputs: ContinuationInputs
    inputDefinitions: PromptInputDefinition[]
    inputValues: Record<string, PromptInputValue>
    termIds: string[]
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
    modelGroupIds: string[]
    missingInputs: string[]
}

export function continuationInputsFromValues(definitions: PromptInputDefinition[], values: Record<string, PromptInputValue>): ContinuationInputs {
    const result: Required<ContinuationInputs> = { custom: {}, checkbox: {}, contentSelection: {} }
    for (const input of definitions) {
        const value = values[input.name]
        if (input.type === 'custom') {
            const state = value?.kind === 'custom' ? value : input.custom.defaultContent
            const ids = input.custom.dropdown.allowMultiple ? state.dropdownOptionIds : state.dropdownOptionIds.slice(0, 1)
            result.custom[input.name] = { dropdownOptionIds: [...ids], text: state.text }
        } else if (input.type === 'checkbox') {
            result.checkbox[input.name] = value?.kind === 'checkbox' ? value.checked : input.checkbox.defaultChecked
        } else result.contentSelection[input.name] = value?.kind === 'content_selection' ? value.selections : []
    }
    return result
}

export function continuationConversationMarkdown(messages: Array<{ role: string; content: string }>) {
    return messages.filter((message) => message.content.trim()).map((message) => `## ${message.role}\n\n${message.content.trim()}`).join('\n\n') + '\n'
}
