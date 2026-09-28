import assert from 'node:assert/strict'
import { test } from 'node:test'

import { codexConfigOverrideArgs, quoteWindowsShellArgument, windowsCommandLine } from './codex-config-overrides'

test('config overrides stay a single -c argument per entry', () => {
    const args = codexConfigOverrideArgs({
        'skills.config': [{ path: 'C:\\Users\\John Doe\\skills\\预设-场景续写\\SKILL.md', enabled: true }],
        'model_providers.opennovelwriter.http_headers': { 'x-opencode-session': 'abc123' },
    })

    assert.equal(args.length, 4)
    assert.deepEqual(args.filter((_, index) => index % 2 === 0), ['-c', '-c'])
    // The TOML carries spaces and double quotes, which is exactly what cmd.exe would re-split if the
    // argument were passed through a shell unquoted.
    assert.match(args[1], /^skills\.config=\[\{"path" = ".+SKILL\.md", "enabled" = true}]$/)
    assert.match(args[3], /^model_providers\.opennovelwriter\.http_headers=\{"x-opencode-session" = "abc123"}$/)
    assert.ok(args[1].includes(' '), 'the value must contain spaces for this test to be meaningful')
    assert.ok(args[1].includes('"'), 'the value must contain quotes for this test to be meaningful')
})

test('quoting matches the MSVCRT rules Node uses for Windows arguments', () => {
    assert.equal(quoteWindowsShellArgument('app-server'), 'app-server')
    assert.equal(quoteWindowsShellArgument('-c'), '-c')
    assert.equal(quoteWindowsShellArgument('C:\\dir\\'), 'C:\\dir\\')
    assert.equal(quoteWindowsShellArgument('a b'), '"a b"')
    assert.equal(quoteWindowsShellArgument('say "hi"'), '"say \\"hi\\""')
    assert.equal(quoteWindowsShellArgument(''), '""')
})

test('a quoted command line preserves every argument through cmd.exe', () => {
    const value = 'skills.config=[{"path" = "C:\\Users\\John Doe\\SKILL.md", "enabled" = true}]'
    const line = windowsCommandLine(['codex', '-c', value, 'app-server'])

    // Take the middle argument back out of the command line and undo the quoting: it has to be the
    // value we started with, otherwise cmd.exe would hand a different string to Codex.
    const quoted = line.slice('codex -c '.length, -' app-server'.length)
    assert.equal(line.startsWith('codex -c "'), true)
    assert.equal(line.endsWith('" app-server'), true)
    assert.equal(quoted[0], '"')
    assert.equal(quoted[quoted.length - 1], '"')
    assert.equal(quoted.slice(1, -1).replace(/\\"/g, '"'), value)
})
