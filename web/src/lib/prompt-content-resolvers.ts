import { getContentSelectionTemplateItems, type ContentSelectionTemplateResources, type ContentSelectionTemplateCollectionKind } from '@/lib/content-selection-template'
import type { ContentSelectionTarget, PromptContentSelectionInputDefinition } from '@/lib/prompt-inputs'
import type { PromptTemplateRenderResolvers } from '@/lib/prompt-template-render'
import type { TermEntry } from '@/components/editor/terms/types'
import { htmlToText } from '@/lib/html-to-text'
import { resolveTrackedTermIds } from '@/lib/term-template'

export function createPromptContentResolvers(params: {
    getInput: (name: string) => { input: PromptContentSelectionInputDefinition; selections: ContentSelectionTarget[] } | null
    resources: ContentSelectionTemplateResources
    termsById: Map<string, TermEntry>
    snippets: Array<{ id: string; title: string; content: string }>
    resolveTermValue: (termId: string) => string | null | undefined
    locale?: string | null
}) {
    const selections = (name: string) => params.getInput(name)?.selections ?? []
    const items = (name: string, kind: ContentSelectionTemplateCollectionKind) => {
        const selected = params.getInput(name)
        return selected ? getContentSelectionTemplateItems({ ...selected, kind, resources: params.resources, locale: params.locale }) : []
    }
    const resolvers = {
        applyTermPolicy: (termIds: string[]) => resolveTrackedTermIds({ mentionedTermIds: termIds, termsById: params.termsById }),
        resolveInputTermIds: (name: string) => [...new Set(selections(name).flatMap((ref) => {
            if (ref.kind !== 'term') return []
            const entry = params.termsById.get(ref.termId)
            return entry && !entry.archived ? [entry.id] : []
        }))],
        resolveInputTermTagTermIds: (name: string) => [...new Set(selections(name).flatMap((ref) => ref.kind === 'term_tag'
            ? [...params.termsById.values()].filter((term) => !term.archived && term.tags?.some((tag) => tag.trim().toLocaleLowerCase() === ref.tag.trim().toLocaleLowerCase()))
                .sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' })).map((term) => term.id)
            : []))],
        resolveInputSnippets: (name: string) => [...new Set(selections(name).flatMap((ref) => ref.kind === 'snippet' ? [ref.snippetId] : []))].flatMap((id) => {
            const snippet = params.snippets.find((item) => item.id === id)
            if (!snippet) return []
            const value = htmlToText(snippet.content, { paragraphSeparator: '\n' }).trim()
            const text = snippet.title.trim() || value.split('\n')[0]?.trim() || ''
            return text || value ? [{ key: `snippet:${id}`, text, value }] : []
        }),
        resolveInputFullNovels: (name: string) => items(name, 'fullNovel'),
        resolveInputActs: (name: string) => items(name, 'act'),
        resolveInputChapters: (name: string) => items(name, 'chapter'),
        resolveInputScenes: (name: string) => items(name, 'scene'),
        resolveInputActOutlines: (name: string) => items(name, 'actOutline'),
        resolveInputChapterOutlines: (name: string) => items(name, 'chapterOutline'),
    } satisfies Partial<PromptTemplateRenderResolvers>
    const resolveValue = (name: string) => {
        const parts = (['fullNovel', 'act', 'chapter', 'scene', 'actOutline', 'chapterOutline'] as const)
            .flatMap((kind) => items(name, kind).map((item) => item.value)).filter(Boolean)
        for (const ref of selections(name)) {
            if (ref.kind === 'snippet') {
                const snippet = params.snippets.find((item) => item.id === ref.snippetId)
                if (snippet) parts.push(htmlToText(snippet.content, { paragraphSeparator: '\n' }).trim())
            }
        }
        if (selections(name).some((ref) => ref.kind === 'term' || ref.kind === 'term_tag')) {
            const ids = resolvers.applyTermPolicy([...resolvers.resolveInputTermIds(name), ...resolvers.resolveInputTermTagTermIds(name)])
            for (const id of ids) {
                const value = params.resolveTermValue(id)?.trim()
                if (value) parts.push(value)
            }
        }
        return parts.filter(Boolean).join('\n\n').trim()
    }
    return { resolvers, resolveValue }
}
