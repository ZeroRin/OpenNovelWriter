import { NextRequest, NextResponse } from 'next/server'
import { isOfficialDeepSeekResponsesProvider } from '@/lib/codex-deepseek'
import { getPrismaClient } from '@/lib/db'
import { decryptApiKey } from '@/lib/server/ai-credentials'
import { isValidCodexInternalToken } from '@/lib/server/codex-internal-auth'
import { searchDeepSeekWeb } from '@/lib/server/deepseek-web-search'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
    if (!isValidCodexInternalToken(request.headers.get('x-onw-internal-token'))) {
        return NextResponse.json({ detail: 'Forbidden' }, { status: 403 })
    }
    const body = await request.json().catch(() => null)
    const ownerId = typeof body?.ownerId === 'string' ? body.ownerId.trim() : ''
    const connectionId = typeof body?.connectionId === 'string' ? body.connectionId.trim() : ''
    const query = typeof body?.query === 'string' ? body.query.trim() : ''
    if (!ownerId || !connectionId || !query) {
        return NextResponse.json({ detail: 'ownerId, connectionId, and query are required.' }, { status: 400 })
    }
    const connection = await getPrismaClient({ ensureModel: 'codexConnection' }).codexConnection.findFirst({
        where: { id: connectionId, ownerId, providerType: 'custom' },
    })
    if (!connection) return NextResponse.json({ detail: 'Codex connection not found.' }, { status: 404 })
    if (!connection.baseUrl || connection.upstreamFormat !== 'responses'
        || !isOfficialDeepSeekResponsesProvider(connection.upstreamFormat, connection.baseUrl)) {
        return NextResponse.json({ detail: 'Web search requires an official DeepSeek Responses connection.' }, { status: 400 })
    }
    if (!connection.encryptedApiKey) return NextResponse.json({ detail: 'DeepSeek API key is missing.' }, { status: 400 })
    try {
        const result = await searchDeepSeekWeb({
            baseUrl: connection.baseUrl, apiKey: decryptApiKey(connection.encryptedApiKey),
            query, signal: request.signal,
        })
        return NextResponse.json({ ok: true, ...result })
    } catch (error) {
        return NextResponse.json({ detail: error instanceof Error ? error.message : 'Web search failed.' }, { status: 502 })
    }
}
