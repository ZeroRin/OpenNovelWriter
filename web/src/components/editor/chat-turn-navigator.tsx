'use client'

import { useLayoutEffect, useMemo, useState, type RefObject } from 'react'

import { ConversationTurnNavigator, type ConversationTurnNavigatorEntry } from '@/components/editor/conversation-turn-navigator'
import type { EditorChatMessage } from '@/components/editor/editor-chat-store'

type ChatTurnNavigatorProps = {
    messages: EditorChatMessage[]
    scrollAreaRef: RefObject<HTMLDivElement | null>
}

export function ChatTurnNavigator({ messages, scrollAreaRef }: ChatTurnNavigatorProps) {
    const [activeIndex, setActiveIndex] = useState(0)
    const [height, setHeight] = useState(0)
    const entries = useMemo(() => {
        const turns: ConversationTurnNavigatorEntry[] = []
        for (const message of messages) {
            if (message.role === 'user') {
                turns.push({ id: message.id, userText: message.content, assistantText: '' })
            } else if (message.role === 'assistant') {
                const turn = turns.at(-1)
                if (turn) turn.assistantText = message.content
            }
        }
        return turns
    }, [messages])

    useLayoutEffect(() => {
        const viewport = scrollAreaRef.current?.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]')
        const content = viewport?.firstElementChild
        if (!viewport || !content || entries.length === 0) return

        let frame: number | null = null
        let offsets: number[] = []
        const elements = new Map(
            Array.from(content.querySelectorAll<HTMLElement>('[data-chat-message-id]'))
                .map((element) => [element.dataset.chatMessageId, element] as const)
        )
        const updateActiveTurn = () => {
            const target = viewport.scrollTop + Math.min(viewport.clientHeight * 0.28, 180)
            let nextIndex = 0
            offsets.forEach((offset, index) => {
                if (offset <= target) nextIndex = index
            })
            setActiveIndex(nextIndex)
        }
        const measure = () => {
            const top = viewport.getBoundingClientRect().top
            offsets = entries.map((entry) => {
                const element = elements.get(entry.id)
                return element ? element.getBoundingClientRect().top - top + viewport.scrollTop : 0
            })
            setHeight(Math.max(0, viewport.clientHeight - 24))
            updateActiveTurn()
        }
        const scheduleMeasure = () => {
            if (frame !== null) cancelAnimationFrame(frame)
            frame = requestAnimationFrame(() => {
                frame = null
                measure()
            })
        }

        measure()
        viewport.addEventListener('scroll', updateActiveTurn, { passive: true })
        const observer = new ResizeObserver(scheduleMeasure)
        observer.observe(viewport)
        observer.observe(content)

        return () => {
            viewport.removeEventListener('scroll', updateActiveTurn)
            observer.disconnect()
            if (frame !== null) cancelAnimationFrame(frame)
        }
    }, [entries, scrollAreaRef])

    const jumpToTurn = (index: number) => {
        const viewport = scrollAreaRef.current?.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]')
        const entry = entries[index]
        if (!viewport || !entry) return
        const element = Array.from(viewport.querySelectorAll<HTMLElement>('[data-chat-message-id]'))
            .find((message) => message.dataset.chatMessageId === entry.id)
        if (!element) return
        const top = element.getBoundingClientRect().top - viewport.getBoundingClientRect().top + viewport.scrollTop - 12
        viewport.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
        setActiveIndex(index)
    }

    return (
        <div className="pointer-events-none absolute left-0 top-3 z-30">
            <ConversationTurnNavigator entries={entries} activeIndex={activeIndex} height={height} onJump={jumpToTurn} />
        </div>
    )
}
