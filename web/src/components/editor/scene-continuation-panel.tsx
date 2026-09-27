'use client'

import { continuationInputsFromValues, type ContinuationPromptSnapshot } from '@/lib/continuation-prompt'
import { registerContinuationPanelSave } from '@/lib/continuation-panel-sync'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Brain, Check, ChevronDown, ChevronRight, Eye, EyeOff, FileText, Heart, Loader2, PenLine, ScrollText, Sparkles, Trash2 } from 'lucide-react'
import { ModelGroupLogoIcon } from '@/components/ai/model-group-logo-icon'
import { PreviewInputList } from '@/components/editor/prompt-inputs-editor/preview-input-list'
import { useInputsEditorModel, type PersistedInputsEditorPreviewState } from '@/components/editor/prompt-inputs-editor/model'
import { TermMentionPreviewPopover } from '@/components/editor/terms/term-mention-preview-popover'
import { TermMentionsHighlightTextarea } from '@/components/editor/terms/term-mentions-highlight-textarea'
import { getTermEntryColorClasses, getTermEntryColorId } from '@/components/editor/terms/term-entry-colors'
import { findMentionedTermIds, type TermMentionMatcher } from '@/components/editor/terms/term-mentions-utils'
import type { TermEntry } from '@/components/editor/terms/types'
import { useInfoPanelStore } from '@/components/editor/info-panel-store'
import { Badge } from '@/components/ui/badge'
import { AutoResizeTextarea } from '@/components/ui/auto-resize-textarea'
import { Button } from '@/components/ui/button'
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { ModelGroup } from '@/lib/ai-store'
import { continuationDraftApi, promptApi, type ChapterWithScenes, type Novel, type Prompt, type PromptDefaultSelection, type Scene } from '@/lib/api'
import { useEditorCodexStore } from '@/components/editor/editor-codex-store'
import { getAvailableModelAssignments, runModelGroupWithFallback } from '@/lib/ai-runner'
import { PROMPTS_CHANGED_EVENT } from '@/lib/prompt-events'
import { MODEL_GROUPS_CHANGED_EVENT } from '@/lib/model-group-events'
import { invalidateSceneContinuationMenuDataCache, loadSceneContinuationMenuData } from '@/lib/scene-continuation-menu-data'
import { cn } from '@/lib/utils'
import { useWriteFormatStore, type WriteAiOutputStyle } from '@/components/editor/write-format-store'

type PromptSelection =
    | { type: 'default' }
    | { type: 'prompt'; promptId: string }

// Only lightweight per-panel UI prefs live in localStorage. The continuation draft text
// (content/planning) is the shared source of truth and lives in the DB (continuationDraftApi),
// so a linked Codex session can read and rewrite it.
type PersistedSceneContinuationPanelState = {
    collapsed?: boolean
    draft?: string
    promptSelection?: PromptSelection
    outputPromptId?: string
    selectedGroupId?: string
}

type StructuredContinuationOutput = {
    rawText: string
    content: string
    planning: string
}

const SCENE_CONTINUATION_PANEL_STORAGE_PREFIX = 'onw.editor.sceneContinuation.promptPanelState.v1.'

function getDecoratedBlockClass(style: WriteAiOutputStyle, tone: 'planning' | 'reasoning') {
    if (style === 'card') {
        return tone === 'planning'
            ? 'rounded-xl border border-sky-200/70 bg-gradient-to-br from-sky-50/80 via-background to-cyan-50/60 px-4 py-3 shadow-sm dark:border-sky-900/50 dark:from-sky-950/30 dark:to-cyan-950/20'
            : 'rounded-xl border border-amber-200/70 bg-gradient-to-br from-amber-50/80 via-background to-orange-50/60 px-4 py-3 shadow-sm dark:border-amber-900/50 dark:from-amber-950/30 dark:to-orange-950/20'
    }

    return 'rounded-lg border bg-muted/30 px-4 py-3'
}

function isAbortError(error: unknown) {
    return (
        (error instanceof DOMException && error.name === 'AbortError') ||
        (error instanceof Error && error.name === 'AbortError')
    )
}

function normalizePromptSelection(value: unknown): PromptSelection | null {
    const record = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
    if (!record) return null
    if (record.type === 'default') return { type: 'default' }
    if (record.type === 'prompt') {
        const promptId = typeof record.promptId === 'string' ? record.promptId.trim() : ''
        if (!promptId) return null
        return { type: 'prompt', promptId }
    }
    return null
}

function safeGetLocalStorage(key: string): string | null {
    if (typeof window === 'undefined') return null
    try {
        return window.localStorage.getItem(key)
    } catch {
        return null
    }
}

function safeSetLocalStorage(key: string, value: string) {
    if (typeof window === 'undefined') return
    try {
        window.localStorage.setItem(key, value)
    } catch {
        // Ignore unavailable storage.
    }
}

function loadPersistedSceneContinuationPanelState(key: string): PersistedSceneContinuationPanelState | null {
    const raw = safeGetLocalStorage(key)
    if (!raw) return null
    try {
        const parsed = JSON.parse(raw) as Record<string, unknown>
        if (!parsed || typeof parsed !== 'object') return null
        return {
            collapsed: typeof parsed.collapsed === 'boolean' ? parsed.collapsed : undefined,
            draft: typeof parsed.draft === 'string' ? parsed.draft : undefined,
            promptSelection: normalizePromptSelection(parsed.promptSelection) ?? undefined,
            outputPromptId: typeof parsed.outputPromptId === 'string' ? parsed.outputPromptId : undefined,
            selectedGroupId: typeof parsed.selectedGroupId === 'string' ? parsed.selectedGroupId : undefined,
        }
    } catch {
        return null
    }
}

function buildChaptersForScenePromptPreview(params: {
    novelId?: string
    chapterId: string
    chapterTitle?: string
    scenes: Scene[]
    localEdits: Record<string, string>
    novelData: (Novel & { chapters: ChapterWithScenes[] }) | null
}): ChapterWithScenes[] {
    const { novelId, chapterId, chapterTitle, scenes, localEdits, novelData } = params
    const mergedScenes = scenes
        .slice()
        .sort((left, right) => left.order - right.order)
        .map((scene) => ({
            ...scene,
            content: localEdits[scene.id] ?? scene.content ?? '',
        }))

    const chapters = (novelData?.chapters ?? []).map((chapter) => {
        if (chapter.id !== chapterId) return chapter
        return {
            ...chapter,
            title: chapterTitle ?? chapter.title,
            scenes: mergedScenes,
        }
    })

    if (chapters.length > 0) return chapters

    const now = new Date().toISOString()
    return [
        {
            id: chapterId,
            title: chapterTitle ?? '',
            actNumber: 1,
            order: 1,
            wordCount: 0,
            novelId: novelId ?? '',
            createdAt: now,
            updatedAt: now,
            scenes: mergedScenes,
        },
    ]
}

function getPromptGroups(prompt: Prompt | null | undefined, groups: ModelGroup[] | null | undefined) {
    if (!prompt || !Array.isArray(groups)) return []
    const byId = new Map(groups.map((group) => [group.id, group]))
    return (prompt.modelGroupIds ?? [])
        .map((groupId) => byId.get(groupId) ?? null)
        .filter((group): group is ModelGroup => group !== null)
}

function hasRunnableGroup(groups: ModelGroup[]) {
    return groups.some((group) => getAvailableModelAssignments(group).length > 0)
}

function getPromptRunDisabledReason(prompt: Prompt | null | undefined, groups: ModelGroup[] | null | undefined) {
    if (!prompt) return 'missingPrompt' as const
    if ((prompt.modelGroupIds ?? []).length === 0) return 'noModelBinding' as const

    const promptGroups = getPromptGroups(prompt, groups)
    if (promptGroups.length === 0) return 'missingModelGroup' as const
    if (!hasRunnableGroup(promptGroups)) return 'noValidModel' as const

    return null
}

function extractTaggedSection(rawText: string, tagName: 'Content' | 'Planning') {
    const lowerText = rawText.toLowerCase()
    const openTag = `<${tagName.toLowerCase()}>`
    const closeTag = `</${tagName.toLowerCase()}>`
    const startIndex = lowerText.indexOf(openTag)
    if (startIndex === -1) return ''

    const contentStart = startIndex + openTag.length
    const endIndex = lowerText.indexOf(closeTag, contentStart)
    const contentEnd = endIndex === -1 ? rawText.length : endIndex
    return rawText.slice(contentStart, contentEnd).trim()
}

function parseStructuredContinuationOutput(rawText: string | null | undefined): StructuredContinuationOutput {
    const normalizedText = typeof rawText === 'string' ? rawText.trim() : ''

    return {
        rawText: normalizedText,
        content: extractTaggedSection(normalizedText, 'Content'),
        planning: extractTaggedSection(normalizedText, 'Planning'),
    }
}

function SceneContinuationStructuredOutput({
    content,
    planning,
    reasoning,
    promptName,
    onContentChange,
    onPlanningChange,
}: {
    content: string
    planning: string
    reasoning: string
    promptName: string
    onContentChange: (value: string) => void
    onPlanningChange: (value: string) => void
}) {
    const tSceneOperation = useTranslations('editor.sceneOperation')
    const { planningStyle, reasoningStyle } = useWriteFormatStore()
    const [expandedPlanningFor, setExpandedPlanningFor] = useState<string | null>(null)
    const [reasoningExpanded, setReasoningExpanded] = useState(false)

    const hasContent = content.trim().length > 0
    const hasPlanning = planning.trim().length > 0
    const hasReasoning = reasoning.trim().length > 0
    const planningExpanded = expandedPlanningFor === planning

    return (
        <div className="rounded-xl border bg-card/95 p-4 shadow-sm space-y-4">
            <div className="flex items-center gap-2 text-sm font-medium">
                <FileText className="h-4 w-4 text-muted-foreground" />
                <span>{tSceneOperation('modelOutput')}</span>
            </div>

            {!hasContent && !hasPlanning && !hasReasoning ? (
                <div className="rounded-lg border border-dashed px-4 py-6 text-sm text-center text-muted-foreground">
                    {tSceneOperation('resultEmpty')}
                </div>
            ) : null}

            {hasReasoning && (
                <div className="space-y-2">
                    <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                        <Brain className="h-3.5 w-3.5" />
                        <span>{tSceneOperation('reasoning')}</span>
                    </div>
                    <div className="rounded-xl border border-border/70 overflow-hidden">
                        <button
                            type="button"
                            className="flex w-full items-center justify-between gap-3 bg-muted/20 px-4 py-3 text-left"
                            onClick={() => setReasoningExpanded((current) => !current)}
                        >
                            <span className="inline-flex min-w-0 items-center gap-2 text-sm font-medium">
                                <Brain className="h-4 w-4 shrink-0 text-muted-foreground" />
                                <span className="truncate">{promptName}</span>
                            </span>
                            {reasoningExpanded ? (
                                <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                            ) : (
                                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                            )}
                        </button>
                        {reasoningExpanded && (
                            <div className="p-3">
                                <div
                                    className={cn(
                                        'whitespace-pre-wrap text-sm leading-6 text-muted-foreground',
                                        getDecoratedBlockClass(reasoningStyle, 'reasoning')
                                    )}
                                >
                                    {reasoning}
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            )}

            {hasPlanning && (
                <div className="rounded-xl border border-border/70 overflow-hidden">
                    <button
                        type="button"
                        className="flex w-full items-center justify-between gap-3 bg-muted/25 px-4 py-3 text-left"
                        onClick={() =>
                            setExpandedPlanningFor((current) => (current === planning ? null : planning))
                        }
                    >
                        <span className="inline-flex min-w-0 items-center gap-2 text-sm font-medium">
                            <ScrollText className="h-4 w-4 shrink-0 text-muted-foreground" />
                            <span className="truncate">{tSceneOperation('planning')}</span>
                        </span>
                        {planningExpanded ? (
                            <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                        ) : (
                            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                        )}
                    </button>
                    {planningExpanded && (
                        <div className="p-3">
                            <div className={getDecoratedBlockClass(planningStyle, 'planning')}>
                                <AutoResizeTextarea
                                    value={planning}
                                    onChange={(event) => onPlanningChange(event.target.value)}
                                    className="min-h-[120px] border-0 bg-transparent px-0 py-0 shadow-none focus-visible:ring-0"
                                />
                            </div>
                        </div>
                    )}
                </div>
            )}

            {hasContent && (
                <div className="rounded-xl border border-border/70 bg-gradient-to-br from-background via-background to-muted/25 px-4 py-4">
                    <div className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                        <ScrollText className="h-3.5 w-3.5" />
                        <span>{tSceneOperation('content')}</span>
                    </div>
                    <AutoResizeTextarea
                        value={content}
                        onChange={(event) => onContentChange(event.target.value)}
                        className="min-h-[220px] border-0 bg-transparent px-0 py-0 text-[15px] leading-7 shadow-none focus-visible:ring-0"
                    />
                </div>
            )}
        </div>
    )
}

export function SceneContinuationPanel({
    novelId,
    chapterId,
    chapterTitle,
    sceneId,
    panelId,
    scenes,
    localEdits,
    ensureComponentPrompts,
    ensureNovelData,
    termMentionMatcher = null,
    termEntries,
    onApplyContinuation,
    onOpenRightSidebar,
    onClose,
}: {
    novelId?: string
    chapterId: string
    chapterTitle?: string
    sceneId: string
    panelId?: string
    scenes: Scene[]
    localEdits: Record<string, string>
    ensureComponentPrompts: () => Promise<Prompt[]>
    ensureNovelData: () => Promise<(Novel & { chapters: ChapterWithScenes[] }) | null>
    termMentionMatcher?: TermMentionMatcher | null
    termEntries: TermEntry[]
    onApplyContinuation: (sceneId: string, continuation: string) => void
    onOpenRightSidebar?: () => void
    onClose: () => void
}) {
    const [codexSessionId, setCodexSessionId] = useState<string | null>(null)
    const [lockedSnapshot, setLockedSnapshot] = useState<ContinuationPromptSnapshot | null>(null)
    const [draftLoaded, setDraftLoaded] = useState(!panelId || !novelId)
    const snapshotRef = useRef<ContinuationPromptSnapshot | null>(null)
    const savedSnapshotRef = useRef<string | null>(null)
    const discardingRef = useRef(false)
    const tEditor = useTranslations('editor')
    const tCommon = useTranslations('common')
    const tPrompts = useTranslations('prompts')
    const tSceneOperation = useTranslations('editor.sceneOperation')
    const showInfoPanelPreview = useInfoPanelStore((s) => s.showPreview)
    const updateInfoPanelPreview = useInfoPanelStore((s) => s.updatePreview)

    const storageKey = useMemo(
        () => `${SCENE_CONTINUATION_PANEL_STORAGE_PREFIX}${sceneId}${panelId ? `.${panelId}` : ''}`,
        [panelId, sceneId]
    )
    const initialPersistedState = useMemo(() => loadPersistedSceneContinuationPanelState(storageKey), [storageKey])

    const [collapsed, setCollapsed] = useState(() => initialPersistedState?.collapsed ?? false)
    const [draft, setDraft] = useState(() => initialPersistedState?.draft ?? '')
    const [promptSelection, setPromptSelection] = useState<PromptSelection>(
        () => initialPersistedState?.promptSelection ?? { type: 'default' }
    )
    const [prompts, setPrompts] = useState<Prompt[] | null>(null)
    const [defaults, setDefaults] = useState<Partial<Record<'scene_continuation', PromptDefaultSelection>> | null>(null)
    const [groups, setGroups] = useState<ModelGroup[] | null>(null)
    const [componentPrompts, setComponentPrompts] = useState<Prompt[] | null>(null)
    const [novelData, setNovelData] = useState<(Novel & { chapters: ChapterWithScenes[] }) | null>(null)
    const [loadError, setLoadError] = useState<string | null>(null)
    const [runError, setRunError] = useState<string | null>(null)
    const [generating, setGenerating] = useState(false)
    const [selectedGroupId, setSelectedGroupId] = useState(() => initialPersistedState?.selectedGroupId ?? '')
    const [outputPromptId, setOutputPromptId] = useState<string | null>(() => initialPersistedState?.outputPromptId ?? null)
    const [resultText, setResultText] = useState('')
    const [reasoningText, setReasoningText] = useState('')
    const [contentDraft, setContentDraft] = useState('')
    const [planningDraft, setPlanningDraft] = useState('')
    const [mentionPreview, setMentionPreview] = useState<{ termId: string; anchorEl: HTMLElement } | null>(null)
    const generateAbortRef = useRef<AbortController | null>(null)
    const lastSyncedOutputTextRef = useRef('')
    const [sending, setSending] = useState(false)
    const [sendError, setSendError] = useState<string | null>(null)
    const isLocked = !draftLoaded || sending || Boolean(codexSessionId)

    useEffect(() => {
        safeSetLocalStorage(
            storageKey,
            JSON.stringify({
                collapsed,
                draft,
                promptSelection,
                outputPromptId: outputPromptId ?? undefined,
                selectedGroupId,
            } satisfies PersistedSceneContinuationPanelState)
        )
    }, [collapsed, draft, outputPromptId, promptSelection, selectedGroupId, storageKey])

    useEffect(() => {
        return () => {
            generateAbortRef.current?.abort()
        }
    }, [])

    const loadPanelData = useCallback(
        async (options?: { force?: boolean }) => {
            if (options?.force) invalidateSceneContinuationMenuDataCache()
            setLoadError(null)
            try {
                const [menuData, components, novelDataResult] = await Promise.all([
                    loadSceneContinuationMenuData(),
                    options?.force
                        ? promptApi.list({ category: 'component' }).then((result) => result.prompts ?? []).catch(() => [] as Prompt[])
                        : ensureComponentPrompts().catch(() => [] as Prompt[]),
                    ensureNovelData().catch(() => null),
                ])

                setPrompts(menuData.prompts)
                setDefaults(menuData.defaults)
                setGroups(menuData.groups)
                setComponentPrompts(components)
                setNovelData(novelDataResult)
            } catch (error) {
                console.error('Failed to load scene continuation panel data:', error)
                setLoadError(error instanceof Error ? error.message : String(error))
                setPrompts([])
                setDefaults({})
                setGroups([])
                setComponentPrompts([])
                setNovelData(null)
            }
        },
        [ensureComponentPrompts, ensureNovelData]
    )

    useEffect(() => {
        let cancelled = false

        const loadIfActive = async (options?: { force?: boolean }) => {
            if (cancelled) return
            await loadPanelData(options)
        }

        void loadIfActive()

        const handlePromptsChanged = () => {
            if (cancelled) return
            void loadIfActive({ force: true })
        }

        window.addEventListener(PROMPTS_CHANGED_EVENT, handlePromptsChanged)
        window.addEventListener(MODEL_GROUPS_CHANGED_EVENT, handlePromptsChanged)

        return () => {
            cancelled = true
            window.removeEventListener(PROMPTS_CHANGED_EVENT, handlePromptsChanged)
            window.removeEventListener(MODEL_GROUPS_CHANGED_EVENT, handlePromptsChanged)
        }
    }, [loadPanelData])

    const chapters = useMemo(
        () =>
            buildChaptersForScenePromptPreview({
                novelId,
                chapterId,
                chapterTitle,
                scenes,
                localEdits,
                novelData,
            }),
        [chapterId, chapterTitle, localEdits, novelData, novelId, scenes]
    )

    const termEntriesById = useMemo(() => new Map(termEntries.map((entry) => [entry.id, entry])), [termEntries])
    const detectedTermIds = useMemo(() => findMentionedTermIds(draft, termMentionMatcher), [draft, termMentionMatcher])
    const instructionTermIds = useMemo(() => [...detectedTermIds], [detectedTermIds])
    const handleTermMentionClick = useCallback((termId: string, anchorEl: HTMLElement) => {
        setMentionPreview((prev) => {
            if (prev?.termId === termId && prev.anchorEl === anchorEl) return null
            return { termId, anchorEl }
        })
    }, [])

    const mentionPreviewEntry = useMemo(() => {
        if (!mentionPreview) return null
        return termEntriesById.get(mentionPreview.termId) ?? null
    }, [mentionPreview, termEntriesById])

    const defaultSelection = (defaults?.scene_continuation ?? null) as PromptDefaultSelection | null
    const defaultPrompt =
        defaultSelection?.promptId && Array.isArray(prompts)
            ? prompts.find((prompt) => prompt.id === defaultSelection.promptId) ?? null
            : null

    const selectedPrompt = useMemo(() => {
        if (!Array.isArray(prompts) || prompts.length === 0) return null
        if (promptSelection.type === 'default') {
            return defaultPrompt ?? prompts[0] ?? null
        }
        return prompts.find((prompt) => prompt.id === promptSelection.promptId) ?? defaultPrompt ?? prompts[0] ?? null
    }, [defaultPrompt, promptSelection, prompts])

    const isUsingDefaultPrompt = promptSelection.type === 'default' && !!defaultPrompt
    const otherPrompts = useMemo(() => {
        if (!Array.isArray(prompts)) return []
        const excludedIds = new Set<string>()
        if (defaultSelection?.promptId) excludedIds.add(defaultSelection.promptId)
        if (promptSelection.type === 'prompt') excludedIds.add(promptSelection.promptId)
        return prompts.filter((prompt) => !excludedIds.has(prompt.id))
    }, [defaultSelection?.promptId, promptSelection, prompts])

    const promptName = lockedSnapshot?.promptName ?? selectedPrompt?.name ?? ''
    const promptGroups = useMemo(() => lockedSnapshot
        ? lockedSnapshot.modelGroupIds.flatMap((id) => groups?.find((group) => group.id === id) ?? [])
        : getPromptGroups(selectedPrompt, groups), [groups, lockedSnapshot, selectedPrompt])
    const runnableGroups = useMemo(
        () => promptGroups.filter((group) => getAvailableModelAssignments(group).length > 0),
        [promptGroups]
    )
    const selectedGroup = useMemo(
        () => lockedSnapshot ? promptGroups[0] ?? null :
            runnableGroups.find((group) => group.id === selectedGroupId) ??
            runnableGroups[0] ??
            promptGroups.find((group) => group.id === selectedGroupId) ??
            promptGroups[0] ??
            null,
        [lockedSnapshot, promptGroups, runnableGroups, selectedGroupId]
    )

    useEffect(() => {
        if (!selectedPrompt || lockedSnapshot) return
        if (promptGroups.some((group) => group.id === selectedGroupId)) return
        setSelectedGroupId(runnableGroups[0]?.id ?? promptGroups[0]?.id ?? '')
    }, [lockedSnapshot, promptGroups, runnableGroups, selectedGroupId, selectedPrompt])

    const previewStateStorageKey = useMemo(
        () => (selectedPrompt ? `${storageKey}.preview.${selectedPrompt.id}` : null),
        [selectedPrompt, storageKey]
    )
    const lockedPreviewState = useMemo(() => {
        if (!lockedSnapshot) return undefined
        const state: PersistedInputsEditorPreviewState = {
            customPreviewStateByInputId: {}, contentSelectionPreviewStateByInputId: {}, checkboxPreviewCheckedByInputId: {},
            previewSceneIdOverride: sceneId,
        }
        for (const input of lockedSnapshot.inputDefinitions) {
            const value = lockedSnapshot.inputValues[input.name]
            if (value?.kind === 'custom') state.customPreviewStateByInputId![input.id] = value
            else if (value?.kind === 'content_selection') state.contentSelectionPreviewStateByInputId![input.id] = value
            else if (value?.kind === 'checkbox') state.checkboxPreviewCheckedByInputId![input.id] = value.checked
        }
        return state
    }, [lockedSnapshot, sceneId])
    const instructionText = lockedSnapshot?.instruction ?? draft.trim()
    const model = useInputsEditorModel({
        inputDefinitions: lockedSnapshot?.inputDefinitions ?? selectedPrompt?.inputs ?? [],
        disabled: generating || isLocked,
        onInputDefinitionsChange: () => undefined,
        messages: lockedSnapshot ? [] : selectedPrompt?.messages ?? [],
        promptId: selectedPrompt?.id,
        promptCategory: String(selectedPrompt?.category ?? 'scene_continuation'),
        allPrompts: componentPrompts ?? undefined,
        novelId,
        chapters,
        sceneContinuationPanelId: panelId ?? null,
        previewStateStorageKey: lockedSnapshot ? null : previewStateStorageKey,
        persistedPreviewState: lockedPreviewState,
        instructionTerms: instructionTermIds,
        instructionText,
    })

    // Depend on the stable `setPreviewSceneId` callback, NOT the whole `model` object.
    // `useInputsEditorModel` returns a fresh object literal every render, so `[model, ...]`
    // re-runs this effect on every render — and because the effect itself calls setState,
    // that turns into a setState→render→setState feedback loop ("Maximum update depth exceeded").
    const { setPreviewSceneId } = model
    useEffect(() => {
        setPreviewSceneId(sceneId)
    }, [setPreviewSceneId, sceneId])

    const renderedMessages = useMemo(
        () =>
            model.renderedMessages
                .map((message) => ({ role: message.role, content: message.content }))
                .filter((message) => message.content.trim()),
        [model.renderedMessages]
    )

    const previewModel = useMemo(() => {
        if (!lockedSnapshot) return { ...model, renderedMessages: model.renderedMessages.filter((message) => message.content.trim()) }
        return {
            ...model,
            renderedMessages: lockedSnapshot.messages.map((message, index) => ({ ...message, id: `snapshot-${index}` })),
            renderedWarnings: [],
            missingRequiredInputNames: lockedSnapshot.missingInputs,
            renderedTermEntries: lockedSnapshot.termIds.flatMap((id) => termEntriesById.get(id) ?? []),
        }
    }, [lockedSnapshot, model, termEntriesById])

    const previewSourceId = useMemo(
        () => `scene-continuation:${sceneId}:${panelId ?? 'panel'}:${lockedSnapshot?.promptId ?? selectedPrompt?.id ?? 'loading'}`,
        [lockedSnapshot?.promptId, panelId, sceneId, selectedPrompt?.id]
    )

    const previewTitle = useMemo(
        () => promptName.trim() || tPrompts('categories.sceneContinuation'),
        [promptName, tPrompts]
    )

    useEffect(() => {
        updateInfoPanelPreview({
            kind: 'prompt_render',
            sourceId: previewSourceId,
            title: previewTitle,
            model: previewModel,
        })
    }, [previewModel, previewSourceId, previewTitle, updateInfoPanelPreview])

    useEffect(() => {
        if (resultText === lastSyncedOutputTextRef.current) return
        lastSyncedOutputTextRef.current = resultText
        const parsed = parseStructuredContinuationOutput(resultText)
        const nextPlanning = parsed.planning
        const nextContent = parsed.content || (!parsed.planning ? parsed.rawText : '')
        setPlanningDraft(nextPlanning)
        setContentDraft(nextContent)
    }, [resultText])

    // The continuation draft (content/planning) is shared with any linked Codex session, so it
    // lives in the DB rather than localStorage. Track the last value seen from/written to the DB
    // to avoid a save↔load echo.
    const lastDbDraftRef = useRef<{ content: string; planning: string } | null>(null)
    const draftSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

    const buildSnapshot = useCallback((): ContinuationPromptSnapshot => ({
        promptId: selectedPrompt?.id ?? '', promptName: selectedPrompt?.name ?? '', instruction: instructionText,
        inputs: continuationInputsFromValues(model.previewInputs, model.inputValues),
        inputDefinitions: model.previewInputs, inputValues: model.inputValues,
        termIds: model.renderedTermEntries.map((entry) => entry.id), messages: renderedMessages,
        modelGroupIds: selectedGroup ? [selectedGroup.id, ...(selectedPrompt?.modelGroupIds ?? []).filter((id) => id !== selectedGroup.id)] : selectedPrompt?.modelGroupIds ?? [],
        missingInputs: model.missingRequiredInputNames,
    }), [selectedPrompt, instructionText, model.inputValues, model.previewInputs, model.renderedTermEntries, renderedMessages, selectedGroup, model.missingRequiredInputNames])

    useEffect(() => {
        if (!panelId || !novelId) return
        let cancelled = false
        continuationDraftApi
            .get(panelId)
            .then((res) => {
                if (cancelled) return
                setDraftLoaded(true)
                if (res.draft) {
                    setCodexSessionId(res.draft.codexSessionId)
                    savedSnapshotRef.current = res.draft.promptSnapshotJson
                    snapshotRef.current = res.draft.promptSnapshotJson ? JSON.parse(res.draft.promptSnapshotJson) : null
                    setLockedSnapshot(res.draft.codexSessionId ? snapshotRef.current : null)
                    lastDbDraftRef.current = { content: res.draft.content, planning: res.draft.planning }
                    setContentDraft(res.draft.content)
                    setPlanningDraft(res.draft.planning)
                    lastSyncedOutputTextRef.current = res.draft.content
                }
            })
            .catch((error) => { setRunError(String(error)) })
        return () => {
            cancelled = true
        }
    }, [panelId, novelId])

    const saveDraft = useCallback(async () => {
        if (!panelId || !novelId || !draftLoaded || discardingRef.current) return
        const snapshotJson = JSON.stringify(snapshotRef.current ?? buildSnapshot())
        const last = lastDbDraftRef.current
        if (last?.content === contentDraft && last.planning === planningDraft && savedSnapshotRef.current === snapshotJson) return
        if (draftSaveTimerRef.current) clearTimeout(draftSaveTimerRef.current)
        await continuationDraftApi.save(panelId, {
            novelId, sceneId, chapterId, content: contentDraft, planning: planningDraft, updatedBy: 'user',
            ...(!codexSessionId ? { promptSnapshotJson: snapshotJson } : {}),
        })
        savedSnapshotRef.current = snapshotJson
        lastDbDraftRef.current = { content: contentDraft, planning: planningDraft }
    }, [panelId, novelId, sceneId, chapterId, contentDraft, planningDraft, buildSnapshot, codexSessionId, draftLoaded])
    const saveDraftRef = useRef(saveDraft)
    saveDraftRef.current = saveDraft
    useEffect(() => {
        if (!panelId) return
        return registerContinuationPanelSave(panelId, () => saveDraftRef.current())
    }, [panelId])
    useEffect(() => {
        if (!draftLoaded) return
        const last = lastDbDraftRef.current
        if (last?.content === contentDraft && last.planning === planningDraft) return
        if (!last && !contentDraft.trim() && !planningDraft.trim()) return
        draftSaveTimerRef.current = setTimeout(() => {
            void saveDraftRef.current().catch((error) => setRunError(String(error)))
        }, 800)
        return () => { if (draftSaveTimerRef.current) clearTimeout(draftSaveTimerRef.current) }
    }, [contentDraft, planningDraft, draftLoaded])
    useEffect(() => () => { void saveDraftRef.current().catch(console.error) }, [])

    // Pull Codex's draft writes into the panel. A value differing from what we last saw in the DB
    // is an external (Codex) change, so we apply it.
    const applyExternalDraft = useCallback(async () => {
        if (!panelId) return
        try {
            const res = await continuationDraftApi.get(panelId)
            if (!res.draft) return
            setCodexSessionId(res.draft.codexSessionId)
            if (!res.draft.codexSessionId) setLockedSnapshot(null)
            const last = lastDbDraftRef.current
            if (!last || res.draft.content !== last.content || res.draft.planning !== last.planning) {
                lastDbDraftRef.current = { content: res.draft.content, planning: res.draft.planning }
                setContentDraft(res.draft.content)
                setPlanningDraft(res.draft.planning)
                lastSyncedOutputTextRef.current = res.draft.content
            }
        } catch {
            // Ignore transient failures.
        }
    }, [panelId])

    // Codex writes the draft inside a session turn (via set_continuation_draft), so the turn
    // finishing is the signal to refresh — no polling. We watch the linked session's run state
    // and refetch once whenever it flips (the flip to idle delivers the result). When the session
    // sits idle there is nothing to fetch, so the panel makes no background requests.
    const sessionRunning = useEditorCodexStore((state) => {
        if (!codexSessionId || !novelId) return false
        const sessions = state.sessionsByNovel[novelId]?.sessions
        return sessions?.find((session) => session.id === codexSessionId)?.status === 'running'
    })

    const linkedSessionExists = useEditorCodexStore((state) => Boolean(state.sessionsByNovel[novelId ?? '']?.sessions.some((session) => session.id === codexSessionId)))
    useEffect(() => {
        if (!codexSessionId) return
        void applyExternalDraft()
    }, [codexSessionId, sessionRunning, linkedSessionExists, applyExternalDraft])

    const ready = !!selectedPrompt && groups !== null && componentPrompts !== null && Boolean(selectedGroup)
    const promptDisabledReason = getPromptRunDisabledReason(selectedPrompt, groups)
    const missingRequired = previewModel.missingRequiredInputNames.length > 0
    const canGenerate =
        ready &&
        !generating &&
        !isLocked &&
        !missingRequired &&
        !promptDisabledReason &&
        Boolean(selectedGroup) &&
        getAvailableModelAssignments(selectedGroup).length > 0 &&
        renderedMessages.length > 0
    const showTerminateButton = generating || generateAbortRef.current !== null || Boolean(resultText.trim()) || Boolean(reasoningText.trim())
    const showWriteActions = !generating && Boolean(contentDraft.trim())
    const runHint = lockedSnapshot ? '' : missingRequired
        ? tPrompts('advanced.preview.missingRequiredBadge', {
              names: previewModel.missingRequiredInputNames.join(', '),
          })
        : promptDisabledReason
          ? tSceneOperation(`disabledReasons.${promptDisabledReason}`)
          : ''

    const handleGenerate = useCallback(async () => {
        if (!canGenerate || !selectedPrompt || !selectedGroup) return

        generateAbortRef.current?.abort()
        const controller = new AbortController()
        generateAbortRef.current = controller

        snapshotRef.current = buildSnapshot()
        setGenerating(true)
        setRunError(null)
        setOutputPromptId(selectedPrompt.id)
        setResultText('')
        setReasoningText('')
        setContentDraft('')
        setPlanningDraft('')
        lastSyncedOutputTextRef.current = ''

        try {
            const result = await runModelGroupWithFallback({
                group: selectedGroup,
                input: {
                    sessionId: `continuation:${sceneId}:${panelId ?? 'panel'}`,
                    temperature: selectedGroup.settings.temperature ?? undefined,
                    maxTokens: selectedGroup.settings.maxTokens ?? undefined,
                    messages: renderedMessages,
                },
                signal: controller.signal,
                onTextDelta: (delta) => {
                    setResultText((current) => `${current}${delta}`)
                },
                onReasoningDelta: (delta) => {
                    setReasoningText((current) => `${current}${delta}`)
                },
            })

            if (controller.signal.aborted || generateAbortRef.current !== controller) return
            setResultText(result.text ?? '')
            setReasoningText(result.reasoningText ?? '')
        } catch (error) {
            if (!isAbortError(error)) {
                console.error('Failed to run scene continuation prompt:', error)
                setRunError(error instanceof Error ? error.message : String(error))
            }
        } finally {
            if (generateAbortRef.current === controller) {
                generateAbortRef.current = null
            }
            setGenerating(false)
        }
    }, [canGenerate, renderedMessages, selectedGroup, selectedPrompt, buildSnapshot, sceneId, panelId])

    const handleTerminate = useCallback(() => {
        generateAbortRef.current?.abort()
        generateAbortRef.current = null
        setGenerating(false)
        setRunError(null)
        setResultText('')
        setReasoningText('')
        setContentDraft('')
        setPlanningDraft('')
        setOutputPromptId(null)
        lastSyncedOutputTextRef.current = ''
    }, [])

    // Discard the panel only after its shared draft and paired Codex session are safely removed.
    const closeAndCleanup = useCallback(() => {
        discardingRef.current = true
        if (draftSaveTimerRef.current) clearTimeout(draftSaveTimerRef.current)
        generateAbortRef.current?.abort()
        if (!panelId) {
            onClose()
            return
        }
        void continuationDraftApi
            .delete(panelId)
            .then((result) => {
                if (result.deletedCodexSessionId) {
                    useEditorCodexStore.getState().removeDeletedSession(novelId, result.deletedCodexSessionId)
                }
                onClose()
            })
            .catch((error) => {
                discardingRef.current = false
                console.error('Failed to delete continuation draft:', error)
                setRunError(error instanceof Error ? error.message : String(error))
            })
    }, [novelId, onClose, panelId])

    const handleWrite = useCallback(() => {
        if (!contentDraft.trim()) return
        onApplyContinuation(sceneId, contentDraft)
    }, [contentDraft, onApplyContinuation, sceneId])

    const handleWriteAndClose = useCallback(() => {
        if (!contentDraft.trim()) return
        onApplyContinuation(sceneId, contentDraft)
        closeAndCleanup()
    }, [closeAndCleanup, contentDraft, onApplyContinuation, sceneId])

    const handlePreview = useCallback(() => {
        if (!selectedPrompt && !lockedSnapshot) return
        onOpenRightSidebar?.()
        showInfoPanelPreview({
            kind: 'prompt_render',
            sourceId: previewSourceId,
            title: previewTitle,
            model: previewModel,
        })
    }, [lockedSnapshot, onOpenRightSidebar, previewModel, previewSourceId, previewTitle, selectedPrompt, showInfoPanelPreview])

    const continuationLabel = useMemo(() => {
        const chapterPart = chapterTitle?.trim() || tPrompts('categories.sceneContinuation')
        return `${chapterPart} · ${tPrompts('categories.sceneContinuation')}`
    }, [chapterTitle, tPrompts])

    const handleSendToCodex = useCallback(async () => {
        if (!panelId || !novelId || !selectedPrompt || isLocked || generating) return
        setSending(true)
        setSendError(null)
        try {
            snapshotRef.current = buildSnapshot()
            await saveDraft()
            const sessionId = await useEditorCodexStore.getState().createSceneContinuationSession(novelId, {
                panelId, title: continuationLabel,
            })
            if (sessionId) {
                setCodexSessionId(sessionId)
                setLockedSnapshot(snapshotRef.current)
                useEditorCodexStore.getState().selectSession(novelId, sessionId)
                onOpenRightSidebar?.()
                useInfoPanelStore.getState().setActiveTab('codex')
            }
        } catch (error) {
            setSendError(error instanceof Error ? error.message : String(error))
        } finally { setSending(false) }
    }, [panelId, novelId, selectedPrompt, isLocked, generating, buildSnapshot, saveDraft, continuationLabel, onOpenRightSidebar])

    const handleOpenSession = useCallback(() => {
        if (!codexSessionId) return
        onOpenRightSidebar?.()
        useInfoPanelStore.getState().setActiveTab('codex')
        useEditorCodexStore.getState().selectSession(novelId, codexSessionId)
    }, [codexSessionId, novelId, onOpenRightSidebar])

    return (
        <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
            <div className="grid grid-cols-[1fr_auto_1fr] items-start gap-4 p-3 pb-2">
                <div className="min-w-0 space-y-1">
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <PenLine className="h-4 w-4" />
                        <span className="font-medium">
                            {tPrompts('categories.sceneContinuation')}
                        </span>
                    </div>
                    {loadError && <div className="text-xs text-destructive truncate">{loadError}</div>}
                    {runError && <div className="text-xs text-destructive truncate">{runError}</div>}
                </div>

                <div />

                <div className="shrink-0 flex items-center justify-end gap-1">
                    <Button type="button" variant="ghost" size="sm" className="gap-2" onClick={handlePreview} disabled={!lockedSnapshot && !selectedPrompt}>
                        <Eye className="h-4 w-4" />
                        {tEditor('infoPanel.tabs.preview')}
                    </Button>
                    <Button type="button" variant="ghost" size="sm" className="gap-2" onClick={() => setCollapsed((prev) => !prev)}>
                        <EyeOff className="h-4 w-4" />
                        {collapsed ? tCommon('show') : tCommon('hide')}
                    </Button>
                    <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-destructive hover:text-destructive"
                        onClick={closeAndCleanup}
                        aria-label={tCommon('delete')}
                        title={tCommon('delete')}
                    >
                        <Trash2 className="h-4 w-4" />
                    </Button>
                </div>
            </div>

            {!collapsed && (
                <div className={cn('px-3 pb-3 space-y-4', isLocked && 'opacity-70')}>
                    <TermMentionsHighlightTextarea
                        value={lockedSnapshot?.instruction ?? draft}
                        onChange={(event) => setDraft(event.target.value)}
                        matcher={termMentionMatcher}
                        onTermMentionClick={handleTermMentionClick}
                        readOnly={isLocked}
                        placeholder={tEditor('scene.continueStory')}
                        className="min-h-[96px] resize-none"
                        overlayClassName="w-full rounded-md border border-transparent px-3 py-2 text-base md:text-sm"
                        textareaClassName={cn(
                            'border-input placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50',
                            'aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40',
                            'aria-invalid:border-destructive dark:bg-input/30 flex field-sizing-content w-full rounded-md border',
                            'px-3 py-2 text-base shadow-xs transition-[color,box-shadow] outline-none focus-visible:ring-[3px]',
                            'disabled:cursor-not-allowed disabled:opacity-50 md:text-sm overflow-hidden resize-none'
                        )}
                    />
                    {previewModel.renderedTermEntries.length > 0 && (
                        <div className="mt-2 pt-2 border-t border-dashed border-muted-foreground/30">
                            <div className="flex flex-wrap gap-1 px-1">
                                {previewModel.renderedTermEntries.map((entry) => {
                                    const colorId = getTermEntryColorId(entry.color)
                                    const colorClasses = getTermEntryColorClasses(colorId)
                                    const hasCustomColor = colorId !== 'black'

                                    return (
                                        <Badge
                                            key={entry.id}
                                            variant="outline"
                                            className={cn(
                                                'gap-1 font-medium',
                                                colorClasses.subtleBg,
                                                colorClasses.subtleBorder,
                                                entry.archived && 'opacity-60'
                                            )}
                                        >
                                            <span className={cn('leading-none', hasCustomColor && colorClasses.text)}>
                                                {entry.title}
                                            </span>
                                        </Badge>
                                    )
                                })}
                            </div>
                        </div>
                    )}

                    {(lockedSnapshot || selectedPrompt) ? (
                        <div className="rounded-md border bg-card p-4 space-y-3">
                            {model.previewInputs.length === 0 ? (
                                <div className="rounded-md border bg-muted/20 px-3 py-6 text-sm text-muted-foreground text-center">
                                    {tPrompts('advanced.inputs.empty')}
                                </div>
                            ) : (
                                <PreviewInputList model={previewModel} />
                            )}
                        </div>
                    ) : (
                        <div className="rounded-md border bg-muted/20 px-3 py-6 text-sm text-muted-foreground text-center">
                            {prompts === null ? tPrompts('status.loading') : tPrompts('library.empty')}
                        </div>
                    )}

                </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-2.5 px-3 py-2.5 border-t bg-muted/10">
                <div className="flex flex-1 flex-wrap items-center gap-2 min-w-0">
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <button
                                type="button"
                                disabled={generating || isLocked}
                                className={cn(
                                    'flex items-center gap-2 rounded-lg border bg-background px-3 py-1.5 text-left',
                                    'flex-1 min-w-0 max-w-[22rem]',
                                    'hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40'
                                )}
                            >
                                <div className="min-w-0 flex-1">
                                    <div className="truncate text-sm font-medium flex items-center gap-2">
                                        {isUsingDefaultPrompt && <Heart className="h-4 w-4 text-muted-foreground" />}
                                        <span className="truncate">{promptName.trim() || tPrompts('status.loading')}</span>
                                    </div>
                                    <div className="truncate text-xs text-muted-foreground">
                                        {promptGroups.length} {tSceneOperation('modelGroups')}
                                    </div>
                                </div>
                                <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
                            </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start" className="min-w-[20rem]">
                            <DropdownMenuItem
                                disabled={!defaultPrompt}
                                className={cn('items-start py-2', isUsingDefaultPrompt && 'bg-muted')}
                                onSelect={() => setPromptSelection({ type: 'default' })}
                            >
                                <div className="flex flex-col gap-0.5">
                                    <div className="flex items-center gap-2">
                                        <Heart className="h-4 w-4 text-muted-foreground" />
                                        <span className="truncate">{tEditor('scene.useDefaultPrompt')}</span>
                                    </div>
                                    <div className="pl-6 text-xs text-muted-foreground">
                                        {defaultPrompt?.name?.trim() || tPrompts('defaults.none')}
                                    </div>
                                </div>
                            </DropdownMenuItem>

                            <DropdownMenuSeparator />

                            {prompts === null ? (
                                <DropdownMenuItem disabled>{tPrompts('status.loading')}</DropdownMenuItem>
                            ) : (
                                <>
                                    {promptSelection.type === 'prompt' && selectedPrompt && (
                                        <DropdownMenuItem
                                            key={`selected:${selectedPrompt.id}`}
                                            className="bg-muted"
                                            onSelect={() => setPromptSelection({ type: 'prompt', promptId: selectedPrompt.id })}
                                        >
                                            {selectedPrompt.name}
                                        </DropdownMenuItem>
                                    )}

                                    {promptSelection.type === 'prompt' && selectedPrompt && otherPrompts.length > 0 && <DropdownMenuSeparator />}

                                    {otherPrompts.length === 0 ? (
                                        promptSelection.type === 'prompt' && selectedPrompt ? null : (
                                            <DropdownMenuItem disabled>{tPrompts('library.empty')}</DropdownMenuItem>
                                        )
                                    ) : (
                                        otherPrompts.map((prompt) => {
                                            const disabledReason = getPromptRunDisabledReason(prompt, groups)
                                            return (
                                                <DropdownMenuItem
                                                    key={prompt.id}
                                                    className={cn('items-start', disabledReason && 'text-muted-foreground')}
                                                    onSelect={() => setPromptSelection({ type: 'prompt', promptId: prompt.id })}
                                                >
                                                    <span className="flex min-w-0 flex-col gap-0.5">
                                                        <span className="truncate">{prompt.name}</span>
                                                        {disabledReason && (
                                                            <span className="text-xs text-muted-foreground">
                                                                {tSceneOperation(`disabledReasons.${disabledReason}`)}
                                                            </span>
                                                        )}
                                                    </span>
                                                </DropdownMenuItem>
                                            )
                                        })
                                    )}
                                </>
                            )}
                        </DropdownMenuContent>
                    </DropdownMenu>

                </div>

                <div className="flex items-center gap-2 shrink-0">
                    <Button type="button" variant="outline" disabled={!draftLoaded || sending || generating || (!codexSessionId && !selectedPrompt)} onClick={codexSessionId ? handleOpenSession : () => void handleSendToCodex()} className="h-11 gap-2">
                        <Sparkles className="h-4 w-4" />
                        {codexSessionId ? tEditor('sceneContinuation.openSession') : tEditor('sceneContinuation.sendToCodex')}
                    </Button>
                    {showTerminateButton && !codexSessionId && (
                        <Button type="button" variant="outline" onClick={handleTerminate} className="h-11">
                            {tSceneOperation('terminate')}
                        </Button>
                    )}
                    <Button
                        type="button"
                        disabled={!canGenerate}
                        onClick={() => void handleGenerate()}
                        className="min-w-[8rem] shrink-0 gap-2 h-11"
                    >
                        {generating && <Loader2 className="h-4 w-4 animate-spin" />}
                        {contentDraft.trim() ? tEditor('sceneContinuation.retry') : tCommon('generate')}
                    </Button>
                </div>
            </div>

            {sendError && <div className="px-3 text-sm text-destructive">{sendError}</div>}
            {(runHint || promptGroups.length > 0) && (
                <div className="px-3 pt-1.5 pb-2 space-y-1.5">
                    {runHint ? <div className="text-xs text-muted-foreground">{runHint}</div> : null}
                    {promptGroups.length > 0 && (
                        <div className="rounded-lg border bg-muted/20 px-3 py-2 space-y-1.5">
                            <div className="text-sm font-medium">{tSceneOperation('runModelGroups')}</div>
                            <div className="space-y-1">
                                <div className="text-sm font-medium">{promptName.trim() || tPrompts('status.loading')}</div>
                                <div className="flex flex-wrap gap-1.5">
                                    {promptGroups.map((group) => {
                                        const isSelected = selectedGroup?.id === group.id
                                        const availableAssignments = getAvailableModelAssignments(group)
                                        const disabled = generating || isLocked || availableAssignments.length === 0
                                        return (
                                            <Button
                                                key={group.id}
                                                type="button"
                                                size="sm"
                                                variant={isSelected ? 'default' : 'outline'}
                                                disabled={disabled}
                                                className="gap-2 h-9 px-3"
                                                onClick={() => setSelectedGroupId(group.id)}
                                            >
                                                {isSelected && <Check className="h-4 w-4" />}
                                                <ModelGroupLogoIcon
                                                    group={group}
                                                    fallbackLabel={group.name}
                                                    className="h-5 w-5 rounded-md"
                                                    imageClassName="h-5 w-5"
                                                />
                                                <span>{group.name}</span>
                                                {availableAssignments.length === 0 && (
                                                    <span className="text-[11px] opacity-80">{tSceneOperation('noAssignments')}</span>
                                                )}
                                            </Button>
                                        )
                                    })}
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            )}

            {(resultText.trim() || reasoningText.trim() || generating || contentDraft.trim() || planningDraft.trim()) && (
                <div className="px-3 pb-3 space-y-3">
                    <SceneContinuationStructuredOutput
                        content={contentDraft}
                        planning={planningDraft}
                        reasoning={reasoningText}
                        promptName={promptName.trim() || tPrompts('categories.sceneContinuation')}
                        onContentChange={setContentDraft}
                        onPlanningChange={setPlanningDraft}
                    />
                    <div className="flex flex-wrap items-center justify-end gap-2">
                        {showWriteActions ? (
                            <>
                                <Button type="button" variant="outline" onClick={handleWrite} disabled={!contentDraft.trim()}>
                                    {tSceneOperation('write')}
                                </Button>
                                <Button type="button" onClick={handleWriteAndClose} disabled={!contentDraft.trim()}>
                                    {tSceneOperation('writeAndClose')}
                                </Button>
                            </>
                        ) : null}
                    </div>
                </div>
            )}

            <TermMentionPreviewPopover
                novelId={novelId}
                open={Boolean(mentionPreviewEntry && mentionPreview)}
                anchorEl={mentionPreview?.anchorEl ?? null}
                entry={mentionPreviewEntry}
                onClose={() => setMentionPreview(null)}
            />
        </div>
    )
}
