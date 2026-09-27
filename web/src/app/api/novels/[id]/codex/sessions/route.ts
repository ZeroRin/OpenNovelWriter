import { NextRequest, NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { getPrismaClient } from '@/lib/db'
import {
    DEFAULT_CODEX_REVIEW_LEVEL,
    DEFAULT_CODEX_SERVICE_TIER,
    normalizeCodexComposerMode,
    normalizeCodexReviewLevel,
    normalizeCodexReasoningEffort,
    normalizeCodexServiceTier,
    normalizeCodexSessionCategory,
    normalizeCodexString,
    normalizeCodexStringId,
    parseCodexDraftArtifacts,
    parseCodexDraftAttachments,
    serializeCodexSession,
    serializeCodexSessionSummary,
} from '@/lib/server/codex-session'
import { getNewCodexSessionModelSettings, isCodexFastModeAllowed } from '@/lib/codex-config'
import { getActiveCodexRun } from '@/lib/server/codex-app-server'
import { pruneCodexSessionsForCategory } from '@/lib/server/codex-session-pruning'

interface RouteContext {
    params: Promise<unknown>
}

const prisma = getPrismaClient({ ensureModel: 'codexSession' })

async function getRouteId(params: Promise<unknown>) {
    const resolved = await params
    return typeof resolved === 'object' && resolved !== null && typeof (resolved as { id?: unknown }).id === 'string'
        ? (resolved as { id: string }).id
        : ''
}

export async function GET(request: NextRequest, { params }: RouteContext) {
    try {
        const user = await getCurrentUser(request)
        if (!user) return NextResponse.json({ detail: 'Not authenticated' }, { status: 401 })

        const novelId = await getRouteId(params)
        const novel = await prisma.novel.findFirst({
            where: { id: novelId, ownerId: user.userId },
            select: { id: true },
        })
        if (!novel) return NextResponse.json({ detail: 'Novel not found' }, { status: 404 })

        let sessions = await prisma.codexSession.findMany({
            where: { novelId, ownerId: user.userId },
            orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }],
        })

        const staleSessionIds = sessions
            .filter((session) => session.status === 'running' && !getActiveCodexRun(session.id))
            .map((session) => session.id)
        if (staleSessionIds.length > 0) {
            await prisma.codexSession.updateMany({
                where: {
                    id: { in: staleSessionIds },
                    novelId,
                    ownerId: user.userId,
                    status: 'running',
                },
                data: {
                    status: 'idle',
                    lastError: null,
                    unreadCompletionAt: null,
                },
            })
            const staleSessionIdSet = new Set(staleSessionIds)
            sessions = sessions.map((session) =>
                staleSessionIdSet.has(session.id)
                    ? { ...session, status: 'idle', lastError: null, unreadCompletionAt: null }
                    : session
            )
        }

        return NextResponse.json({ sessions: sessions.map((session) => serializeCodexSessionSummary(session)) })
    } catch (error) {
        console.error('List Codex sessions error:', error)
        return NextResponse.json({ detail: 'Internal server error' }, { status: 500 })
    }
}

export async function POST(request: NextRequest, { params }: RouteContext) {
    try {
        const user = await getCurrentUser(request)
        if (!user) return NextResponse.json({ detail: 'Not authenticated' }, { status: 401 })

        const novelId = await getRouteId(params)
        const novel = await prisma.novel.findFirst({
            where: { id: novelId, ownerId: user.userId },
            select: {
                id: true,
                codexSessionAutoCleanup: true,
                codexSessionRetentionLimit: true,
                codexCustomFastModeEnabled: true,
            },
        })
        if (!novel) return NextResponse.json({ detail: 'Novel not found' }, { status: 404 })

        const body = await request.json().catch(() => null)
        const category = normalizeCodexSessionCategory(body?.category) ?? 'general'

        const activeConnection = await prisma.codexConnection.findFirst({
            where: { ownerId: user.userId, isActive: true },
            orderBy: { createdAt: 'asc' },
            select: {
                id: true,
                defaultModelId: true,
                providerType: true,
                authStatus: true,
                authType: true,
            },
        })
        const defaults = getNewCodexSessionModelSettings(activeConnection, category)
        const requestedModelId = normalizeCodexStringId(body?.modelId)
        const serviceTier = isCodexFastModeAllowed(activeConnection, novel.codexCustomFastModeEnabled)
            ? normalizeCodexServiceTier(body?.serviceTier) ?? DEFAULT_CODEX_SERVICE_TIER
            : DEFAULT_CODEX_SERVICE_TIER

        const panelId = category === 'scene_continuation' ? normalizeCodexStringId(body?.panelId) : null
        if (category === 'scene_continuation') {
            const draft = panelId ? await prisma.sceneContinuationDraft.findFirst({ where: { panelId, novelId, novel: { ownerId: user.userId } } }) : null
            if (!draft) return NextResponse.json({ detail: 'Continuation panel not found.' }, { status: 400 })
            if (draft.codexSessionId) {
                const linked = await prisma.codexSession.findFirst({ where: { id: draft.codexSessionId, ownerId: user.userId } })
                if (linked) return NextResponse.json({ session: serializeCodexSession(linked), codexSessionCleanup: { deletedSessionIds: [] } })
            }
        }

        const now = new Date()
        const session = await prisma.codexSession.create({
            data: {
                id: normalizeCodexStringId(body?.id) ?? undefined,
                category,
                continuationPanelId: panelId,
                title: normalizeCodexStringId(body?.title),
                titleManuallyEdited: body?.titleManuallyEdited === true,
                reviewLevel: normalizeCodexReviewLevel(body?.reviewLevel) ?? DEFAULT_CODEX_REVIEW_LEVEL,
                modelId: requestedModelId ?? defaults.modelId,
                reasoningEffort: normalizeCodexReasoningEffort(body?.reasoningEffort)
                    ?? (requestedModelId ? 'high' : defaults.reasoningEffort),
                serviceTier,
                composerMode: normalizeCodexComposerMode(body?.composerMode) ?? 'default',
                draftContent: normalizeCodexString(body?.draftContent),
                draftAttachmentsJson: JSON.stringify(
                    parseCodexDraftAttachments(JSON.stringify(body?.draftAttachments))
                ),
                draftArtifactsJson: JSON.stringify(
                    parseCodexDraftArtifacts(JSON.stringify(body?.draftArtifacts))
                ),
                codexConnectionId: activeConnection?.id ?? null,
                novelId,
                ownerId: user.userId,
                createdAt: now,
                updatedAt: now,
            },
        })

        if (panelId) {
            await prisma.sceneContinuationDraft.update({ where: { panelId }, data: { codexSessionId: session.id } })
        }

        let codexSessionCleanup = { deletedSessionIds: [] as string[] }
        if (novel.codexSessionAutoCleanup) {
            try {
                codexSessionCleanup = await pruneCodexSessionsForCategory({
                    ownerId: user.userId,
                    novelId,
                    category,
                    retentionLimit: novel.codexSessionRetentionLimit,
                })
            } catch (cleanupError) {
                console.error(`Prune ${category} Codex sessions error:`, cleanupError)
            }
        }

        return NextResponse.json({ session: serializeCodexSession(session), codexSessionCleanup }, { status: 201 })
    } catch (error) {
        console.error('Create Codex session error:', error)
        return NextResponse.json({ detail: 'Internal server error' }, { status: 500 })
    }
}
