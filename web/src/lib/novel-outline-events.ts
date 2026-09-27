export const NOVEL_OUTLINE_DATA_CHANGED_EVENT = 'onw:novel-outline-data-changed'

export type NovelOutlineDataChangedDetail = {
    novelId: string
}

// Refreshes derived previews after changes to titles, summaries, or detailed outlines.
export function dispatchNovelOutlineDataChanged(detail: NovelOutlineDataChangedDetail) {
    if (typeof window === 'undefined') return
    window.dispatchEvent(new CustomEvent<NovelOutlineDataChangedDetail>(NOVEL_OUTLINE_DATA_CHANGED_EVENT, { detail }))
}
