/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('node:fs/promises')
const path = require('node:path')
const { z } = require('zod')
const { getTermStateEntries, assignUniqueTermFileNames, getTermCategoryLabel } = require('./novel-workspace-terms.cjs')

const CONTENT_SEARCH_KINDS = ['full_novel', 'act', 'chapter', 'scene', 'act_outline', 'chapter_outline', 'snippet', 'term', 'label', 'term_tag']
const searchInput = z.object({
    novelId: z.string().trim().min(1),
    query: z.string().trim().min(1),
    kinds: z.array(z.enum(CONTENT_SEARCH_KINDS)).min(1).optional(),
    match: z.enum(['contains', 'exact']).default('contains'),
    limit: z.number().int().min(1).max(100).default(20),
    offset: z.number().int().min(0).default(0),
}).strict()

const normalize = (value) => value.trim().toLowerCase()

async function searchContent({ prisma, ownerId, workspaceRoot }, args) {
    const input = searchInput.parse(args)
    const novel = await prisma.novel.findFirst({
        where: { id: input.novelId, ownerId },
        select: {
            id: true, title: true, language: true,
            acts: { select: { id: true, number: true, title: true } },
            chapters: { select: {
                id: true, title: true, actNumber: true, order: true,
                scenes: { select: { id: true, order: true } },
            } },
            outlines: { select: { id: true, type: true, actNumber: true, chapterId: true } },
            snippets: { select: { id: true, title: true } },
            labels: { select: { id: true, name: true } },
            termState: { select: { stateJson: true } },
        },
    })
    if (!novel) throw new Error('Novel not found.')

    const chinese = novel.language?.toLowerCase().startsWith('zh')
    const actName = (number) => chinese ? `第${number}卷` : `Act ${number}`
    const chapterName = (number) => chinese ? `第${number}章` : `Chapter ${number}`
    const sceneName = (number) => chinese ? `场景${number}` : `Scene ${number}`
    const outlineName = (kind) => kind === 'act'
        ? (chinese ? '卷纲' : 'Act outline')
        : (chinese ? '章纲' : 'Chapter outline')
    const acts = new Map(novel.acts.map((act) => [act.number, act]))
    const chapters = [...novel.chapters].sort((a, b) => a.actNumber - b.actNumber || a.order - b.order || a.id.localeCompare(b.id))
    const chapterById = new Map(chapters.map((chapter, index) => [chapter.id, { ...chapter, number: index + 1 }]))
    const actContext = (number) => ({ actNumber: number, actTitle: acts.get(number)?.title?.trim() || null })
    const chapterContext = (chapter) => ({
        ...actContext(chapter.actNumber), chapterId: chapter.id,
        chapterTitle: chapter.title, chapterNumber: chapter.number,
    })

    const query = normalize(input.query)
    const kinds = new Set(input.kinds ?? CONTENT_SEARCH_KINDS)
    const candidates = []
    function add({ kind, id, title, context = {}, target, file = null, anchor = null, names = [] }) {
        if (!kinds.has(kind)) return
        const ranks = [title, ...names].filter(Boolean).map((name) => {
            const key = normalize(name)
            if (key === query) return 0
            if (input.match === 'exact') return 3
            return key.startsWith(query) ? 1 : key.includes(query) ? 2 : 3
        })
        const rank = Math.min(...ranks)
        if (rank < 3) candidates.push({ kind, id, title, context, target, file, anchor, rank })
    }

    add({ kind: 'full_novel', id: novel.id, title: novel.title,
        names: [chinese ? '全书' : 'Full novel'], target: { kind: 'full_novel' },
        file: 'outline.md', anchor: `<!-- novel_id: ${novel.id} -->` })
    for (const act of novel.acts) {
        const title = act.title?.trim() || actName(act.number)
        add({ kind: 'act', id: act.id, title, context: actContext(act.number),
            names: [actName(act.number), `${actName(act.number)} · ${title}`],
            target: { kind: 'act', actNumber: act.number }, file: 'outline.md', anchor: `<!-- act_number: ${act.number} -->` })
    }
    for (const chapter of chapterById.values()) {
        const title = chapter.title.trim() || chapterName(chapter.number)
        const displayName = `${chapterName(chapter.number)} · ${title}`
        add({ kind: 'chapter', id: chapter.id, title, context: chapterContext(chapter),
            names: [chapterName(chapter.number), displayName], target: { kind: 'chapter', chapterId: chapter.id },
            file: `chapters/${chapter.id}.md`, anchor: `<!-- chapter_id: ${chapter.id} -->` })
        const scenes = [...chapter.scenes].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
        scenes.forEach((scene, index) => add({
            kind: 'scene', id: scene.id, title: `${title} · ${sceneName(index + 1)}`,
            context: { ...chapterContext(chapter), sceneNumber: index + 1 },
            names: [`${displayName} · ${sceneName(index + 1)}`],
            target: { kind: 'scene', sceneId: scene.id }, file: `chapters/${chapter.id}.md`, anchor: `<!-- scene_id: ${scene.id} -->`,
        }))
    }
    for (const outline of novel.outlines) {
        if (outline.type === 'ACT') {
            const act = acts.get(outline.actNumber)
            if (!act) continue
            const title = act.title?.trim() || actName(act.number)
            add({ kind: 'act_outline', id: outline.id, title: `${title} · ${outlineName('act')}`,
                names: [title, `${actName(act.number)} · ${outlineName('act')}`], context: actContext(act.number),
                target: { kind: 'act_outline', actNumber: act.number }, file: `DetailedOutline/acts/${act.number}.md`,
                anchor: `<!-- outline_id: ${outline.id} -->` })
        } else if (outline.type === 'CHAPTER') {
            const chapter = chapterById.get(outline.chapterId)
            if (!chapter) continue
            const title = chapter.title.trim() || chapterName(chapter.number)
            add({ kind: 'chapter_outline', id: outline.id, title: `${title} · ${outlineName('chapter')}`,
                names: [title, `${chapterName(chapter.number)} · ${outlineName('chapter')}`], context: chapterContext(chapter),
                target: { kind: 'chapter_outline', chapterId: chapter.id }, file: `DetailedOutline/chapters/${chapter.id}.md`,
                anchor: `<!-- outline_id: ${outline.id} -->` })
        }
    }
    for (const snippet of novel.snippets) add({
        kind: 'snippet', id: snippet.id, title: snippet.title.trim() || (chinese ? '未命名片段' : 'Untitled snippet'),
        target: { kind: 'snippet', snippetId: snippet.id }, file: `snippets/${snippet.id}.md`, anchor: `<!-- snippet_id: ${snippet.id} -->`,
    })
    for (const label of novel.labels) add({ kind: 'label', id: label.id, title: label.name, target: { kind: 'label', labelId: label.id } })

    const state = novel.termState?.stateJson ? JSON.parse(novel.termState.stateJson) : {}
    const terms = getTermStateEntries(state).filter((term) => term.archived !== true && typeof term.id === 'string' && term.id && typeof term.title === 'string' && term.title.trim())
    const fileNames = assignUniqueTermFileNames(terms)
    const tags = new Map()
    for (const term of terms) {
        add({ kind: 'term', id: term.id, title: term.title.trim(),
            context: { categoryId: term.categoryId, categoryLabel: getTermCategoryLabel(term.categoryId, novel.language, state) },
            target: { kind: 'term', termId: term.id }, file: `terms/${fileNames.get(term.id)}`, anchor: `<!-- term_id: ${term.id} -->` })
        for (const tag of Array.isArray(term.tags) ? term.tags : []) {
            if (typeof tag !== 'string' || !tag.trim()) continue
            const name = tag.trim()
            const key = normalize(name)
            if (!tags.has(key)) tags.set(key, name)
        }
    }
    for (const tag of tags.values()) add({ kind: 'term_tag', id: null, title: tag, target: { kind: 'term_tag', tag } })

    candidates.sort((a, b) => a.rank - b.rank || a.title.localeCompare(b.title) || a.kind.localeCompare(b.kind) || (a.id ?? '').localeCompare(b.id ?? ''))
    const page = candidates.slice(input.offset, input.offset + input.limit)
    const items = await Promise.all(page.map(async ({ file, anchor, kind, id, title, context, target }) => {
        let relativePath = null
        if (file) {
            try {
                if ((await fs.stat(path.join(workspaceRoot, novel.id, file))).isFile()) relativePath = `novel/${file}`
            } catch (error) {
                if (error.code !== 'ENOENT') throw error
            }
        }
        return { kind, id, title, context, target, relativePath, anchor: relativePath ? anchor : null }
    }))
    return { ok: true, items, hasMore: input.offset + items.length < candidates.length }
}

module.exports = { CONTENT_SEARCH_KINDS, searchContent }
