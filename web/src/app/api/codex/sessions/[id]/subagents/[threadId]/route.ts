import { NextRequest, NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { getPrismaClient } from '@/lib/db'
import { readCodexSubagent } from '@/lib/server/codex-app-server'
import { CodexSubagentNotFoundError } from '@/lib/server/codex-subagent-history'

const prisma = getPrismaClient({ ensureModel: 'codexSession' })

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string; threadId: string }> }) {
    const user = await getCurrentUser(request)
    if (!user) return NextResponse.json({ detail: 'Not authenticated' }, { status: 401 })
    const { id, threadId } = await params
    const session = await prisma.codexSession.findFirst({
        where: { id, ownerId: user.userId },
        select: { codexThreadId: true, codexConnectionId: true },
    })
    if (!session) return NextResponse.json({ detail: 'Codex session not found' }, { status: 404 })
    try {
        const result = await readCodexSubagent({
            ownerId: user.userId, sessionId: id, codexThreadId: session.codexThreadId,
            codexConnectionId: session.codexConnectionId, threadId,
            cursor: request.nextUrl.searchParams.get('cursor') || undefined,
        })
        return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } })
    } catch (error) {
        if (error instanceof CodexSubagentNotFoundError) return NextResponse.json({ detail: error.message }, { status: 404 })
        console.error('Failed to read Codex subagent:', error)
        return NextResponse.json({ detail: 'Unable to read the subagent conversation.' }, { status: 502 })
    }
}
