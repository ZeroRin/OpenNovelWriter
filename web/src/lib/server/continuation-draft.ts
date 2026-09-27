import { prisma } from '@/lib/db'
import { deleteCodexSession } from '@/lib/server/codex-session-deletion'

export type ContinuationDraftDto = {
    panelId: string
    novelId: string
    sceneId: string
    chapterId: string
    codexSessionId: string | null
    promptSnapshotJson: string | null
    content: string
    planning: string
    updatedBy: string
    updatedAt: string
}

type ContinuationDraftRecord = {
    panelId: string
    novelId: string
    sceneId: string
    chapterId: string
    codexSessionId: string | null
    promptSnapshotJson: string | null
    content: string
    planning: string
    updatedBy: string
    updatedAt: Date
}

export function serializeContinuationDraft(record: ContinuationDraftRecord): ContinuationDraftDto {
    return {
        panelId: record.panelId,
        novelId: record.novelId,
        sceneId: record.sceneId,
        chapterId: record.chapterId,
        codexSessionId: record.codexSessionId,
        promptSnapshotJson: record.promptSnapshotJson,
        content: record.content,
        planning: record.planning,
        updatedBy: record.updatedBy,
        updatedAt: record.updatedAt.toISOString(),
    }
}

/** Load a draft and verify its novel belongs to the owner. Returns null when missing or not owned. */
export async function getOwnedContinuationDraft(ownerId: string, panelId: string) {
    const draft = await prisma.sceneContinuationDraft.findUnique({ where: { panelId } })
    if (!draft) return null
    const novel = await prisma.novel.findFirst({ where: { id: draft.novelId, ownerId }, select: { id: true } })
    if (!novel) return null
    return draft
}

/** Delete a draft row only. Leaf operation; does not touch any linked session. */
export async function rawDeleteContinuationDraft(panelId: string) {
    await prisma.sceneContinuationDraft.deleteMany({ where: { panelId } })
}

/**
 * Deleting a scene or chapter removes the inline continuation panels living in it, so their
 * shared drafts and the paired Codex sessions must go too (the panel markers vanish with the
 * scene/chapter content). Call BEFORE deleting the scene(s). No marker strip is needed — the
 * surrounding HTML is being deleted anyway.
 */
export async function cascadeDeleteContinuationDraftsForScenes(ownerId: string, sceneIds: string[]) {
    if (sceneIds.length === 0) return []
    const drafts = await prisma.sceneContinuationDraft.findMany({
        where: { sceneId: { in: sceneIds } },
        select: { panelId: true, codexSessionId: true },
    })
    if (drafts.length === 0) return []
    const deletedSessionIds: string[] = []
    for (const draft of drafts) {
        if (!draft.codexSessionId) continue
        if (await deleteCodexSession(ownerId, draft.codexSessionId)) {
            deletedSessionIds.push(draft.codexSessionId)
        }
    }
    await prisma.sceneContinuationDraft.deleteMany({ where: { sceneId: { in: sceneIds } } })
    return deletedSessionIds
}
