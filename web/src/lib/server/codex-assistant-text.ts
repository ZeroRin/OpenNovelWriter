import { collapseRepeatedAssistantText } from '@/lib/collapse-repeated-text'

export { collapseRepeatedAssistantText }

export type ReconciledAssistantText = {
    assistantText: string
    delta: string
}

function collapseWhitespace(value: string) {
    return value.replace(/\s+/g, ' ').trim()
}

/** Reconcile one native message's completed text with its streamed content. */
export function mergeCompletedAssistantText(streamed: string, completed: string): ReconciledAssistantText {
    if (!completed) return { assistantText: streamed, delta: '' }
    if (!streamed) return { assistantText: completed, delta: completed }
    if (completed === streamed) return { assistantText: streamed, delta: '' }

    const streamedTrim = streamed.trim()
    const completedTrim = completed.trim()
    if (completedTrim === streamedTrim) return { assistantText: streamed, delta: '' }

    if (completed.startsWith(streamed)) {
        return { assistantText: completed, delta: completed.slice(streamed.length) }
    }
    if (streamed.startsWith(completed)) {
        return { assistantText: streamed, delta: '' }
    }

    const streamedNorm = collapseWhitespace(streamed)
    const completedNorm = collapseWhitespace(completed)
    if (completedNorm === streamedNorm) return { assistantText: streamed, delta: '' }
    if (completedNorm.startsWith(streamedNorm)) {
        return { assistantText: completed, delta: completed.slice(streamed.length) }
    }
    if (streamedNorm.startsWith(completedNorm)) {
        return { assistantText: streamed, delta: '' }
    }

    // The completed item is already the second copy of a duplicated stream.
    if (streamedTrim.endsWith(completedTrim)) {
        return { assistantText: streamed, delta: '' }
    }

    // Substantial overlap means this is the same reply, not a Grok-style
    // preamble followed by a distinct answer.
    if (completedNorm.length >= 40 && streamedNorm.includes(completedNorm)) {
        return { assistantText: streamed, delta: '' }
    }
    if (streamedNorm.length >= 40 && completedNorm.includes(streamedNorm)) {
        return completed.startsWith(streamed)
            ? { assistantText: completed, delta: completed.slice(streamed.length) }
            : { assistantText: completed, delta: '' }
    }

    const merged = `${streamed}${completed}`
    const collapsed = collapseRepeatedAssistantText(merged)
    if (collapsed === streamed || collapseWhitespace(collapsed) === collapseWhitespace(streamed)) {
        return { assistantText: streamed, delta: '' }
    }
    return {
        assistantText: collapsed,
        delta: collapsed.startsWith(streamed) ? collapsed.slice(streamed.length) : completed,
    }
}
