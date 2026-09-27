'use client'

import type { InputsEditorModel } from '@/components/editor/prompt-inputs-editor/model'
import { PreviewInputCard } from '@/components/editor/prompt-inputs-editor/preview-input-card'

export function PreviewInputList({ model }: { model: InputsEditorModel }) {
    const regularInputs = model.previewInputs.filter((input) => !input.collapsed)
    const collapsibleInputs = model.previewInputs.filter((input) => input.collapsed)

    return (
        <div className="min-w-0 space-y-2">
            {regularInputs.map((input) => (
                <PreviewInputCard key={input.id} input={input} model={model} />
            ))}
            {collapsibleInputs.length > 0 && (
                <div className="flex min-w-0 flex-wrap items-start gap-2">
                    {collapsibleInputs.map((input) => (
                        <PreviewInputCard key={input.id} input={input} model={model} />
                    ))}
                </div>
            )}
        </div>
    )
}
