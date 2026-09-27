import { prepareContinuationHandoff } from '@/lib/server/continuation-handoff'
import { appendCodexArtifactReferences, parseCodexArtifactFiles } from '@/lib/codex-artifacts'
import { registerLiveCodexMessages } from '@/lib/server/codex-live-messages'
import { projectCodexRunEvent } from '@/lib/server/codex-message-projection'
import type { CodexWorkMetadata } from '@/lib/codex-work-events'
import fs from 'fs/promises'
import path from 'path'

import { NextRequest, NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { normalizeManagedAttachmentUrls } from '@/lib/server/storage'
import { getPrismaClient } from '@/lib/db'
import {
    finishActiveCodexRun,
    isCodexRunInterruptedError,
    reserveActiveCodexRun,
    runNovelCodexTurn,
} from '@/lib/server/codex-app-server'
import {
    CodexSkillUnavailableError,
    resolveCodexSessionSkillReferences,
    rewriteCodexSkillReferences,
    type CodexSkillReference,
} from '@/lib/server/codex-session-skills'
import { getNovelWorkspaceTermFileMap } from '@/lib/server/novel-workspace'
import { getCodexSessionWorkspacePath } from '@/lib/server/codex-session-workspace'
import {
    normalizeCodexResponseAnnotations,
    prependCodexResponseAnnotations,
    type CodexResponseAnnotation,
} from '@/lib/codex-response-annotations'
import {
    type CodexContextWindow,
    createCodexMessageId,
    createCodexSessionTitle,
    normalizeCodexString,
    normalizeCodexStringId,
    normalizeCodexComposerMode,
    parseCodexThreadGoal,
    parseCodexSessionMessages,
    serializeCodexSession,
    type CodexSessionMessage,
} from '@/lib/server/codex-session'

interface RouteContext {
    params: Promise<unknown>
}

const prisma = getPrismaClient({ ensureModel: 'codexSession' })
const encoder = new TextEncoder()

async function getRouteId(params: Promise<unknown>) {
    const resolved = await params
    return typeof resolved === 'object' && resolved !== null && typeof (resolved as { id?: unknown }).id === 'string'
        ? (resolved as { id: string }).id
        : ''
}

function imageArtifactInstruction(label: string, target: string) {
    const hashIndex = target.lastIndexOf('#')
    const rawPath = (hashIndex >= 0 ? target.slice(0, hashIndex) : target).replace(/\\/g, '/')
    const itemId = hashIndex >= 0 ? target.slice(hashIndex + 1).trim() : ''
    const normalized = path.posix.normalize(rawPath.trim())
    if (
        !normalized ||
        normalized === '.' ||
        normalized === '..' ||
        normalized.startsWith('../') ||
        normalized.startsWith('/') ||
        path.posix.extname(normalized).toLowerCase() !== '.json'
    ) {
        return label
    }
    return itemId
        ? `${label} (image artifact — read artifacts/${normalized}, select item id ${itemId}, and use that item's file when the request needs the image)`
        : `${label} (image artifact gallery — read artifacts/${normalized} and use the relevant item files when the request needs these images)`
}

function encodeSse(event: string, data: unknown) {
    return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

type CodexRouteRunEvent = CodexWorkMetadata & {
    id: string
    kind: string
    title: string
    content: string
    attachments?: string[]
    jsonArtifacts?: string[]
    responseAnnotations?: CodexResponseAnnotation[]
    createdAt: string
}

function appendAssistantDeltaMessage(messages: CodexSessionMessage[], delta: string, id: string, createdAt: string) {
    const existing = messages.find((message) => message.id === id)
    if (existing) {
        existing.content += delta
        return
    }

    messages.push({
        id,
        role: 'assistant',
        content: delta,
        createdAt,
    })
}

function upsertPlanDeltaMessage(messages: CodexSessionMessage[], event: { id: string; delta: string; createdAt: string }) {
    const existing = messages.find((message) => message.id === event.id)
    if (existing) {
        const existingContent = existing.content.split(/\n\n/u).slice(1).join('\n\n')
        existing.content = ['Proposed Plan', `${existingContent}${event.delta}`].join('\n\n')
        return
    }

    messages.push({
        id: event.id,
        role: 'event',
        kind: 'plan',
        content: ['Proposed Plan', event.delta].join('\n\n'),
        createdAt: event.createdAt,
    })
}

function upsertEventMessage(messages: CodexSessionMessage[], event: CodexRouteRunEvent) {
    const message: CodexSessionMessage = {
        id: event.id,
        role: 'event',
        kind: event.kind,
        workStatus: event.workStatus,
        toolInput: event.toolInput,
        subagent: event.subagent,
        content: [event.title, event.content].filter(Boolean).join('\n\n'),
        attachments: event.attachments ?? [],
        jsonArtifacts: event.jsonArtifacts,
        ...(event.responseAnnotations?.length ? { responseAnnotations: event.responseAnnotations } : {}),
        createdAt: event.createdAt,
    }
    const index = messages.findIndex((item) => item.id === event.id)
    if (index >= 0) {
        messages[index] = message
    } else {
        messages.push(message)
    }
}

function attachContextWindowToLastAssistant(messages: CodexSessionMessage[], contextWindow: CodexContextWindow | null) {
    if (!contextWindow) return
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index]
        if (message?.role === 'assistant') {
            messages[index] = { ...message, contextWindow }
            return
        }
    }
}

export async function POST(request: NextRequest, { params }: RouteContext) {
    const user = await getCurrentUser(request)
    if (!user) return NextResponse.json({ detail: 'Not authenticated' }, { status: 401 })

    const id = await getRouteId(params)
    const existing = await prisma.codexSession.findFirst({
        where: { id, ownerId: user.userId },
    })
    if (!existing) return NextResponse.json({ detail: 'Codex session not found' }, { status: 404 })
    if (
        existing.category !== 'general' &&
        existing.category !== 'scene_operation' &&
        existing.category !== 'scene_continuation'
    ) {
        return NextResponse.json({ detail: 'This Codex session category is not runnable yet.' }, { status: 400 })
    }
    const body = await request.json().catch(() => null)
    const resumeGoal = body?.resumeGoal === true
    const messageId = normalizeCodexStringId(body?.messageId)
    const content = normalizeCodexString(body?.content).trim()
    const attachments = normalizeManagedAttachmentUrls(body?.attachments)
    const responseAnnotations = normalizeCodexResponseAnnotations(body?.responseAnnotations)
    let artifactFiles: string[]
    try {
        artifactFiles = parseCodexArtifactFiles(body?.artifactFiles)
    } catch (error) {
        return NextResponse.json({ detail: (error as Error).message }, { status: 400 })
    }
    const currentGoal = parseCodexThreadGoal(existing.goalJson)
    if (resumeGoal && (!existing.codexThreadId || !currentGoal || currentGoal.status === 'complete')) {
        return NextResponse.json({ detail: 'This session has no paused goal to resume.' }, { status: 409 })
    }
    if (!resumeGoal && !content && ((attachments.length === 0 && artifactFiles.length === 0 && responseAnnotations.length === 0) || existing.composerMode === 'goal')) {
        return NextResponse.json({ detail: 'Message content is required.' }, { status: 400 })
    }
    if (!resumeGoal && !messageId) {
        return NextResponse.json({ detail: 'Message id is required.' }, { status: 400 })
    }
    if (!resumeGoal && existing.composerMode === 'goal' && currentGoal === null && content.length > 4000) {
        return NextResponse.json({ detail: 'Goal objective must contain at most 4,000 characters.' }, { status: 400 })
    }

    let skillRefs: CodexSkillReference[]
    try {
        skillRefs = await resolveCodexSessionSkillReferences({
            ownerId: user.userId, sessionCategory: existing.category, content, skillIds: body?.skillIds,
        })
    } catch (error) {
        if (error instanceof CodexSkillUnavailableError) {
            return NextResponse.json({ detail: error.message }, { status: 400 })
        }
        throw error
    }

    const activeRun = reserveActiveCodexRun(id)
    if (!activeRun) {
        return NextResponse.json({ detail: 'Codex session is already running.' }, { status: 409 })
    }
    let claimResult: { count: number }
    try {
        claimResult = await prisma.codexSession.updateMany({
            where: existing.status === 'running'
                ? { id, ownerId: user.userId, status: 'running', updatedAt: existing.updatedAt }
                : { id, ownerId: user.userId, status: existing.status },
            data: {
                status: 'running',
                lastError: null,
                unreadCompletionAt: null,
                updatedAt: new Date(),
            },
        })
    } catch (error) {
        finishActiveCodexRun(activeRun)
        throw error
    }
    if (claimResult.count !== 1) {
        finishActiveCodexRun(activeRun)
        return NextResponse.json({ detail: 'Codex session is already running.' }, { status: 409 })
    }

    let claimReleased = false
    const releaseClaim = async () => {
        if (claimReleased) return
        claimReleased = true
        try {
            await prisma.codexSession.updateMany({
                where: { id, ownerId: user.userId, status: 'running' },
                data: {
                    status: existing.status === 'running' ? 'idle' : existing.status,
                    lastError: existing.status === 'running' ? null : existing.lastError,
                    unreadCompletionAt: existing.unreadCompletionAt,
                    updatedAt: new Date(),
                },
            })
        } finally {
            finishActiveCodexRun(activeRun)
        }
    }

    try {
        const artifactsPath = path.join(getCodexSessionWorkspacePath(user.userId, existing.id), 'artifacts')
        for (const fileName of artifactFiles) {
            const filePath = path.join(artifactsPath, fileName)
            const stat = await fs.lstat(filePath).catch(() => null)
            if (!stat?.isFile() || stat.isSymbolicLink()) {
                await releaseClaim()
                return NextResponse.json({ detail: `Artifact ${fileName} was not found in this session.` }, { status: 400 })
            }
        }

        // Term mentions `[title](term:TERM_ID)` point Codex at the read-only Markdown file the term is
        // projected to under `novel/terms/`. Resolve each id to its (collision-free) file name so the
        // rewritten instruction names an exact path Codex can open.
        const contentTermIds: string[] = []
        for (const match of content.matchAll(/\[[^\]]+\]\(term:([^)]+)\)/g)) {
            if (match[1]) contentTermIds.push(match[1])
        }
        const termFileById = contentTermIds.length > 0
            ? await getNovelWorkspaceTermFileMap(user.userId, existing.novelId)
            : new Map<string, { title: string; fileName: string }>()

        // Detailed-outline (细纲) mentions are offered for every chapter/act that has an outline ROW,
        // including ones the author created but left blank. Only non-blank outlines are projected to a
        // file, so look up which referenced outlines are empty and word those as a write target instead
        // of a (dangling) read instruction.
        const refOutlineChapterIds: string[] = []
        for (const match of content.matchAll(/\[[^\]]+\]\(outlineChapter:([^)]+)\)/g)) {
            if (match[1]) refOutlineChapterIds.push(match[1])
        }
        const refOutlineActNumbers: number[] = []
        for (const match of content.matchAll(/\[[^\]]+\]\(outlineAct:([^)]+)\)/g)) {
            const parsed = Number.parseInt(match[1] ?? '', 10)
            if (Number.isInteger(parsed)) refOutlineActNumbers.push(parsed)
        }
        const emptyOutlineChapterIds = new Set<string>()
        const emptyOutlineActNumbers = new Set<number>()
        if (refOutlineChapterIds.length > 0 || refOutlineActNumbers.length > 0) {
            const rows = await prisma.outline.findMany({
                where: {
                    novelId: existing.novelId,
                    OR: [
                        { chapterId: { in: refOutlineChapterIds } },
                        { type: 'ACT', actNumber: { in: refOutlineActNumbers } },
                    ],
                },
                select: { chapterId: true, actNumber: true, type: true, wordCount: true },
            })
            const wordCountByChapterId = new Map<string, number>()
            const wordCountByActNumber = new Map<number, number>()
            for (const row of rows) {
                if (row.type === 'CHAPTER' && row.chapterId) wordCountByChapterId.set(row.chapterId, row.wordCount)
                else if (row.type === 'ACT' && row.actNumber != null) wordCountByActNumber.set(row.actNumber, row.wordCount)
            }
            // A referenced outline counts as empty when its row has no words or no longer exists.
            for (const id of refOutlineChapterIds) if ((wordCountByChapterId.get(id) ?? 0) <= 0) emptyOutlineChapterIds.add(id)
            for (const num of refOutlineActNumbers) if ((wordCountByActNumber.get(num) ?? 0) <= 0) emptyOutlineActNumbers.add(num)
        }

        const promptText = rewriteCodexSkillReferences(content, skillRefs)
            // A continuation panel reference becomes an explicit instruction carrying the panelId,
            // which Codex passes to get_continuation_draft / set_continuation_draft to write the result.
            .replace(
                /\[([^\]]+)\]\(continuation:([^:)]+):([^:)]+):([^)]+)\)/g,
                (_full, label: string, chapterId: string, sceneId: string, panelId: string) =>
                    `${label} (scene-continuation panel — write your result here with set_continuation_draft: panelId=${panelId}, chapterId=${chapterId}, sceneId=${sceneId})`
            )
            // A term reference becomes an explicit instruction to read that term's projected file.
            .replace(/\[([^\]]+)\]\(term:([^)]+)\)/g, (_full, label: string, termId: string) => {
                const entry = termFileById.get(termId)
                return entry
                    ? `${label} (term — read its full details in novel/terms/${entry.fileName} before responding)`
                    : label
            })
            // A snippet reference points Codex at the snippet's projected file (keyed by id).
            .replace(
                /\[([^\]]+)\]\(snippet:([^)]+)\)/g,
                (_full, label: string, snippetId: string) =>
                    `${label} (snippet — read its full content in novel/snippets/${snippetId}.md before responding)`
            )
            // A material reference points Codex at the imported document's projected file (keyed by id).
            // Materials can be large, so this @-mention is the only signal to open one — Codex otherwise
            // leaves novel/materials/ alone (see AGENTS.md).
            .replace(
                /\[([^\]]+)\]\(material:([^)]+)\)/g,
                (_full, label: string, materialId: string) =>
                    `${label} (material — read its full content in novel/materials/${materialId}.md before responding)`
            )
            .replace(
                /\[([^\]]+)\]\(image:([^)]+)\)/g,
                (_full, label: string, target: string) => imageArtifactInstruction(label, target)
            )
            // A chapter detailed-outline (章纲) reference: read the projected file when it has content,
            // otherwise tell Codex the slot exists but is empty (a write target). Must run before the bare
            // `chapter:` rewrite — it is a longer, more specific token, but they are textually distinct.
            .replace(
                /\[([^\]]+)\]\(outlineChapter:([^)]+)\)/g,
                (_full, label: string, chapterId: string) =>
                    emptyOutlineChapterIds.has(chapterId)
                        ? `${label} (章纲 — this chapter's detailed outline exists but is currently empty; if the author asks you to write it, save it with edit_outline (chapterId=${chapterId}))`
                        : `${label} (章纲 — read this chapter's detailed outline in novel/DetailedOutline/chapters/${chapterId}.md before responding)`
            )
            // A volume detailed-outline (卷纲) reference, keyed by act number — same empty-vs-content split.
            .replace(
                /\[([^\]]+)\]\(outlineAct:([^)]+)\)/g,
                (_full, label: string, actNumber: string) =>
                    emptyOutlineActNumbers.has(Number(actNumber))
                        ? `${label} (卷纲 — this volume's detailed outline exists but is currently empty; if the author asks you to write it, save it with edit_outline (actNumber=${actNumber}))`
                        : `${label} (卷纲 — read this volume's detailed outline in novel/DetailedOutline/acts/${actNumber}.md before responding)`
            )
            // A chapter reference points Codex at that chapter's projected file (keyed by chapter id).
            .replace(
                /\[([^\]]+)\]\(chapter:([^)]+)\)/g,
                (_full, label: string, chapterId: string) =>
                    `${label} (章 — read this chapter's full content in novel/chapters/${chapterId}.md before responding)`
            )
            // A volume (act) has no single file — point Codex at the volume's section in the outline,
            // where it can read the per-chapter summaries and open the chapter files it actually needs.
            .replace(
                /\[([^\]]+)\]\(act:([^)]+)\)/g,
                (_full, label: string, actNumber: string) =>
                    `${label} (卷 — read the section marked \`<!-- act_number: ${actNumber} -->\` in novel/outline.md for this volume's chapter structure and summaries, then open the relevant novel/chapters/<id>.md when you need the prose, before responding)`
            )

        const currentMessages = parseCodexSessionMessages(existing.messagesJson)
        const handoff = existing.continuationPanelId && !resumeGoal && !currentMessages.some((message) => message.role === 'user') ? await prepareContinuationHandoff({
            ownerId: user.userId, sessionId: id, novelId: existing.novelId,
            panelId: existing.continuationPanelId,
        }) : null
        if (handoff) artifactFiles.push(...handoff.fileNames)
        let finalPromptText = appendCodexArtifactReferences([promptText, handoff?.instruction].filter(Boolean).join('\n\n'), artifactFiles)
        finalPromptText = prependCodexResponseAnnotations(finalPromptText, responseAnnotations)

        const now = new Date()
        const startedAt = now.toISOString()
        const sentAsGoal = !resumeGoal && existing.composerMode === 'goal' && currentGoal === null
        const userMessage: CodexSessionMessage = {
            id: messageId!,
            role: 'user',
            content,
            attachments,
            jsonArtifacts: artifactFiles,
            ...(responseAnnotations.length ? { responseAnnotations } : {}),
            ...(sentAsGoal ? { sentAsGoal: true } : {}),
            createdAt: startedAt,
        }
        const optimisticMessages = resumeGoal ? currentMessages : [...currentMessages, userMessage]
        const title = existing.titleManuallyEdited ? existing.title : createCodexSessionTitle(optimisticMessages)

        await prisma.codexSession.update({
            where: { id },
            data: {
                messagesJson: JSON.stringify(optimisticMessages),
                ...(resumeGoal ? {} : {
                    draftContent: '',
                    draftAttachmentsJson: '[]',
                    draftArtifactsJson: '[]',
                }),
                status: 'running',
                lastError: null,
                unreadCompletionAt: null,
                title,
                updatedAt: now,
            },
        })

        const runInput = {
            activeRun,
            sessionId: existing.id,
            ownerId: user.userId,
            novelId: existing.novelId,
            codexThreadId: existing.codexThreadId,
            codexConnectionId: existing.codexConnectionId,
            reviewLevel: existing.reviewLevel,
            modelId: existing.modelId,
            reasoningEffort: existing.reasoningEffort,
            serviceTier: existing.serviceTier,
            composerMode: normalizeCodexComposerMode(existing.composerMode) ?? 'default',
            currentGoal,
            goalObjective: sentAsGoal ? content : null,
            resumeGoal,
            prompt: resumeGoal ? undefined : finalPromptText,
            imageUrls: attachments,
            skillRefs,
        }

        const streamState = { closed: false }
        const bodyStream = new ReadableStream<Uint8Array>({
            async start(controller) {
                const send = (event: string, data: unknown) => {
                    if (streamState.closed) return
                    try {
                        controller.enqueue(encodeSse(event, data))
                    } catch {
                        streamState.closed = true
                    }
                }
                const close = () => {
                    if (streamState.closed) return
                    streamState.closed = true
                    try {
                        controller.close()
                    } catch {
                        return
                    }
                }
                const streamedMessages = [...optimisticMessages]
                const releaseLiveMessages = registerLiveCodexMessages(id, streamedMessages)
                let goalPersistence = Promise.resolve()
                let turnPersistence = Promise.resolve()
                let contextWindow: CodexContextWindow | null = null

                try {
                    const result = await runNovelCodexTurn({
                        ...runInput,
                        stream: {
                            onTurnCompleted: () => {
                                const messagesJson = JSON.stringify(streamedMessages)
                                turnPersistence = turnPersistence.then(async () => {
                                    await prisma.codexSession.updateMany({
                                        where: { id, ownerId: user.userId, status: 'running' },
                                        data: { messagesJson, updatedAt: new Date() },
                                    })
                                })
                            },
                            onAssistantDelta: (event) => {
                                appendAssistantDeltaMessage(streamedMessages, event.delta, event.id, event.createdAt)
                                send('assistant_delta', event)
                            },
                            onAssistantNotification: (notification) => {
                                appendAssistantDeltaMessage(
                                    streamedMessages,
                                    notification.content,
                                    notification.id,
                                    notification.createdAt
                                )
                                send('assistant_delta', {
                                    id: notification.id,
                                    delta: notification.content,
                                    createdAt: notification.createdAt,
                                })
                            },
                            onReasoningDelta: (event) => {
                                const existing = streamedMessages.find((message) => message.id === event.id)
                                if (existing) {
                                    existing.content += event.delta
                                } else {
                                    streamedMessages.push({ id: event.id, role: 'event', kind: 'reasoning', workStatus: 'running', content: event.delta, createdAt: event.createdAt })
                                }
                                send('reasoning_delta', event)
                            },
                            onPlanDelta: (event) => {
                                upsertPlanDeltaMessage(streamedMessages, event)
                                send('plan_delta', event)
                            },
                            onEvent: (event) => {
                                upsertEventMessage(streamedMessages, event)
                                send('event', projectCodexRunEvent(event))
                            },
                            onApprovalRequest: (approval) => {
                                send('approval_request', { approval })
                            },
                            onUserInputRequest: (request) => {
                                send('user_input_request', { request })
                            },
                            onUserInputResolved: (id) => {
                                send('user_input_resolved', { id })
                            },
                            onContextWindow: (nextContextWindow) => {
                                contextWindow = nextContextWindow
                                attachContextWindowToLastAssistant(streamedMessages, nextContextWindow)
                                send('context_window', { contextWindow: nextContextWindow })
                            },
                            onRateLimits: (rateLimits, connectionId) => {
                                send('rate_limits', { rateLimits, connectionId })
                            },
                            onGoalUpdated: (goal) => {
                                send('goal_updated', { goal })
                                goalPersistence = goalPersistence.then(async () => {
                                    await prisma.codexSession.updateMany({
                                        where: { id, ownerId: user.userId },
                                        data: {
                                            codexThreadId: goal.threadId,
                                            goalJson: JSON.stringify(goal),
                                            updatedAt: new Date(),
                                        },
                                    })
                                })
                            },
                            onGoalCleared: () => {
                                send('goal_cleared', {})
                                goalPersistence = goalPersistence.then(async () => {
                                    await prisma.codexSession.updateMany({
                                        where: { id, ownerId: user.userId },
                                        data: { composerMode: 'default', goalJson: null, updatedAt: new Date() },
                                    })
                                })
                            },
                        },
                    })
                    await Promise.all([goalPersistence, turnPersistence])
                    contextWindow = result.contextWindow ?? contextWindow

                    for (const message of result.assistantMessages) {
                        const index = streamedMessages.findIndex((existing) => existing.id === message.id)
                        if (index < 0) streamedMessages.push({ ...message, role: 'assistant' })
                        else streamedMessages[index] = { ...streamedMessages[index], ...message }
                    }
                    const turnAssistantMessages = streamedMessages
                        .slice(optimisticMessages.length)
                        .filter((message) => message.role === 'assistant')
                    if (
                        result.status === 'completed' &&
                        turnAssistantMessages.length === 0 &&
                        !result.goalCleared &&
                        result.goal?.status !== 'active' &&
                        result.goal?.status !== 'paused'
                    ) {
                        streamedMessages.push({
                            id: createCodexMessageId('codex_assistant'),
                            role: 'assistant',
                            content: 'Codex finished without a text response.',
                            createdAt: new Date().toISOString(),
                        })
                    }
                    attachContextWindowToLastAssistant(streamedMessages, contextWindow)
                    const completedAt = new Date()
                    const nextComposerMode = existing.composerMode === 'goal' && !result.goal
                        ? 'default'
                        : existing.composerMode
                    const session = await prisma.codexSession.update({
                        where: { id },
                        data: {
                            codexThreadId: result.threadId,
                            codexConnectionId: result.connectionId,
                            composerMode: nextComposerMode,
                            goalJson: result.goal ? JSON.stringify(result.goal) : null,
                            messagesJson: JSON.stringify(streamedMessages),
                            status: 'idle',
                            lastError: null,
                            unreadCompletionAt: result.status === 'completed' && result.goal?.status !== 'paused' ? completedAt : null,
                            updatedAt: completedAt,
                        },
                    })

                    send('done', { session: serializeCodexSession(session) })
                } catch (error) {
                    await Promise.allSettled([goalPersistence, turnPersistence])
                    if (isCodexRunInterruptedError(error)) {
                        const session = await prisma.codexSession.update({
                            where: { id },
                            data: {
                                messagesJson: JSON.stringify(streamedMessages),
                                status: 'idle',
                                lastError: null,
                                unreadCompletionAt: null,
                                updatedAt: new Date(),
                            },
                        })
                        send('done', { session: serializeCodexSession(session) })
                        return
                    }
                    const message = error instanceof Error ? error.message : 'Codex run failed.'
                    const failedAt = new Date()
                    const failedMessages: CodexSessionMessage[] = [
                        ...streamedMessages,
                        {
                            id: createCodexMessageId('codex_error'),
                            role: 'event',
                            kind: 'error',
                            content: message,
                            createdAt: failedAt.toISOString(),
                        },
                    ]
                    const session = await prisma.codexSession.update({
                        where: { id },
                        data: {
                            messagesJson: JSON.stringify(failedMessages),
                            status: 'error',
                            lastError: message,
                            unreadCompletionAt: failedAt,
                            updatedAt: failedAt,
                        },
                    })

                    send('error', { session: serializeCodexSession(session), detail: message })
                } finally {
                    releaseLiveMessages()
                    finishActiveCodexRun(activeRun)
                    close()
                }
            },
            cancel() {
                streamState.closed = true
            },
        })

        return new Response(bodyStream, {
            status: 200,
            headers: {
                'Content-Type': 'text/event-stream; charset=utf-8',
                'Cache-Control': 'no-cache, no-transform',
                Connection: 'keep-alive',
            },
        })
    } catch (error) {
        await releaseClaim()
        throw error
    }
}
