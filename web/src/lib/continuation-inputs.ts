import { z } from 'zod'
import type { ContinuationInputs } from '@/lib/continuation-prompt'

const id = z.string().trim().min(1)
const reference = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('full_novel') }).strict(),
    z.object({ kind: z.literal('act'), actNumber: z.number().int() }).strict(),
    z.object({ kind: z.literal('act_outline'), actNumber: z.number().int() }).strict(),
    z.object({ kind: z.literal('chapter'), chapterId: id }).strict(),
    z.object({ kind: z.literal('chapter_outline'), chapterId: id }).strict(),
    z.object({ kind: z.literal('scene'), sceneId: id }).strict(),
    z.object({ kind: z.literal('snippet'), snippetId: id }).strict(),
    z.object({ kind: z.literal('term'), termId: id }).strict(),
    z.object({ kind: z.literal('label'), labelId: id }).strict(),
    z.object({ kind: z.literal('term_tag'), tag: id }).strict(),
])
const schema = z.object({
    custom: z.record(id, z.object({
        dropdownOptionIds: z.array(id).default([]),
        text: z.string().default(''),
    }).strict()).optional(),
    checkbox: z.record(id, z.boolean()).optional(),
    contentSelection: z.record(id, z.array(reference)).optional(),
}).strict()

export function parseContinuationInputs(value: unknown): ContinuationInputs {
    return schema.parse(value ?? {})
}
