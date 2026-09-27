import { NextRequest, NextResponse } from 'next/server'

import { isValidCodexInternalToken } from '@/lib/server/codex-internal-auth'
import { buildPromptExport } from '@/lib/server/prompt-authoring'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const INTERNAL_TOKEN_HEADER = 'x-onw-internal-token'

export async function POST(request: NextRequest) {
    if (!isValidCodexInternalToken(request.headers.get(INTERNAL_TOKEN_HEADER))) {
        return NextResponse.json({ detail: 'Forbidden' }, { status: 403 })
    }
    const body = await request.json().catch(() => null)
    const ownerId = typeof body?.ownerId === 'string' ? body.ownerId.trim() : ''
    if (!ownerId) return NextResponse.json({ detail: 'ownerId is required.' }, { status: 400 })
    const source = body?.source === undefined ? 'library' : body.source
    if (source !== 'library' && source !== 'builtin') {
        return NextResponse.json({ detail: 'source must be library or builtin.' }, { status: 400 })
    }
    if (body?.name !== undefined && (typeof body.name !== 'string' || !body.name.trim())) {
        return NextResponse.json({ detail: 'name must be a non-empty string.' }, { status: 400 })
    }

    try {
        const result = await buildPromptExport({ ownerId, source, name: body?.name })
        if (!result.ok) return NextResponse.json({ detail: result.detail }, { status: result.status })
        return NextResponse.json({ ok: true, data: result.data })
    } catch (error) {
        console.error('Codex prompt-export internal call failed:', error)
        return NextResponse.json(
            { detail: error instanceof Error ? error.message : 'Failed to export prompts.' },
            { status: 500 }
        )
    }
}
