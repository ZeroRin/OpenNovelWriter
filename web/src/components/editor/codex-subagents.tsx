'use client'

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Bot, ChevronRight, Loader2 } from 'lucide-react'
import { codexApi } from '@/lib/api'
import { mergeSubagentTurns, type CodexSubagent, type CodexSubagentHistory } from '@/lib/codex-subagents'
import { renderSimpleMarkdown } from '@/lib/simple-markdown'
import { cn } from '@/lib/utils'
import { CodexWorkEventGroup, type WorkGroupStates } from '@/components/editor/codex-work-events'

export const CodexSubagentContext = createContext<{
    open: (agent: CodexSubagent) => void
    snapshots: Map<CodexSubagent, CodexSubagent>
} | null>(null)

export function CodexSubagentRow({ agent }: { agent: CodexSubagent }) {
    const t = useTranslations('editor.codex.subagents')
    const context = useContext(CodexSubagentContext)
    const current = context?.snapshots.get(agent) ?? agent
    const busy = current.status === 'running' || current.status === 'pendingInit'
    return (
        <button type="button" onClick={() => context?.open(agent)} disabled={!context}
            className="group flex min-h-9 max-w-full items-center gap-2 rounded-md px-1 py-1.5 text-left text-sm text-muted-foreground hover:bg-muted/40 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
            title={agent.prompt}>
            <Bot aria-hidden="true" className={cn('h-4 w-4 shrink-0 text-primary', busy && 'animate-pulse')} />
            <span className="min-w-0 truncate">{current.name || t('agent')}</span>
            <span className="shrink-0 text-xs">{t(current.status ?? 'unknown')}</span>
            <ChevronRight aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
        </button>
    )
}

export function CodexSubagentView({ sessionId, agent, parentRunning, showReasoning, onSnapshot }: {
    sessionId: string
    agent: CodexSubagent
    parentRunning: boolean
    showReasoning: boolean
    onSnapshot: (source: CodexSubagent, snapshot: CodexSubagent) => void
}) {
    const t = useTranslations('editor.codex.subagents')
    const tCommon = useTranslations('common')
    const [history, setHistory] = useState<CodexSubagentHistory | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [retry, setRetry] = useState(0)
    const [loadingOlder, setLoadingOlder] = useState(false)
    const [workStates, setWorkStates] = useState<WorkGroupStates>({})
    const scrollRef = useRef<HTMLDivElement>(null)
    const sticky = useRef(true)
    const requests = useRef(new Set<AbortController>())
    const onWorkChange = useCallback((id: string, state: WorkGroupStates[string]) => {
        setWorkStates((current) => ({ ...current, [id]: state }))
    }, [])

    useEffect(() => {
        let stopped = false
        let timer: ReturnType<typeof setTimeout> | undefined
        const controller = new AbortController()
        const poll = async () => {
            try {
                const result = await codexApi.getSubagent(sessionId, agent.threadId, undefined, controller.signal)
                if (stopped) return
                setError(null)
                onSnapshot(agent, result.agent)
                setHistory((current) => ({ ...result, turns: mergeSubagentTurns(current?.turns ?? [], result.turns), nextCursor: current ? current.nextCursor : result.nextCursor }))
                if (parentRunning || result.agent.status === 'running' || result.agent.status === 'pendingInit') timer = setTimeout(poll, 2000)
            } catch (cause) {
                if (!stopped) setError(cause instanceof Error ? cause.message : t('unavailable'))
            }
        }
        void poll()
        return () => { stopped = true; controller.abort(); clearTimeout(timer) }
    }, [sessionId, agent, parentRunning, retry, t, onSnapshot])

    useEffect(() => {
        const pending = requests.current
        return () => { for (const controller of pending) controller.abort() }
    }, [])

    useEffect(() => {
        if (sticky.current && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }, [history])

    const loadOlder = async () => {
        if (!history?.nextCursor || loadingOlder) return
        const controller = new AbortController()
        requests.current.add(controller)
        setLoadingOlder(true)
        sticky.current = false
        const scroll = scrollRef.current
        const previousHeight = scroll?.scrollHeight ?? 0
        const previousTop = scroll?.scrollTop ?? 0
        try {
            const result = await codexApi.getSubagent(sessionId, agent.threadId, history.nextCursor, controller.signal)
            if (controller.signal.aborted) return
            setHistory((current) => current ? { ...current, turns: mergeSubagentTurns(current.turns, result.turns, true), nextCursor: result.nextCursor } : result)
            setError(null)
            requestAnimationFrame(() => { if (scroll) scroll.scrollTop = previousTop + scroll.scrollHeight - previousHeight })
        } catch (cause) {
            if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : t('unavailable'))
        } finally {
            requests.current.delete(controller)
            if (!controller.signal.aborted) setLoadingOlder(false)
        }
    }

    const currentAgent = history?.agent ?? agent
    const running = currentAgent.status === 'running' || currentAgent.status === 'pendingInit'
    return (
        <div ref={scrollRef} className="absolute inset-0 z-20 overflow-y-auto overscroll-y-contain bg-background px-4 py-4" data-codex-subagent-view
            onScroll={() => { const el = scrollRef.current; if (el) sticky.current = el.scrollHeight - el.scrollTop - el.clientHeight < 64 }}>
            <div className="mb-5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span>{currentAgent.name || t('agent')}</span>
                <span role="status">{t(currentAgent.status ?? 'unknown')}</span>
                {currentAgent.model && <span>{currentAgent.model}</span>}
            </div>
            {error && <div role="alert" className="mb-4 space-y-2 text-xs text-destructive">
                <p>{error}</p>
                <button type="button" className="underline underline-offset-2" onClick={() => setRetry((value) => value + 1)}>{tCommon('retry')}</button>
            </div>}
            {!history && !error && <div role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{tCommon('loading')}</div>}
            {history?.nextCursor && <button type="button" disabled={loadingOlder} onClick={() => void loadOlder()} className="mb-5 text-xs text-muted-foreground underline underline-offset-2">{loadingOlder ? tCommon('loading') : t('loadEarlier')}</button>}
            {history?.turns.length === 0 && <p className="text-sm text-muted-foreground">{currentAgent.prompt || t('empty')}</p>}
            <div className="space-y-5">
                {history?.turns.flatMap((turn) => turn.messages).map((message) => {
                    if (message.kind === 'subagent' && message.subagent) return <CodexSubagentRow key={message.id} agent={message.subagent} />
                    if (message.kind === 'reasoning') return showReasoning ? <details key={message.id} className="text-xs text-muted-foreground"><summary className="cursor-pointer">{t('reasoning')}</summary><div className="mt-2 whitespace-pre-wrap">{message.content}</div></details> : null
                    if (message.role === 'event' && ['tool', 'command', 'file', 'web_search', 'image_view'].includes(message.kind ?? '')) {
                        return <CodexWorkEventGroup key={message.id} messages={[message]} running={running} state={workStates[message.id]} onChange={onWorkChange} />
                    }
                    return <div key={message.id} className={cn('min-w-0 break-words text-sm leading-7 [overflow-wrap:anywhere]', message.role === 'user' && 'ml-auto w-fit max-w-[90%] rounded-2xl bg-muted px-4 py-2', message.kind === 'error' && 'text-destructive')}>
                        {renderSimpleMarkdown(message.content)}
                    </div>
                })}
            </div>
        </div>
    )
}
