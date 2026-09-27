import assert from 'node:assert/strict'
import { test } from 'node:test'

import { buildTermMentionMatcher, findMentionedTermIds } from '@/components/editor/terms/term-mentions-utils'
import type { TermEntry } from '@/components/editor/terms/types'
import { renderPromptTemplateMessages, type PromptTemplateRenderContext, type PromptTemplateRenderResolvers } from './prompt-template-render'
import { renderTermTemplateText, renderTermTemplateValue, resolveTrackedTermIds } from './term-template'

const entries: TermEntry[] = [
    { id: 'hero', categoryId: 'characters', title: '陆昭', aliases: '陆公子', description: 'HERO_KNOWLEDGE' },
    { id: 'city', categoryId: 'locations', title: '雁回城', description: 'CITY_KNOWLEDGE' },
    { id: 'sword', categoryId: 'items', title: '明月剑', description: 'SWORD_KNOWLEDGE' },
    { id: 'never', categoryId: 'characters', title: '隐者', aiContextPolicy: 'never', description: 'NEVER_KNOWLEDGE' },
    { id: 'archived', categoryId: 'characters', title: '旧王', archived: true, description: 'ARCHIVED_KNOWLEDGE' },
]
const termsById = new Map(entries.map((entry) => [entry.id, entry]))
const matcher = buildTermMentionMatcher(entries)
const resolvers: PromptTemplateRenderResolvers = {
    resolveInput: () => '',
    resolveInclude: () => null,
    resolveTextTermIds: (text) => resolveTrackedTermIds({ mentionedTermIds: findMentionedTermIds(text, matcher), termsById }),
    resolveTermText: (id) => renderTermTemplateText(termsById.get(id) ?? null),
    resolveTermValue: (id) => renderTermTemplateValue({ entry: termsById.get(id) ?? null, termsById, includeRelations: false, includeExperiences: false }),
}

function render(source: string, context: PromptTemplateRenderContext = {}, overrides: Partial<PromptTemplateRenderResolvers> = {}) {
    const result = renderPromptTemplateMessages({ texts: [source], context, resolvers: { ...resolvers, ...overrides } })
    assert.deepEqual(result.warnings, [])
    return result.texts[0]
}

test('termsfrom detects titles and aliases, obeys context policy and returns a union-compatible collection', () => {
    const output = render(`{% set detected = termsfrom("陆公子遇到陆昭、隐者与旧王。") %}
{{ detected.ids | join(",") }}|{{ detected.count }}|{{ detected.text }}
{% set terms = detected | union(instruction.terms) | union(termsfrom("雁回城里的陆昭")) %}
{{ terms.count }}|{{ terms.value }}`, { instructionTerms: ['hero', 'city'] })
    assert.match(output, /hero\|1\|陆昭/)
    assert.match(output, /2\|/)
    assert.equal(output.split('HERO_KNOWLEDGE').length - 1, 1)
    assert.equal(output.split('CITY_KNOWLEDGE').length - 1, 1)
    assert.doesNotMatch(output, /NEVER_KNOWLEDGE|ARCHIVED_KNOWLEDGE|SWORD_KNOWLEDGE/)
})

test('termsfrom supports multiple arguments and nested lists without merging adjacent words', () => {
    const output = render('{{ termsfrom(["陆公子", ["雁回城", "陆昭", null]], "明月剑").ids | join(",") }}')
    assert.equal(output, 'hero,city,sword')
    assert.equal(render('{{ termsfrom("陆", "昭").count }}'), '0')
})

for (const [expression, context] of [
    ['scene.text', { sceneText: '陆公子进城。' }],
    ['scene.previousText', { sceneContinuePreviousText: '陆公子进城。' }],
    ['scene.followText', { sceneContinueFollowText: '陆公子进城。' }],
    ['scene.actOutline', { sceneActOutline: '陆公子进城。' }],
    ['scene.chapterOutline', { sceneChapterOutline: '陆公子进城。' }],
    ['novel.outline', { novelOutlineStorySoFar: '陆公子进城。' }],
    ['novel.outline.full', { novelOutlineFull: '陆公子进城。' }],
    ['instruction.text', { instructionText: '陆公子进城。' }],
    ['chat.userInput', { chatUserInput: '陆公子进城。' }],
    ['chat.history', { chatHistoryText: '陆公子进城。' }],
] satisfies Array<[string, PromptTemplateRenderContext]>) {
    test(`termsfrom expands ${expression}`, () => {
        assert.equal(render(`{{ termsfrom(${expression}).ids | join(",") }}`, context), 'hero')
    })
}

test('termsfrom expands custom inputs through their values and evaluates template expressions', () => {
    const output = render(`{% set source = inputs["要求"] %}
{{ termsfrom(source).ids | join(",") }}|{{ termsfrom(scene.chapterOutline or source.value).ids | join(",") }}`, {
        sceneChapterOutline: '雁回城',
    }, { resolveInput: () => '陆公子进城。' })
    assert.equal(output.trim(), 'hero|city')
})

const listResolvers: Array<[string, keyof PromptTemplateRenderResolvers]> = [
    ['snippet', 'resolveInputSnippets'],
    ['fullNovel', 'resolveInputFullNovels'],
    ['act', 'resolveInputActs'],
    ['chapter', 'resolveInputChapters'],
    ['scene', 'resolveInputScenes'],
    ['actOutline', 'resolveInputActOutlines'],
    ['chapterOutline', 'resolveInputChapterOutlines'],
]
for (const [kind, resolver] of listResolvers) {
    test(`termsfrom expands ${kind} collections using content rather than titles`, () => {
        const overrides = { [resolver]: () => [
            { text: '明月剑', value: '陆公子进城。' },
            { text: '明月剑', value: '雁回城的大门关闭。' },
        ] }
        const output = render(`{{ termsfrom(inputs["补充"].${kind}).ids | join(",") }}|{{ termsfrom(inputs["补充"].${kind}.value).ids | join(",") }}`, {}, overrides)
        assert.equal(output, 'hero,city|hero,city')
    })
}

test('termsfrom can detect terms inside explicitly supplied term and term-tag knowledge', () => {
    const linked = [{ id: 'notes', categoryId: 'settings', title: '笔记', description: '陆公子拿起明月剑。' }, ...entries]
    const linkedById = new Map(linked.map((entry) => [entry.id, entry]))
    const output = render('{{ termsfrom(inputs["资料"].term, inputs["资料"].termTag).ids | join(",") }}', {}, {
        resolveInputTermIds: () => ['notes'],
        resolveInputTermTagTermIds: () => ['notes'],
        resolveTermValue: (id) => renderTermTemplateValue({ entry: linkedById.get(id) ?? null, termsById: linkedById, includeRelations: false, includeExperiences: false }),
    })
    assert.equal(output, 'hero,sword')
})

test('termsfrom accepts captured component output, including variables and nested includes', () => {
    const output = render(`{% set content %}{% include "资料" %}{% endset %}{{ termsfrom(content).ids | join(",") }}`, {
        sceneText: '陆公子在雁回城。',
    }, {
        resolveInclude: (name) => name === '资料' ? '{{ scene.text }}{% include "补充" %}' : '{{ inputs["补充"].value }}',
        resolveInput: () => '明月剑',
    })
    assert.equal(output, 'hero,city,sword')
})

test('termsfrom scans only evaluated arguments and does not execute template syntax in their contents', () => {
    let calls = 0
    const overrides = { resolveTextTermIds: (text: string) => {
        calls += 1
        return resolvers.resolveTextTermIds?.(text)
    } }
    const context = { sceneActOutline: '雁回城', sceneChapterOutline: '明月剑', sceneText: '陆昭' }
    assert.equal(render('{{ scene.text }}', context, overrides), '陆昭')
    assert.equal(calls, 0)
    assert.equal(render('{% if false %}{{ termsfrom(scene.text).value }}{% endif %}', context, overrides), '')
    assert.equal(calls, 0)
    assert.equal(render('{{ termsfrom(scene.text).ids | join(",") }}', context, overrides), 'hero')
    assert.equal(calls, 1)
    assert.equal(render('{{ termsfrom(inputs["资料"]).count }}', context, {
        resolveInput: () => '{{ scene.text }}',
    }), '0')
})

test('termsfrom returns an empty collection for empty, missing or unresolvable contents', () => {
    const noScan = { resolveTextTermIds: () => { assert.fail('empty content must not be scanned') } }
    assert.equal(render('{{ termsfrom().count }}|{{ termsfrom(null, " ", [], missing).value }}', {}, noScan), '0|')
    assert.equal(render('{{ termsfrom("陆昭").count }}', {}, { resolveTextTermIds: undefined }), '0')
})
