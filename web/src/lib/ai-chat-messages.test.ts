import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Prompt } from './api'
import type { PromptMessage } from './prompts'
import preset from '@/presets/assets/preset-1rdyzld.json'
import { buildChatRequestMessages, createChatPromptSnapshot, editChatUserMessage, getChatContextHistory } from './ai-chat-messages'
import { getContentSelectionTemplateItems } from './content-selection-template'
import { renderPromptTemplateMessages, type PromptTemplateRenderContext, type PromptTemplateRenderListItem, type PromptTemplateRenderResolvers, type PromptTemplateChatState } from './prompt-template-render'

const prompts = preset.bundle.prompts.map((prompt, index) => ({ ...prompt, id: `prompt-${index}` })) as unknown as Prompt[]
const prompt = prompts.find((item) => item.category === 'ai_chat')!
const components = prompts.filter((item) => item.category === 'component')
const source = prompt.messages.at(-1)!.content
const scenes = [
    { id: 's1', order: 0, content: '<p>第一场正文。</p>', summary: '第一场摘要', labelIds: [] },
    { id: 's2', order: 1, content: '<p>第二场正文。</p>', summary: '第二场摘要', labelIds: ['label'] },
    { id: 's3', order: 0, content: '<p>第三场正文。</p>', summary: '第三场摘要', labelIds: [] },
]
const chapters = [
    { id: 'c1', title: '重逢', order: 0, actNumber: 1, scenes: scenes.slice(0, 2) },
    { id: 'c2', title: '离别', order: 1, actNumber: 1, scenes: scenes.slice(2) },
]
const resources = { acts: [], chapters, chaptersById: new Map(chapters.map((item) => [item.id, item])), scenesById: new Map(scenes.map((item) => [item.id, item])) }
const input = prompt.inputs[0]
assert.equal(input.type, 'content_selection')
const items = (ids: string[]) => getContentSelectionTemplateItems({ kind: 'chapter', input, selections: ids.map((chapterId) => ({ kind: 'chapter', chapterId })), resources, locale: 'zh' })

type Message = { id: string; role: 'user' | 'assistant'; content: string; sentContent?: string; renderState?: PromptTemplateChatState }
function renderTurn(options: { draft?: string; history?: Message[]; chapters?: PromptTemplateRenderListItem[]; source?: string; context?: PromptTemplateRenderContext; resolvers?: Partial<PromptTemplateRenderResolvers>; texts?: string[] } = {}) {
    const draft = options.draft ?? '请分析人物动机。\n\n请完整分析。'
    const rendered = renderPromptTemplateMessages({
        texts: options.texts ?? [options.source ?? source],
        context: { novelLanguage: '中文', chatUserInput: draft, ...options.context },
        resolvers: {
            resolveInput: () => '',
            resolveInclude: (name) => components.find((item) => item.name === name)?.messages[0].content,
            resolveInputChapters: () => options.chapters ?? [],
            ...options.resolvers,
        },
        options: { chat: { previousContextItems: getChatContextHistory(options.history ?? []) } },
    })
    assert.deepEqual(rendered.warnings, [])
    const content = rendered.texts.at(-1)!
    const message: Message = { id: `user-${options.history?.length ?? 0}`, role: 'user', content: draft, sentContent: content, renderState: rendered.chatState }
    assert.ok(content.includes(draft))
    return { content, message, rendered }
}

function assertAdditionalInfoBalanced(content: string) {
    assert.equal(content.split('<AdditionalInfo>').length, content.split('</AdditionalInfo>').length)
}

test('reselecting an unchanged chapter omits its complete context and preserves the entire repeated instruction', () => {
    const first = renderTurn({ chapters: items(['c1']) })
    const next = renderTurn({ chapters: items(['c1']), history: [first.message] })
    assert.match(first.content, /第一场正文。/)
    assert.doesNotMatch(next.content, /第一场正文。|第二场正文。|<AdditionalInfo>/)
    assert.equal(first.message.renderState?.contextItems.length, 1)
    assertAdditionalInfoBalanced(next.content)
})

test('switching or adding chapters keeps the new chapter complete without repeating the old one', () => {
    const first = renderTurn({ chapters: items(['c1']) })
    for (const selected of [['c2'], ['c1', 'c2']]) {
        const next = renderTurn({ chapters: items(selected), history: [first.message] })
        assert.match(next.content, /第 2 章: 离别\n第 2 章: 离别 · 场 1\n第三场正文。/)
        assert.doesNotMatch(next.content, /第一场正文。|第二场正文。/)
        assertAdditionalInfoBalanced(next.content)
    }
})

test('modified and reverted chapters are resent in full using the last sent version', () => {
    const original = items(['c1'])
    const first = renderTurn({ chapters: original })
    const updated = original.map((item) => ({ ...item, value: item.value.replace('第二场正文。', '第二场修改后的正文。') }))
    const second = renderTurn({ chapters: updated, history: [first.message] })
    assert.match(second.content, /第一场正文。/)
    assert.match(second.content, /第二场修改后的正文。/)
    const third = renderTurn({ chapters: original, history: [first.message, second.message] })
    assert.match(third.content, /第一场正文。/)
    assert.match(third.content, /第二场正文。/)
    assertAdditionalInfoBalanced(second.content)
    assertAdditionalInfoBalanced(third.content)
})

for (const [kind, resolver] of [
    ['fullNovel', 'resolveInputFullNovels'], ['act', 'resolveInputActs'], ['scene', 'resolveInputScenes'],
    ['actOutline', 'resolveInputActOutlines'], ['chapterOutline', 'resolveInputChapterOutlines'], ['snippet', 'resolveInputSnippets'],
] as const) {
    test(`deduplication preserves complete ${kind} collections`, () => {
        const template = `{% if inputs["额外信息"].${kind}.count %}<Context>\n{{ inputs["额外信息"].${kind}.value }}\n</Context>{% endif %}\n{{ chat.userInput }}`
        const item = { key: `${kind}:1`, text: '资料', value: '内容一\n\n内容二' }
        const first = renderTurn({ source: template, resolvers: { [resolver]: () => [item] } })
        const next = renderTurn({ source: template, history: [first.message], resolvers: { [resolver]: () => [item, { ...item, key: `${kind}:2`, value: '内容三\n\n内容四' }] } })
        assert.doesNotMatch(next.content, /内容一|内容二/)
        assert.match(next.content, /<Context>\n内容三\n\n内容四\n<\/Context>/)
    })
}

test('term unions omit previously sent knowledge and resend edited knowledge', () => {
    const resolvers = { resolveInputTermIds: () => ['hero', 'city'], resolveTermValue: (id: string) => `${id} 设定\n\n设定详情` }
    const first = renderTurn({ resolvers })
    const next = renderTurn({ history: [first.message], resolvers: { ...resolvers, resolveTermValue: (id) => id === 'hero' ? 'hero 新设定\n\n新详情' : resolvers.resolveTermValue(id) } })
    assert.match(next.content, /hero 新设定\n\n新详情/)
    assert.doesNotMatch(next.content, /city 设定/)
    assert.match(next.content, /<TermKnowledge>[\s\S]*<\/TermKnowledge>/)
})

test('unused selections are not recorded as sent context', () => {
    const first = renderTurn({ source: '{% if false %}{{ inputs["额外信息"].chapter.value }}{% endif %}{{ chat.userInput }}', chapters: items(['c1']) })
    assert.deepEqual(first.message.renderState?.contextItems, [])
    const next = renderTurn({ chapters: items(['c1']), history: [first.message] })
    assert.match(next.content, /第一场正文。/)
})

test('the request history is copied literally and retry reproduces the same prefix and user message', () => {
    const first = renderTurn({ draft: '解释 {{ novel.language }} 和 {% include "资料" %}', texts: prompt.messages.map((item) => item.content) })
    const prefix: PromptMessage[] = [{ ...prompt.messages[0], content: first.rendered.texts[0] }]
    const initial = buildChatRequestMessages(prefix, [], { ...prompt.messages.at(-1)!, content: first.content })
    const retry = buildChatRequestMessages(prefix, [first.message])
    assert.deepEqual(initial.map(({ role, content }) => ({ role, content })), retry.map(({ role, content }) => ({ role, content })))
    assert.doesNotMatch(retry[0].content, /\{\{novel.language\}\}/)
    const assistant: Message = { id: 'assistant', role: 'assistant', content: '示例 {{ novel.language }} 与 {% broken %}' }
    const next = renderTurn({ history: [first.message, assistant] })
    const request = buildChatRequestMessages(prefix, [first.message, assistant], { ...prompt.messages.at(-1)!, content: next.content })
    assert.equal(request[1].content, first.content)
    assert.equal(request[2].content, assistant.content)
})

test('editing user text preserves attached context, even if that text also appears in the context', () => {
    const first = renderTurn({ draft: '第一场正文。', chapters: items(['c1']) })
    const edit = editChatUserMessage(first.message, '改为分析对话。\n\n保留人物视角。')
    assert.match(edit.sentContent!, /第一场正文。/)
    assert.match(edit.sentContent!, /改为分析对话。\n\n保留人物视角。/)
    assertAdditionalInfoBalanced(edit.sentContent!)
    const request = buildChatRequestMessages([], [{ ...first.message, ...edit }])
    assert.equal(request[0].content, edit.sentContent)
    assert.deepEqual(editChatUserMessage({ role: 'assistant', content: 'old' }, 'new'), { content: 'new' })
})

test('snapshots freeze referenced components recursively and the rendered prefix', () => {
    const root = { ...prompt, messages: [{ id: 'system', role: 'system', content: 'System' }, { id: 'user', role: 'user', content: '{% include "A" %}{{ chat.userInput }}' }] } as Prompt
    const a = { ...components[0], id: 'a', name: 'A', messages: [{ id: 'a', role: 'system', content: 'A{% include "B" %}' }] } as Prompt
    const b = { ...components[0], id: 'b', name: 'B', messages: [{ id: 'b', role: 'system', content: 'B' }] } as Prompt
    const prefix = [root.messages[0]]
    const snapshot = createChatPromptSnapshot(root, [a, b, ...components], prefix)
    a.messages[0].content = 'changed'
    prefix[0].content = 'changed system'
    assert.deepEqual(snapshot.chatContext.components.map((item) => item.name), ['A', 'B'])
    assert.equal(snapshot.chatContext.components[0].messages[0].content, 'A{% include "B" %}')
    assert.equal(snapshot.chatContext.prefixMessages[0].content, 'System')
})

test('a separate conversation and a clone truncated before context was sent receive that context', () => {
    const first = renderTurn({ chapters: items(['c1']) })
    const independent = renderTurn({ chapters: items(['c1']), history: [] })
    assert.match(independent.content, /第一场正文。/)
    const clone = renderTurn({ chapters: items(['c1']), history: [structuredClone(first.message)] })
    assert.doesNotMatch(clone.content, /第一场正文。/)
})

test('termsfrom still reads an unchanged outline when its knowledge was not sent before', () => {
    const outline = { key: 'chapterOutline:c1', value: '云依在码头等人。' }
    const resolvers = { resolveInputChapterOutlines: () => [outline], resolveTextTermIds: () => ['hero'], resolveTermValue: () => '云依的人物档案' }
    const first = renderTurn({ source: '{{ inputs["额外信息"].chapterOutline.value }}\n{{ chat.userInput }}', resolvers })
    const next = renderTurn({ source: '{{ termsfrom(inputs["额外信息"].chapterOutline).value }}\n{{ chat.userInput }}', resolvers, history: [first.message] })
    assert.match(next.content, /云依的人物档案/)
    assert.doesNotMatch(next.content, /在码头等人/)
})

test('summary and full text of the same resource have distinct deduplication identities', () => {
    const first = renderTurn({ chapters: [{ key: 'chapter:c1:summary', value: '第一章摘要' }] })
    const next = renderTurn({ chapters: items(['c1']), history: [first.message] })
    assert.match(next.content, /第一场正文。/)
})
