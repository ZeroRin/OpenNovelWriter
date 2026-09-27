import fs from 'fs/promises'
import path from 'path'
import { randomUUID } from 'crypto'
import { prisma } from '@/lib/db'
import { continuationConversationMarkdown, type ContinuationPromptSnapshot } from '@/lib/continuation-prompt'
import { ensureCodexSessionWorkspace } from '@/lib/server/codex-session-workspace'

export async function prepareContinuationHandoff(input: { ownerId: string; sessionId: string; novelId: string; panelId: string }) {
    const draft = await prisma.sceneContinuationDraft.findFirst({
        where: { panelId: input.panelId, codexSessionId: input.sessionId, novelId: input.novelId, novel: { ownerId: input.ownerId } },
    })
    if (!draft?.promptSnapshotJson) throw new Error('The continuation panel has no prompt snapshot. Open the panel and hand it to Codex again.')
    const snapshot = JSON.parse(draft.promptSnapshotJson) as ContinuationPromptSnapshot
    const groups = await prisma.aiModelGroup.findMany({ where: { ownerId: input.ownerId, id: { in: snapshot.modelGroupIds } }, select: { id: true, name: true } })
    const messages = [...snapshot.messages]
    if (draft.content.trim() || draft.planning.trim()) messages.push({ role: 'assistant', content: [draft.planning ? `<Planning>\n${draft.planning}\n</Planning>` : '', `<Content>\n${draft.content}\n</Content>`].filter(Boolean).join('\n\n') })
    const stem = `continuation-${randomUUID()}`
    const fileNames = [`${stem}.md`, `${stem}.json`]
    const workspace = await ensureCodexSessionWorkspace({ ownerId: input.ownerId, novelId: input.novelId, sessionId: input.sessionId })
    const artifacts = path.join(workspace, 'artifacts')
    await fs.mkdir(artifacts, { recursive: true })
    await fs.writeFile(path.join(artifacts, fileNames[0]), continuationConversationMarkdown(messages), { flag: 'wx' })
    await fs.writeFile(path.join(artifacts, fileNames[1]), JSON.stringify({
        panelId: draft.panelId, novelId: draft.novelId, chapterId: draft.chapterId, sceneId: draft.sceneId,
        ...snapshot,
        groups: snapshot.modelGroupIds.flatMap((id) => groups.filter((group) => group.id === id)),
        draft: { content: draft.content, planning: draft.planning, updatedAt: draft.updatedAt },
    }, null, 2) + '\n', { flag: 'wx' })
    return {
        fileNames,
        instruction: `Continuation panel attachment: panelId=${draft.panelId}, chapterId=${draft.chapterId}, sceneId=${draft.sceneId}. artifacts/${fileNames[0]} contains the assembled writing conversation; artifacts/${fileNames[1]} contains its input snapshot, missingInputs and bound model groups. Reuse these files in later turns. get_continuation_draft exports the latest panel draft to an editable Markdown file; set_continuation_draft reads an assistant reply from source: { mdPath }. The author decides when to insert the draft into the manuscript.`,
    }
}
