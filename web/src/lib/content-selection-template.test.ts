import assert from 'node:assert/strict'
import { test } from 'node:test'

import { getContentSelectionTemplateItems, type ContentSelectionTemplateResources } from './content-selection-template'
import { createPromptContentSelectionInput, type ContentSelectionTarget } from './prompt-inputs'
import { renderPromptTemplateMessages } from './prompt-template-render'

function fixture() {
    const scenes = [
        { id: 'scene-1', order: 0, content: '<p>First scene prose.</p>', summary: 'First scene summary.', labelIds: ['scene-label', 'shared-label'] },
        { id: 'scene-2', order: 1, content: '<p>Second scene prose.</p>', summary: 'Second scene summary.', labelIds: [] },
        { id: 'scene-3', order: 0, content: '<p>Third scene prose.</p>', summary: 'Third scene summary.', labelIds: ['scene-label'] },
    ]
    const chapters = [
        { id: 'chapter-1', title: 'First chapter', order: 0, actNumber: 1, scenes: scenes.slice(0, 2) },
        { id: 'chapter-2', title: 'Second chapter', order: 1, actNumber: 2, scenes: scenes.slice(2) },
    ]
    const resources: ContentSelectionTemplateResources = {
        acts: [
            { number: 1, title: 'First act', summary: 'First act summary.', labelIds: ['act-label', 'shared-label'] },
            { number: 2, title: 'Second act', summary: 'Second act summary.', labelIds: [] },
        ],
        chapters,
        chaptersById: new Map(chapters.map((chapter) => [chapter.id, chapter])),
        scenesById: new Map(scenes.map((scene) => [scene.id, scene])),
    }
    const input = createPromptContentSelectionInput()
    input.contentSelection.options.label = { enabled: true, actTreatAs: 'full_text', sceneTreatAs: 'full_text' }
    const items = (kind: 'act' | 'scene', selections: ContentSelectionTarget[]) =>
        getContentSelectionTemplateItems({ kind, input, selections, resources, locale: 'en' })
    return { input, items }
}

test('a scene label sends matching prose across chapters in manuscript order', () => {
    const { items } = fixture()
    const selected = items('scene', [{ kind: 'label', labelId: 'scene-label' }])

    assert.equal(selected.length, 2)
    assert.match(selected[0].value, /First scene prose\./)
    assert.match(selected[0].text, /First chapter/)
    assert.match(selected[1].value, /Third scene prose\./)
    assert.doesNotMatch(selected.map((item) => item.value).join('\n'), /Second scene prose|<p>/)
})

test('an act label sends the prose of the associated volume only', () => {
    const { items } = fixture()
    const selected = items('act', [{ kind: 'label', labelId: 'act-label' }])

    assert.equal(selected.length, 1)
    assert.match(selected[0].value, /First scene prose\./)
    assert.match(selected[0].value, /Second scene prose\./)
    assert.doesNotMatch(selected[0].value, /Third scene prose|First act summary/)
})

test('label summary settings are independent of direct act and scene settings', () => {
    const { input, items } = fixture()
    input.contentSelection.options.label.actTreatAs = 'summary'
    input.contentSelection.options.label.sceneTreatAs = 'summary'
    input.contentSelection.options.act.treatAs = 'full_text'
    input.contentSelection.options.scene.treatAs = 'full_text'

    const selections: ContentSelectionTarget[] = [{ kind: 'label', labelId: 'shared-label' }]
    const text = [...items('act', selections), ...items('scene', selections)].map((item) => item.value).join('\n')
    assert.match(text, /First act summary\./)
    assert.match(text, /First scene summary\./)
    assert.doesNotMatch(text, /scene prose/)
})

test('overlapping labels and direct selections send each matching resource once', () => {
    const { input, items } = fixture()
    input.contentSelection.options.label.sceneTreatAs = 'summary'
    const selections: ContentSelectionTarget[] = [
        { kind: 'label', labelId: 'scene-label' },
        { kind: 'label', labelId: 'shared-label' },
        { kind: 'label', labelId: 'act-label' },
        { kind: 'scene', sceneId: 'scene-1' },
        { kind: 'act', actNumber: 1 },
    ]

    assert.equal(items('act', selections).length, 1)
    const selectedScenes = items('scene', selections)
    assert.equal(selectedScenes.length, 2)
    assert.match(selectedScenes[0].value, /First scene prose\./)
    assert.match(selectedScenes[1].value, /Third scene summary\./)
    assert.deepEqual(items('scene', [{ kind: 'label', labelId: 'unmatched-label' }]), [])
    assert.deepEqual(items('act', [{ kind: 'label', labelId: 'unmatched-label' }]), [])
})

test('label content is available to both combined and typed prompt inputs', () => {
    const { items } = fixture()
    const selections: ContentSelectionTarget[] = [
        { kind: 'label', labelId: 'act-label' },
        { kind: 'label', labelId: 'scene-label' },
    ]
    const acts = items('act', selections)
    const scenes = items('scene', selections)
    const rendered = renderPromptTemplateMessages({
        texts: [
            '{{ inputs["references"].value }}',
            '{{ inputs["references"].act.value }}\n{{ inputs["references"].scene.value }}',
        ],
        context: {},
        resolvers: {
            resolveInput: () => [...acts, ...scenes].map((item) => item.value).join('\n\n'),
            resolveInclude: () => null,
            resolveInputActs: () => acts,
            resolveInputScenes: () => scenes,
        },
    })

    assert.deepEqual(rendered.warnings, [])
    for (const text of rendered.texts) {
        assert.match(text, /First scene prose\./)
        assert.match(text, /Second scene prose\./)
        assert.match(text, /Third scene prose\./)
        assert.doesNotMatch(text, /act-label|scene-label/)
    }
})
