import fs from 'fs/promises'
import path from 'path'

import { getOpenNovelWriterDataDir } from '@/lib/server/data-dir'
import { ensureNovelWorkspace, writeReadonlyProjectionFile } from '@/lib/server/novel-workspace'
import { ensureManagedFileSymlink } from '@/lib/server/managed-symlink'
import { getUserAgentsRoot, listAgents } from '@/lib/server/agent-storage'

const AGENTS_FILE_NAME = 'AGENTS.md'
const NOVEL_CONTEXT_DIR_NAME = 'novel'

export function getCodexSessionWorkspacesRoot() {
    return path.join(getOpenNovelWriterDataDir(), 'codex', 'sessions')
}

export function getCodexSessionWorkspacePath(ownerId: string, sessionId: string) {
    return path.join(getCodexSessionWorkspacesRoot(), ownerId, sessionId)
}

export async function ensureCodexSessionWorkspace(input: {
    ownerId: string
    novelId: string
    sessionId: string
}) {
    const sessionPath = getCodexSessionWorkspacePath(input.ownerId, input.sessionId)
    const novelContextPath = path.join(sessionPath, NOVEL_CONTEXT_DIR_NAME)
    const novelWorkspacePath = await ensureNovelWorkspace(input.ownerId, input.novelId)

    await fs.mkdir(path.join(sessionPath, 'artifacts'), { recursive: true })
    await fs.rm(novelContextPath, { recursive: true, force: true })
    await fs.mkdir(novelContextPath, { recursive: true })

    await Promise.all([
        linkNovelMarkdownContext(novelWorkspacePath, novelContextPath),
        writeSessionAgentsFile(sessionPath, input.ownerId),
    ])

    return sessionPath
}

export async function deleteCodexSessionWorkspace(ownerId: string, sessionId: string) {
    await fs.rm(getCodexSessionWorkspacePath(ownerId, sessionId), {
        recursive: true,
        force: true,
    })
}

async function linkNovelMarkdownContext(novelWorkspacePath: string, novelContextPath: string) {
    await syncMarkdownTree(novelWorkspacePath, novelContextPath, novelWorkspacePath)
}

async function syncMarkdownTree(sourceRoot: string, destinationRoot: string, managedSourceRoot: string) {
    const entries = await fs.readdir(sourceRoot, { withFileTypes: true }).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw error
    })

    await Promise.all(entries.map(async (entry) => {
        if (entry.name === AGENTS_FILE_NAME) return

        const source = path.join(sourceRoot, entry.name)
        const destination = path.join(destinationRoot, entry.name)

        if (entry.isDirectory()) {
            await fs.mkdir(destination, { recursive: true })
            await syncMarkdownTree(source, destination, managedSourceRoot)
            return
        }

        if ((!entry.isFile() && !entry.isSymbolicLink()) || !entry.name.endsWith('.md')) return
        await ensureManagedFileSymlink({
            source,
            destination,
            managedSourceRoot,
        })
    }))
}

async function writeSessionAgentsFile(sessionPath: string, ownerId: string) {
    const userAgentContent = await readEnabledUserAgentContent(ownerId)
    const parts = [
        '# OpenNovelWriter Codex 会话',
        '',
        '- `novel/terms/<file>.md` 按词条标题命名，重名时加数字后缀；`novel/snippet.md` 是片段索引，正文在 `novel/snippets/<snippet_id>.md`。',
        '- `novel/materials/<material_id>.md` 是导入的参考资料，可能包含整本小说。仅在用户明确引用该资料 ID 时读取，否则不要列举、搜索或读取 `novel/materials/`。',
        '- 用户引用词条、片段或参考资料时，回复前先完整读取指定文件；交给 `run_llm` 使用时，将相关内容写入其会话文件。',
        '- 工具输入和生成结果放在 `artifacts/`。图片引用 `[标签](image:<manifest-path>#<optional-item-id>)` 指向其中的清单文件，读取清单后使用指定图片文件。',
        '- 保存 `run_llm` 回复时，支持 `source` 的工具应直接使用 `source: { mdPath, index }`；`index` 选择 assistant 回复，默认 `-1` 表示最新一条。需要修改回复时先编辑该文件。',
        '- 续写面板附件包含已组装的写作会话，以及记录输入、缺失项和绑定模型组的 JSON 快照。写作会话已含提示词上下文；Codex 聊天请求与写作会话分开。',
        '- `[位置](continuation:chapterId:sceneId:panelId)` 指向续写草稿。修改前用 `get_continuation_draft` 导出最新草稿，文件含一个 `## assistant` 段；编辑后用 `set_continuation_draft` 的 `source: { mdPath }` 回写面板，由作者决定何时插入正文。',
        '- 通过 `/skill-name` 调用的用户 Skill 会以 `$skill` 指令注入当前轮次，直接遵循即可；即使未出现在 `skills/list` 中，也不要再查找本地目录。',
    ]

    const normalizedUserAgent = userAgentContent.trim()
    if (normalizedUserAgent) {
        parts.push('', '## 用户 Agent 指令', '', normalizedUserAgent)
    }

    await writeReadonlyProjectionFile(path.join(sessionPath, AGENTS_FILE_NAME), `${parts.join('\n')}\n`)
}

async function readEnabledUserAgentContent(ownerId: string) {
    const enabledAgent = (await listAgents(ownerId)).find((agent) => agent.enabled)
    if (!enabledAgent) return ''

    return fs.readFile(path.join(getUserAgentsRoot(ownerId), enabledAgent.id, AGENTS_FILE_NAME), 'utf8').catch((error) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
        throw error
    })
}
