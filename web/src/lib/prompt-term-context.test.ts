import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildTermMentionMatcher, findMentionedTermIds } from '@/components/editor/terms/term-mentions-utils'
import type { TermEntry } from '@/components/editor/terms/types'
import { createPromptContentResolvers } from './prompt-content-resolvers'
import { createPromptContentSelectionInput, type ContentSelectionTarget } from './prompt-inputs'
import { renderPromptTemplateMessages, type PromptTemplateRenderContext } from './prompt-template-render'
import { findRenderedTermIds, renderTermTemplateText, renderTermTemplateValue } from './term-template'

const entries: TermEntry[] = [
    { id: 'always', title: '白帝', categoryId: 'characters', aiContextPolicy: 'always', description: 'ALWAYS_KNOWLEDGE' },
    { id: 'detected', title: '云依', categoryId: 'characters', description: 'DETECTED_KNOWLEDGE', tags: ['主角'] },
    { id: 'extra', title: '洛海瑶', categoryId: 'characters', description: 'EXTRA_KNOWLEDGE' },
    { id: 'never', title: '隐者', categoryId: 'characters', aiContextPolicy: 'never', description: 'NEVER_KNOWLEDGE', tags: ['主角'] },
    { id: 'archived', title: '旧王', categoryId: 'characters', archived: true, aiContextPolicy: 'always', description: 'ARCHIVED_KNOWLEDGE' },
]
const termsById = new Map(entries.map((entry) => [entry.id, entry]))
const matcher = buildTermMentionMatcher(entries)

function render(source: string, options: { context?: PromptTemplateRenderContext; selections?: ContentSelectionTarget[]; components?: Record<string, string>; previous?: Array<{ key: string; value: string }>; descriptions?: Record<string, string> } = {}) {
    const termValues = new Map<string, string>()
    const resolveTermValue = (id: string) => {
        const entry = termsById.get(id) ?? null
        const text = renderTermTemplateValue({ entry: entry && options.descriptions?.[id] !== undefined ? { ...entry, description: options.descriptions[id] } : entry, termsById, includeRelations: false, includeExperiences: false })
        if (text) termValues.set(id, text)
        return text
    }
    const content = createPromptContentResolvers({
        getInput: (name) => name === '资料' ? { input: createPromptContentSelectionInput(), selections: options.selections ?? [] } : null,
        resources: { acts: [], chapters: [], chaptersById: new Map(), scenesById: new Map() },
        snippets: [], termsById, resolveTermValue,
    })
    const result = renderPromptTemplateMessages({
        texts: [source], context: options.context ?? {},
        resolvers: {
            ...content.resolvers,
            resolveInput: content.resolveValue,
            resolveInclude: (name) => options.components?.[name],
            resolveTextTermIds: (text) => [...findMentionedTermIds(text, matcher)],
            resolveTermText: (id) => renderTermTemplateText(termsById.get(id) ?? null),
            resolveTermValue,
        },
        options: options.previous ? { chat: { previousContextItems: options.previous } } : undefined,
    })
    assert.deepEqual(result.warnings, [])
    return { ...result, activeIds: findRenderedTermIds(result.texts, termValues) }
}

for (const expression of ['instruction.terms', 'chat.userInput.terms', 'chat.history.terms', 'inputs["资料"].term', 'inputs["资料"].termTag', 'termsfrom(scene.chapterOutline)']) {
    test(`${expression} applies the same inclusion policy before count and output`, () => {
        const result = render(`{% set selected = ${expression} %}{{ selected.count }}|{{ selected.value }}`, {
            context: { instructionTerms: ['detected', 'never', 'archived'], chatUserInputTerms: ['detected', 'never'], chatHistoryTerms: ['detected', 'never'], sceneChapterOutline: '云依与隐者、旧王' },
            selections: [{ kind: 'term', termId: 'detected' }, { kind: 'term', termId: 'never' }, { kind: 'term_tag', tag: '主角' }],
        })
        assert.match(result.texts[0], /^2\|/)
        assert.deepEqual(new Set(result.activeIds), new Set(['always', 'detected']))
        assert.doesNotMatch(result.texts[0], /NEVER_KNOWLEDGE|ARCHIVED_KNOWLEDGE/)
    })
}

test('empty sources still include always terms and pass the template count condition', () => {
    for (const expression of ['instruction.terms', 'inputs["资料"].term', 'inputs["资料"].termTag', 'termsfrom()', 'termsfrom("")', '[] | union([])']) {
        const result = render(`{% set terms = ${expression} %}{% if terms.count %}{{ terms.value }}{% endif %}`)
        assert.deepEqual(result.activeIds, ['always'], expression)
    }
})

test('unused collections, counts, names and skipped branches do not activate badges', () => {
    for (const source of [
        '{{ instruction.text }}',
        '{% set terms = instruction.terms %}没有输出资料',
        '{{ instruction.terms.count }}',
        '{{ instruction.terms.text }}',
        '{% if false %}{{ instruction.terms.value }}{% endif %}',
        '{% set captured %}{{ instruction.terms.value }}{% endset %}没有输出 captured',
    ]) {
        const result = render(source, { context: { instructionText: '白帝遇见云依与隐者', instructionTerms: ['detected', 'never'] } })
        assert.deepEqual(result.activeIds, [], source)
        assert.doesNotMatch(result.texts[0], /ALWAYS_KNOWLEDGE|DETECTED_KNOWLEDGE|NEVER_KNOWLEDGE/)
    }
})

test('nested includes and unions report only complete knowledge in the final output', () => {
    const result = render('{% include "Outer" %}', {
        context: { instructionTerms: ['detected'], sceneChapterOutline: '云依与隐者' },
        selections: [{ kind: 'term', termId: 'never' }],
        components: {
            Outer: '{% include "Inner" %}',
            Inner: '{% set terms = instruction.terms | union(termsfrom(scene.chapterOutline)) | union(inputs["资料"].term) %}{{ terms.value }}',
        },
    })
    assert.deepEqual(new Set(result.activeIds), new Set(['always', 'detected']))
    assert.equal(result.texts[0].split('ALWAYS_KNOWLEDGE').length - 1, 1)
    assert.equal(result.texts[0].split('DETECTED_KNOWLEDGE').length - 1, 1)
})

test('aggregate content selection also obeys policy and emits full term knowledge', () => {
    const result = render('{{ inputs["资料"].value }}', { selections: [{ kind: 'term', termId: 'never' }, { kind: 'term_tag', tag: '主角' }] })
    assert.deepEqual(new Set(result.activeIds), new Set(['always', 'detected']))
    assert.doesNotMatch(result.texts[0], /NEVER_KNOWLEDGE/)
    assert.deepEqual(render('{{ inputs["资料"].value }}').activeIds, [])
})

test('ordinary prose is preserved and is not interpreted as injected term knowledge', () => {
    const source = '{{ scene.chapterOutline }}'
    const result = render(source, { context: { sceneChapterOutline: '白帝与隐者在等云依。' } })
    assert.equal(result.texts[0], '白帝与隐者在等云依。')
    assert.deepEqual(result.activeIds, [])
})

test('continuation repeats current context while chat retains its existing history deduplication', () => {
    const source = '{{ instruction.terms.value }}'
    const first = render(source, { previous: [] })
    assert.deepEqual(first.activeIds, ['always'])
    const chatNext = render(source, { previous: first.chatState!.contextItems })
    assert.deepEqual(chatNext.activeIds, [])
    assert.equal(chatNext.texts[0], '')
    assert.deepEqual(render(source).activeIds, ['always'])
})

test('chat turn context lists all first-turn terms, then only new manual or detected terms', () => {
    const source = '{% set terms = chat.userInput.terms | union(inputs["资料"].term) %}{{ terms.value }}\n{{ chat.userInput }}'
    const currentIds = (result: ReturnType<typeof render>) => result.chatState!.contextItems.filter((item) => item.key.startsWith('term:')).map((item) => item.key.slice(5)).sort()
    const first = render(source, { previous: [], context: { chatUserInput: '云依', chatUserInputTerms: ['detected'] } })
    assert.deepEqual(currentIds(first), ['always', 'detected'])
    const second = render(source, {
        previous: first.chatState!.contextItems,
        context: { chatUserInput: '继续讨论云依', chatUserInputTerms: ['detected'] },
        selections: [{ kind: 'term', termId: 'extra' }, { kind: 'term', termId: 'never' }],
    })
    assert.deepEqual(currentIds(second), ['extra'])
    const third = render(source, {
        previous: [...first.chatState!.contextItems, ...second.chatState!.contextItems],
        context: { chatUserInput: '白帝、云依和洛海瑶', chatUserInputTerms: ['always', 'detected', 'extra'] },
    })
    assert.deepEqual(currentIds(third), [])
    assert.deepEqual(render(source, { previous: [], context: { chatUserInput: '云依', chatUserInputTerms: ['detected'] } }).activeIds.sort(), ['always', 'detected'])
})

test('chat term context includes revised knowledge again and excludes unchanged knowledge', () => {
    const source = '{{ chat.userInput.terms.value }}\n{{ chat.userInput }}'
    const context = { chatUserInput: '云依', chatUserInputTerms: ['detected'] }
    const first = render(source, { previous: [], context })
    const second = render(source, { previous: first.chatState!.contextItems, context, descriptions: { detected: 'UPDATED_KNOWLEDGE' } })
    assert.deepEqual(second.chatState!.contextItems.map((item) => item.key), ['term:detected'])
    assert.match(second.texts[0], /UPDATED_KNOWLEDGE/)
    assert.doesNotMatch(second.texts[0], /ALWAYS_KNOWLEDGE/)
})
