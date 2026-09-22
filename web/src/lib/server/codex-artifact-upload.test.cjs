const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')
const ts = require('typescript')
const { createJiti } = require('jiti')
const src = path.resolve(__dirname, '../..')
const jiti = createJiti(__filename, { alias: { '@': src } })

function route(name, mocks) {
    const source = fs.readFileSync(path.join(src, `app/api/codex/sessions/[id]/${name}/route.ts`), 'utf8')
    const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText
    const module = { exports: {} }
    new Function('require', 'module', 'exports', code)((id) => Object.hasOwn(mocks, id) ? mocks[id] : id.startsWith('@/') ? jiti(id) : require(id), module, module.exports)
    return module.exports.POST
}

test('document uploads preserve bytes, names, drafts, and history within the owning session', async (t) => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'onw-documents-'))
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }))
    let user = { userId: 'owner' }
    let exists = true
    const mocks = {
        '@/lib/auth': { getCurrentUser: async () => user },
        '@/lib/db': { getPrismaClient: () => ({ codexSession: { findFirst: async ({ where }) => {
            assert.deepEqual(where, { id: 'session', ownerId: 'owner' })
            return exists ? { id: 'session', status: 'running' } : null
        } } }) },
        '@/lib/server/codex-session-workspace': { getCodexSessionWorkspacePath: (owner, id) => {
            assert.equal(owner, 'owner'); assert.equal(id, 'session'); return workspace
        } },
    }
    const post = route('artifacts', mocks)
    const params = { params: Promise.resolve({ id: 'session' }) }
    const upload = (name, bytes) => {
        const form = new FormData()
        form.set('file', new File([bytes], name))
        return post(new Request('http://localhost/artifacts', { method: 'POST', body: form }), params)
    }
    const { parseCodexDraftArtifacts, parseCodexSessionMessages } = jiti('./codex-session.ts')
    const artifacts = []
    for (const [name, bytes] of [
        ['University Form.PDF', Buffer.from('%PDF-1.7\n\x00\xff', 'latin1')],
        ['说明.txt', Buffer.from('Reference text\n')],
        ['notes.md', Buffer.from('# Reference\n')],
        ['form.doc', Buffer.from([0xd0, 0xcf, 0x11, 0xe0])],
        ['form.docx', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 255])],
        ['preset.json', Buffer.from('{"messages":[]}')],
    ]) {
        const response = await upload(name, bytes)
        assert.equal(response.status, 200, await response.clone().text())
        const { artifact } = await response.json()
        assert.equal(artifact.originalName, name)
        assert.deepEqual(fs.readFileSync(path.join(workspace, 'artifacts', artifact.fileName)), bytes)
        artifacts.push(artifact)
    }
    assert.deepEqual(parseCodexDraftArtifacts(JSON.stringify(artifacts)), artifacts)
    const files = artifacts.map((artifact) => artifact.fileName)
    assert.deepEqual(parseCodexSessionMessages(JSON.stringify([{ id: 'message', role: 'user', content: '', jsonArtifacts: files }]))[0].jsonArtifacts, files)
    const duplicate = await (await upload('University Form.PDF', 'second file')).json()
    assert.equal(duplicate.artifact.fileName, 'University-Form-2.pdf')
    assert.equal((await upload('script.js', 'alert(1)')).status, 400)
    assert.equal((await upload('bad.json', '{')).status, 400)
    assert.equal((await upload('empty.txt', '')).status, 400)
    assert.equal((await upload('large.pdf', new Uint8Array(20 * 1024 * 1024 + 1))).status, 400)
    exists = false
    assert.equal((await upload('private.pdf', 'private')).status, 404)
    user = null
    assert.equal((await upload('private.pdf', 'private')).status, 401)

    user = { userId: 'owner' }; exists = true
    const calls = []
    const steer = route('steer', { ...mocks, '@/lib/server/codex-app-server': { steerActiveCodexRun: async (input) => calls.push(input) } })
    const send = (artifactFiles) => steer(new Request('http://localhost/steer', { method: 'POST', body: JSON.stringify({ content: '', artifactFiles }) }), params)
    assert.equal((await send(files)).status, 200)
    assert.deepEqual(calls[0].artifactFiles, files)
    for (const invalid of [['../outside.pdf'], ['missing.pdf'], ['form.docx', 'form.docx'], 'form.docx']) {
        assert.equal((await send(invalid)).status, 400)
    }
    fs.symlinkSync(path.join(workspace, 'artifacts', files[0]), path.join(workspace, 'artifacts', 'link.pdf'))
    assert.equal((await send(['link.pdf'])).status, 400)
    assert.equal(calls.length, 1)
})
