import assert from 'node:assert/strict'
import { test } from 'node:test'
import { useEditorChatStore } from './editor-chat-store'
import { editorChatApi, type EditorChatConversation } from '@/lib/api'
import { getChatContextHistory, buildChatRequestMessages } from '@/lib/ai-chat-messages'
import { serializeEditorChatConversation, type EditorChatConversationRecord } from '@/lib/server/editor-chat'
import type { PromptTemplateChatState } from '@/lib/prompt-template-render'

const renderState: PromptTemplateChatState = {
    contextItems: [{ key: 'chapter:c1:full_text', value: '章节正文' }],
    userInput: { before: '<Context>章节正文</Context>\n', after: '' },
}

function storedConversation() {
    const now = new Date('2026-09-25T10:00:00Z')
    const record: EditorChatConversationRecord = {
        id: 'chat', novelId: 'novel', ownerId: 'owner', title: null, titleManuallyEdited: false,
        promptId: null, selectedGroupId: null, draftContent: '', promptSnapshotJson: null, inputStateJson: null,
        createdAt: now, updatedAt: now,
        messages: [{
            id: 'user', role: 'user', content: '分析正文', sentContent: '<Context>章节正文</Context>\n分析正文',
            fullRenderedContent: '<Context>章节正文</Context>\n分析正文', renderStateJson: JSON.stringify(renderState),
            promptTokens: null, completionTokens: null, totalTokens: null, termIdsJson: '[]', attachmentsJson: '[]',
            conversationId: 'chat', createdAt: now,
        }],
    }
    return serializeEditorChatConversation(record) as EditorChatConversation
}

test('loading, appending and cloning a conversation preserve the sent context metadata', async (t) => {
    const previous = useEditorChatStore.getState()
    t.after(() => useEditorChatStore.setState(previous))
    useEditorChatStore.setState({ sessionsByNovel: {} })
    let saved = storedConversation()
    t.mock.method(editorChatApi, 'list', async () => ({ conversations: [structuredClone(saved)] }))
    t.mock.method(editorChatApi, 'appendMessage', async (_id: string, data: Parameters<typeof editorChatApi.appendMessage>[1]) => {
        assert.deepEqual(data.renderState, renderState)
        const message = { ...saved.messages[0], ...data, id: 'user-2' }
        saved = { ...saved, messages: [...saved.messages, message] }
        return { conversation: structuredClone(saved) }
    })
    t.mock.method(editorChatApi, 'clone', async () => ({ conversation: { ...structuredClone(saved), id: 'cloned' } }))
    await useEditorChatStore.getState().loadConversations('novel')
    const loaded = useEditorChatStore.getState().sessionsByNovel.novel.conversations[0]
    assert.deepEqual(getChatContextHistory(loaded.messages), renderState.contextItems)
    await useEditorChatStore.getState().appendMessage('novel', 'chat', {
        role: 'user', content: '再分析', sentContent: '<Context>章节正文</Context>\n再分析', renderState,
    })
    await useEditorChatStore.getState().cloneConversation('novel', 'chat')
    const cloned = useEditorChatStore.getState().sessionsByNovel.novel.conversations.find((item) => item.id === 'cloned')!
    assert.equal(cloned.messages.length, 2)
    assert.deepEqual(cloned.messages[1].renderState, renderState)
    assert.equal(buildChatRequestMessages([], cloned.messages)[1].content, '<Context>章节正文</Context>\n再分析')
})
