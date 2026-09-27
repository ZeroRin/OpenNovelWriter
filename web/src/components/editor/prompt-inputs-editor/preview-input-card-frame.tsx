'use client'

import { useState, type ReactNode } from 'react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { ChevronDown, ChevronRight } from 'lucide-react'

export function PreviewInputCardFrame({
    title,
    description,
    required,
    requiredLabel,
    collapsible,
    expandLabel,
    collapseLabel,
    disabled = false,
    children,
}: {
    title: string
    description?: string | null
    required: boolean
    requiredLabel: string
    collapsible: boolean
    expandLabel: string
    collapseLabel: string
    disabled?: boolean
    children: ReactNode
}) {
    const [expanded, setExpanded] = useState(() => !collapsible)

    if (collapsible && !expanded) {
        return (
            <button
                type="button"
                className={cn(
                    'inline-flex min-h-9 max-w-full min-w-0 items-center gap-2 rounded-md border bg-background px-3 py-1.5 text-left max-md:min-h-11',
                    'transition-colors hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40'
                )}
                onClick={() => setExpanded(true)}
                aria-expanded={false}
                aria-label={`${expandLabel} ${title}`}
                title={`${expandLabel} ${title}`}
            >
                <span className="min-w-0 truncate text-sm font-medium">{title}</span>
                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
            </button>
        )
    }

    return (
        <div className="w-full min-w-0 rounded-md border bg-background p-3 space-y-3">
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 space-y-1">
                    <div className="flex items-center gap-2">
                        <div className="min-w-0 truncate text-sm font-medium">{title}</div>
                        {required && <Badge variant="secondary">{requiredLabel}</Badge>}
                    </div>
                    {description && <div className="text-xs text-muted-foreground">{description}</div>}
                </div>

                {collapsible && (
                    <button
                        type="button"
                        className={cn(
                            'rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground',
                            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40'
                        )}
                        onClick={() => setExpanded(false)}
                        aria-expanded={true}
                        aria-label={`${collapseLabel} ${title}`}
                        title={`${collapseLabel} ${title}`}
                    >
                        <ChevronDown className="h-4 w-4" />
                    </button>
                )}
            </div>

            <fieldset disabled={disabled} className="min-w-0">{children}</fieldset>
        </div>
    )
}
