import type { CodexRunEvent, CodexSessionMessage } from '@/lib/api'
import { subagentsFromThreadItem, type CodexSubagent, type CodexSubagentHistory } from '@/lib/codex-subagents'

type NativeTurn = {
    id: string
    items: Record<string, unknown>[]
    status: string
    startedAt?: number | null
    error?: { message?: string } | null
}

type NativeThread = {
    id: string
    parentThreadId: string | null
    name?: string | null
    agentNickname?: string | null
    agentRole?: string | null
    model?: string | null
    preview?: string
    createdAt: number
    status: { type: string }
}

export type CodexThreadReader = { request<T>(method: string, params: unknown): Promise<T> }
type WorkItemMapper = (item: unknown, phase: 'started' | 'completed') => CodexRunEvent | null

export class CodexSubagentNotFoundError extends Error {}

export function subagentFromNativeThread(thread: NativeThread, lastTurn?: NativeTurn): CodexSubagent {
    const status = thread.status.type === 'active' ? 'running'
        : thread.status.type === 'systemError' || lastTurn?.status === 'failed' ? 'errored'
            : lastTurn?.status === 'interrupted' ? 'interrupted'
                : lastTurn?.status === 'completed' ? 'completed' : 'unknown'
    return {
        threadId: thread.id,
        name: thread.name || thread.agentNickname || thread.agentRole || undefined,
        model: thread.model || undefined,
        prompt: thread.preview || undefined,
        status,
    }
}

export function subagentTurnMessages(turn: NativeTurn, createdAt: number, mapWorkItem: WorkItemMapper): CodexSessionMessage[] {
    const time = new Date((turn.startedAt ?? createdAt) * 1000).toISOString()
    const messages: CodexSessionMessage[] = []
    const agents = new Map<string, CodexSessionMessage>()
    for (const item of turn.items) {
        const id = `${turn.id}:${String(item.id)}`
        if (item.type === 'userMessage') {
            const text = (Array.isArray(item.content) ? item.content : []).flatMap((input: Record<string, unknown>) =>
                input.type === 'text' && typeof input.text === 'string' ? [input.text] : []
            ).join('\n\n')
            messages.push({ id, role: 'user', content: text, createdAt: time })
        } else if (item.type === 'agentMessage' || item.type === 'plan') {
            messages.push({ id, role: 'assistant', kind: item.type === 'plan' ? 'plan' : undefined, content: typeof item.text === 'string' ? item.text : '', createdAt: time })
        } else if (item.type === 'reasoning') {
            const summary = (Array.isArray(item.summary) ? item.summary : []).filter((part): part is string => typeof part === 'string').join('\n\n')
            if (summary) messages.push({ id, role: 'event', kind: 'reasoning', content: summary, createdAt: time })
        } else if (item.type === 'collabAgentToolCall' || item.type === 'subAgentActivity') {
            for (const agent of subagentsFromThreadItem(item)) {
                const previous = agents.get(agent.threadId)
                if (previous) previous.subagent = { ...previous.subagent, ...agent }
                else {
                    const message: CodexSessionMessage = { id: `${turn.id}:subagent:${agent.threadId}`, role: 'event', kind: 'subagent', subagent: agent, content: '', createdAt: time }
                    agents.set(agent.threadId, message)
                    messages.push(message)
                }
            }
        } else {
            const phase = item.status === 'inProgress' ? 'started' : 'completed'
            const work = mapWorkItem(item, phase)
            if (work) messages.push({ ...work, id, role: 'event', content: [work.title, work.content].filter(Boolean).join('\n\n'), createdAt: time })
            else if (item.type === 'dynamicToolCall') {
                messages.push({ id, role: 'event', kind: 'tool', content: `${String(item.tool)}\n\n${JSON.stringify(item.contentItems ?? null, null, 2)}`, toolInput: JSON.stringify(item.arguments ?? null, null, 2), workStatus: phase === 'started' ? 'running' : item.success === false ? 'failed' : 'completed', createdAt: time })
            }
        }
    }
    if (turn.error?.message) messages.push({ id: `${turn.id}:error`, role: 'event', kind: 'error', content: turn.error.message, createdAt: time })
    return messages
}

/** Read native history only after verifying its ancestry against the owned session. */
export async function readSubagentHistory(client: CodexThreadReader, rootThreadId: string, threadId: string, mapWorkItem: WorkItemMapper, cursor?: string): Promise<CodexSubagentHistory> {
    if (threadId === rootThreadId) throw new CodexSubagentNotFoundError('Subagent not found')
    const { thread } = await client.request<{ thread: NativeThread }>('thread/read', { threadId })
    let parentId = thread.parentThreadId
    const visited = new Set([threadId])
    while (parentId && parentId !== rootThreadId && !visited.has(parentId)) {
        visited.add(parentId)
        const parent = await client.request<{ thread: NativeThread }>('thread/read', { threadId: parentId })
        parentId = parent.thread.parentThreadId
    }
    if (parentId !== rootThreadId) throw new CodexSubagentNotFoundError('Subagent not found')
    const page = await client.request<{ data: NativeTurn[]; nextCursor: string | null }>('thread/turns/list', {
        threadId, limit: 20, sortDirection: 'desc', itemsView: 'full', ...(cursor ? { cursor } : {}),
    })
    return {
        agent: subagentFromNativeThread(thread, cursor ? undefined : page.data[0]),
        turns: [...page.data].reverse().map((turn) => ({ id: turn.id, messages: subagentTurnMessages(turn, thread.createdAt, mapWorkItem) })),
        nextCursor: page.nextCursor,
    }
}
