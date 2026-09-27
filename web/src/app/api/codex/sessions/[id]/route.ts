import { getLiveCodexMessages } from '@/lib/server/codex-live-messages'
import { NextRequest, NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { getPrismaClient } from '@/lib/db'
import { isCodexFastModeAllowed } from '@/lib/codex-config'
import {
    normalizeCodexComposerMode,
    normalizeCodexReasoningEffort,
    normalizeCodexReviewLevel,
    normalizeCodexServiceTier,
    normalizeCodexString,
    normalizeCodexStringId,
    parseCodexDraftArtifacts,
    parseCodexDraftAttachments,
    serializeCodexSession,
} from '@/lib/server/codex-session'
import { deleteCodexSession } from '@/lib/server/codex-session-deletion'
import { updateActiveCodexServiceTier } from '@/lib/server/codex-app-server'

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
    const user = await getCurrentUser(request)
    if (!user) return NextResponse.json({ detail: 'Not authenticated' }, { status: 401 })
    const id = await getRouteId(params)
    const session = await prisma.codexSession.findFirst({ where: { id, ownerId: user.userId } })
    if (!session) return NextResponse.json({ detail: 'Codex session not found' }, { status: 404 })
    return NextResponse.json({ session: serializeCodexSession(session, getLiveCodexMessages(id)) })
}

export async function PATCH(request: NextRequest, { params }: RouteContext) {
    try {
        const user = await getCurrentUser(request)
        if (!user) return NextResponse.json({ detail: 'Not authenticated' }, { status: 401 })

        const id = await getRouteId(params)
        const existing = await prisma.codexSession.findFirst({
            where: { id, ownerId: user.userId },
            select: { id: true, modelId: true, novelId: true, codexConnectionId: true },
        })
        if (!existing) return NextResponse.json({ detail: 'Codex session not found' }, { status: 404 })

        const body = await request.json().catch(() => null)
        const data: {
            title?: string | null
            titleManuallyEdited?: boolean
            reviewLevel?: string
            modelId?: string
            reasoningEffort?: string
            serviceTier?: 'standard' | 'fast'
            composerMode?: string
            draftContent?: string
            draftAttachmentsJson?: string
            draftArtifactsJson?: string
            updatedAt: Date
        } = { updatedAt: new Date() }

        if (body && Object.hasOwn(body, 'title')) {
            data.title = normalizeCodexStringId(body.title)
        }
        if (body && Object.hasOwn(body, 'titleManuallyEdited')) {
            data.titleManuallyEdited = body.titleManuallyEdited === true
        }
        if (body && Object.hasOwn(body, 'reviewLevel')) {
            const reviewLevel = normalizeCodexReviewLevel(body.reviewLevel)
            if (!reviewLevel) {
                return NextResponse.json({ detail: 'Invalid Codex review level' }, { status: 400 })
            }
            data.reviewLevel = reviewLevel
        }
        if (body && Object.hasOwn(body, 'modelId')) {
            const modelId = normalizeCodexStringId(body.modelId)
            if (!modelId) {
                return NextResponse.json({ detail: 'Invalid Codex model' }, { status: 400 })
            }
            data.modelId = modelId
        }
        if (body && Object.hasOwn(body, 'reasoningEffort')) {
            const reasoningEffort = normalizeCodexReasoningEffort(body.reasoningEffort)
            if (!reasoningEffort) {
                return NextResponse.json({ detail: 'Invalid Codex reasoning effort' }, { status: 400 })
            }
            data.reasoningEffort = reasoningEffort
        }
        if (body && Object.hasOwn(body, 'serviceTier')) {
            const serviceTier = normalizeCodexServiceTier(body.serviceTier)
            if (!serviceTier) {
                return NextResponse.json({ detail: 'Invalid Codex service tier' }, { status: 400 })
            }
            data.serviceTier = serviceTier
        }
        if (body && Object.hasOwn(body, 'composerMode')) {
            const composerMode = normalizeCodexComposerMode(body.composerMode)
            if (!composerMode) {
                return NextResponse.json({ detail: 'Invalid Codex composer mode' }, { status: 400 })
            }
            data.composerMode = composerMode
        }
        if (body && Object.hasOwn(body, 'draftContent')) {
            data.draftContent = normalizeCodexString(body.draftContent)
        }
        if (body && Object.hasOwn(body, 'draftAttachments')) {
            data.draftAttachmentsJson = JSON.stringify(
                parseCodexDraftAttachments(JSON.stringify(body.draftAttachments))
            )
        }
        if (body && Object.hasOwn(body, 'draftArtifacts')) {
            data.draftArtifactsJson = JSON.stringify(
                parseCodexDraftArtifacts(JSON.stringify(body.draftArtifacts))
            )
        }

        if (data.serviceTier) {
            if (data.serviceTier === 'fast') {
                const [connection, novel] = await Promise.all([
                    prisma.codexConnection.findFirst({
                        where: existing.codexConnectionId
                            ? { id: existing.codexConnectionId, ownerId: user.userId }
                            : { ownerId: user.userId, isActive: true },
                        orderBy: { createdAt: 'asc' },
                    }),
                    prisma.novel.findFirstOrThrow({
                        where: { id: existing.novelId, ownerId: user.userId },
                        select: { codexCustomFastModeEnabled: true },
                    }),
                ])
                if (!isCodexFastModeAllowed(connection, novel.codexCustomFastModeEnabled)) {
                    data.serviceTier = 'standard'
                }
            }
            await updateActiveCodexServiceTier({
                sessionId: id,
                modelId: data.modelId ?? existing.modelId,
                serviceTier: data.serviceTier,
            })
        }

        const session = await prisma.codexSession.update({
            where: { id },
            data,
        })

        return NextResponse.json({ session: serializeCodexSession(session) })
    } catch (error) {
        console.error('Update Codex session error:', error)
        return NextResponse.json({ detail: 'Internal server error' }, { status: 500 })
    }
}

export async function DELETE(request: NextRequest, { params }: RouteContext) {
    try {
        const user = await getCurrentUser(request)
        if (!user) return NextResponse.json({ detail: 'Not authenticated' }, { status: 401 })

        const id = await getRouteId(params)
        const existing = await prisma.codexSession.findFirst({
            where: { id, ownerId: user.userId },
            select: { id: true },
        })
        if (!existing) return NextResponse.json({ detail: 'Codex session not found' }, { status: 404 })

        await deleteCodexSession(user.userId, id)
        return NextResponse.json({ ok: true })
    } catch (error) {
        console.error('Delete Codex session error:', error)
        return NextResponse.json({ detail: 'Internal server error' }, { status: 500 })
    }
}
