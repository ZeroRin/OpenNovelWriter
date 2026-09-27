import path from 'node:path'

import { getPrismaClient } from '@/lib/db'
import { getSkillCategoryForSession, isSkillAvailableInSession } from '@/lib/skills'
import { getUserSkillsRoot, listSkills, readSkill } from '@/lib/server/skill-storage'

const prisma = getPrismaClient({ ensureModel: 'codexSession' })

export type CodexSkillReference = { id: string; name: string; path: string }

export class CodexSkillUnavailableError extends Error {}

export async function getCodexSessionSkillConfig(ownerId: string, sessionId: string) {
    const session = await prisma.codexSession.findFirstOrThrow({
        where: { id: sessionId, ownerId },
        select: { category: true },
    })
    if (!getSkillCategoryForSession(session.category)) {
        throw new Error('Unsupported Codex session category.')
    }
    const skills = await listSkills(ownerId)
    return {
        'skills.config': skills.map((skill) => ({
            path: path.join(getUserSkillsRoot(ownerId), skill.id, 'SKILL.md'),
            enabled: isSkillAvailableInSession(skill, session.category),
        })),
    }
}

export async function resolveCodexSessionSkillReferences(input: {
    ownerId: string
    sessionCategory: unknown
    content: string
    skillIds?: unknown
}): Promise<CodexSkillReference[]> {
    const ids = new Set([
        ...Array.from(input.content.matchAll(/\[[^\]]+\]\(skill:([^)]+)\)/g), (match) => match[1]),
        ...(Array.isArray(input.skillIds)
            ? input.skillIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
            : []),
    ])
    return Promise.all([...ids].map(async (id) => {
        const skill = await readSkill(input.ownerId, id).catch(() => null)
        if (!skill || !isSkillAvailableInSession(skill, input.sessionCategory)) {
            throw new CodexSkillUnavailableError(`Skill "${skill?.name ?? id}" is not available in this session.`)
        }
        return { id: skill.id, name: skill.name, path: path.join(getUserSkillsRoot(input.ownerId), skill.id, 'SKILL.md') }
    }))
}

export function rewriteCodexSkillReferences(content: string, refs: CodexSkillReference[]) {
    const names = new Map(refs.map((ref) => [ref.id, ref.name]))
    return content.replace(/\[[^\]]+\]\(skill:([^)]+)\)/g, (match, id: string) => {
        const name = names.get(id)
        return name ? `$${name}` : match
    })
}
