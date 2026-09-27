import type { CodexSessionMessage } from '@/lib/api'

export type CodexSubagentStatus = 'pendingInit' | 'running' | 'interrupted' | 'completed' | 'errored' | 'shutdown' | 'notFound' | 'unknown'

export type CodexSubagent = {
    threadId: string
    name?: string
    status?: CodexSubagentStatus
    prompt?: string
    message?: string
    model?: string
}

export type CodexSubagentTurn = { id: string; messages: CodexSessionMessage[] }
export type CodexSubagentHistory = {
    agent: CodexSubagent
    turns: CodexSubagentTurn[]
    nextCursor: string | null
}

export function normalizeCodexSubagent(value: unknown): CodexSubagent | undefined {
    if (!value || typeof value !== 'object') return undefined
    const record = value as Record<string, unknown>
    if (typeof record.threadId !== 'string' || !record.threadId) return undefined
    return {
        threadId: record.threadId,
        ...Object.fromEntries(['name', 'prompt', 'message', 'model'].flatMap((key) => typeof record[key] === 'string' ? [[key, record[key]]] : [])),
        ...(['pendingInit', 'running', 'interrupted', 'completed', 'errored', 'shutdown', 'notFound', 'unknown'].includes(String(record.status))
            ? { status: record.status as CodexSubagentStatus } : {}),
    }
}

/** Native collaboration calls can address several agents in one item. */
export function subagentsFromThreadItem(value: unknown): CodexSubagent[] {
    if (!value || typeof value !== 'object') return []
    const item = value as Record<string, unknown>
    if (item.type === 'subAgentActivity' && typeof item.agentThreadId === 'string') {
        const status = { started: 'running', interacted: 'running', interrupted: 'interrupted', completed: 'completed' }[String(item.kind)]
        return [{ threadId: item.agentThreadId, ...(typeof item.agentPath === 'string' ? { name: item.agentPath } : {}), ...(status ? { status: status as CodexSubagentStatus } : {}) }]
    }
    if (item.type !== 'collabAgentToolCall') return []
    const states = item.agentsStates && typeof item.agentsStates === 'object' ? item.agentsStates as Record<string, unknown> : {}
    const ids = new Set([...(Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : []), ...Object.keys(states)])
    return [...ids].flatMap((id) => {
        if (typeof id !== 'string' || !id || id === item.senderThreadId) return []
        const state = states[id] && typeof states[id] === 'object' ? states[id] as Record<string, unknown> : {}
        const agent = normalizeCodexSubagent({
            ...state,
            threadId: id,
            ...(item.tool === 'spawnAgent' && typeof item.prompt === 'string' ? { prompt: item.prompt } : {}),
            ...(typeof item.model === 'string' ? { model: item.model } : {}),
        })
        return agent ? [agent] : []
    })
}

export function mergeSubagentTurns(current: CodexSubagentTurn[], page: CodexSubagentTurn[], older = false) {
    const updates = new Map(page.map((turn) => [turn.id, turn]))
    const ids = new Set(current.map((turn) => turn.id))
    const added = page.filter((turn) => !ids.has(turn.id))
    const merged = current.map((turn) => updates.get(turn.id) ?? turn)
    return older ? [...added, ...merged] : [...merged, ...added]
}
