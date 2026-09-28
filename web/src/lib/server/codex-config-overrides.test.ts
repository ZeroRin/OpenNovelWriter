import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import {
    codexConfigOverrideArgs,
    quoteWindowsShellArgument,
    resolveCodexLaunch,
    windowsCommandLine,
} from './codex-config-overrides'

const SKILL_PATH = 'C:\\Users\\John Doe\\skills\\预设-场景续写\\SKILL.md'

/** A `fileExists` stand-in that only knows the listed paths. */
function existingFiles(files: string[]) {
    return (file: string) => files.includes(file)
}

// ── Override encoding ───────────────────────────────────────────────────────────────────────

test('overrides stay one -c argument per entry and carry no double quote', () => {
    const args = codexConfigOverrideArgs({
        'skills.config': [{ path: SKILL_PATH, enabled: true }],
        'model_providers.opennovelwriter.http_headers': { 'x-opencode-session': 'abc123' },
    })

    assert.deepEqual(args, [
        '-c',
        `skills.config=[{path = '${SKILL_PATH}', enabled = true}]`,
        '-c',
        `model_providers.opennovelwriter.http_headers={x-opencode-session = 'abc123'}`,
    ])
    // A double quote is what would make cmd.exe lose track of its quoting on the fallback path.
    assert.equal(args.some((argument) => argument.includes('"')), false)
})

test('a value containing an apostrophe still avoids a double quote', () => {
    const args = codexConfigOverrideArgs({
        'skills.config': [{ path: "D:\\O'Brien & Co\\SKILL.md", enabled: true }],
    })

    assert.deepEqual(args, ['-c', `skills.config=[{path = '''D:\\O'Brien & Co\\SKILL.md''', enabled = true}]`])
    assert.equal(args[1].includes('"'), false)
})

test('every argument is quoted for the shell fallback, including ones with no space or quote', () => {
    assert.equal(quoteWindowsShellArgument('app-server'), '"app-server"')
    assert.equal(quoteWindowsShellArgument('-c'), '"-c"')
    assert.equal(quoteWindowsShellArgument('a b'), '"a b"')
    assert.equal(quoteWindowsShellArgument('say "hi"'), '"say \\"hi\\""')
    assert.equal(quoteWindowsShellArgument('C:\\dir\\'), '"C:\\dir\\\\"')
    assert.equal(quoteWindowsShellArgument(''), '""')
    // cmd.exe would swallow a caret in a bare argument even though it holds no space or quote.
    assert.equal(quoteWindowsShellArgument('C:\\a^b\\S.md'), '"C:\\a^b\\S.md"')
})

test('the fallback command line quotes the command itself and every argument', () => {
    assert.equal(windowsCommandLine(['codex', 'resources', 'list']), '"codex" "resources" "list"')
})

// ── Choosing how to launch the CLI ──────────────────────────────────────────────────────────

test('other platforms spawn the CLI directly', () => {
    assert.deepEqual(resolveCodexLaunch({ platform: 'linux', env: { PATH: '/usr/bin' } }), {
        command: 'codex',
        args: [],
        shell: false,
    })
})

test('a native codex executable is spawned without a shell', () => {
    const launch = resolveCodexLaunch({
        platform: 'win32',
        env: { PATH: 'C:\\tools;C:\\npm' },
        fileExists: existingFiles(['C:\\tools\\codex.exe']),
    })

    assert.deepEqual(launch, { command: 'C:\\tools\\codex.exe', args: [], shell: false })
})

test('the npm shim is resolved to the script it forwards to, so no shell is needed', () => {
    const npmBin = 'C:\\Users\\me\\AppData\\Roaming\\npm'
    const launch = resolveCodexLaunch({
        platform: 'win32',
        env: { PATH: 'C:\\Windows;C:\\Windows\\System32;' + npmBin },
        fileExists: existingFiles([
            npmBin + '\\codex.cmd',
            npmBin + '\\node_modules\\@openai\\codex\\bin\\codex.js',
        ]),
        nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    })

    assert.deepEqual(launch, {
        command: 'C:\\Program Files\\nodejs\\node.exe',
        args: [npmBin + '\\node_modules\\@openai\\codex\\bin\\codex.js'],
        shell: false,
    })
})

test('a shim whose target is not where npm puts it falls back to the shell', () => {
    const launch = resolveCodexLaunch({
        platform: 'win32',
        env: { PATH: 'C:\\somewhere' },
        fileExists: existingFiles(['C:\\somewhere\\codex.cmd']),
    })

    assert.deepEqual(launch, { command: 'codex', args: [], shell: true })
})

test('an empty PATH falls back to the shell on Windows', () => {
    assert.deepEqual(resolveCodexLaunch({ platform: 'win32', env: {}, fileExists: () => false }), {
        command: 'codex',
        args: [],
        shell: true,
    })
})

// ── The two paths, end to end ───────────────────────────────────────────────────────────────

/**
 * A shell-less launch hands the argument array straight to the child, so this is the fidelity the
 * overrides rely on in production.
 */
test('a shell-less launch passes every argument through untouched', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'onw-codex-noshell-'))
    const outputFile = path.join(directory, 'argv.json')
    const helper = path.join(directory, 'echo-argv.cjs')

    try {
        fs.writeFileSync(
            helper,
            'require("node:fs").writeFileSync(process.env.ONW_ARGV_OUT, JSON.stringify(process.argv.slice(2)))\n'
        )
        const args = codexConfigOverrideArgs({
            'skills.config': [{ path: "D:\\A & B (draft) O'Brien ^! 笔记\\skills\\预设-场景续写\\SKILL.md", enabled: true }],
            'model_providers.opennovelwriter.http_headers': { 'x-opencode-session': 'cmtvmwz8g000hiovn0423v9yy' },
        })

        const result = spawnSync(process.execPath, [helper, ...args], {
            shell: false,
            stdio: 'ignore',
            timeout: 30_000,
            env: { ...process.env, ONW_ARGV_OUT: outputFile },
        })

        assert.equal(result.status, 0)
        assert.equal(fs.readFileSync(outputFile, 'utf8'), JSON.stringify(args))
    } finally {
        fs.rmSync(directory, { recursive: true, force: true })
    }
})

/**
 * The shell fallback resolves `codex` through the npm `.cmd` shim, so its value is parsed by cmd.exe
 * and then parsed again when the shim forwards it with `%*`. This builds that chain — the shim is a
 * batch file forwarding to a helper, exactly like the installed `codex.cmd` — and compares the argv
 * the child actually receives against the argv the caller intended.
 */
test(
    'the shell fallback keeps arguments intact through cmd.exe and an npm-style .cmd shim',
    { skip: process.platform === 'win32' ? false : 'Windows only' },
    () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'onw-codex-args-'))
        const outputFile = path.join(directory, 'argv.json')
        const helper = 'echo-argv.cjs'
        const shim = path.join(directory, 'codex-probe.cmd')

        try {
            // The child reports through a file rather than stdout, so the assertion does not depend on
            // how the parent captures stdio.
            fs.writeFileSync(
                path.join(directory, helper),
                'require("node:fs").writeFileSync(process.env.ONW_ARGV_OUT, JSON.stringify(process.argv.slice(2)))\n'
            )
            fs.writeFileSync(shim, `@ECHO off\r\nnode "%~dp0${helper}" %*\r\n`)

            const skillPaths = [
                'C:\\Users\\John Doe\\AppData\\Roaming\\OpenNovelWriter\\skills\\owner\\SKILL.md',
                'D:\\A & B\\OpenNovelWriter\\skills\\预设-场景续写\\SKILL.md',
                'D:\\A&B\\skills\\SKILL.md',
                'D:\\a^b\\skills\\SKILL.md',
                "D:\\O'Brien & Co\\skills\\SKILL.md",
                'D:\\Notes (draft) & final\\skills\\SKILL.md',
                'C:\\用户\\skills\\预设-场景续写\\SKILL.md',
                "D:\\A & B (draft) O'Brien ^! 笔记\\skills\\SKILL.md",
            ]

            for (const skillPath of skillPaths) {
                const args = codexConfigOverrideArgs({
                    'skills.config': [{ path: skillPath, enabled: true }],
                    'model_providers.opennovelwriter.http_headers': { 'x-opencode-session': 'cmtvmwz8g000hiovn0423v9yy' },
                })

                fs.rmSync(outputFile, { force: true })
                const result = spawnSync(windowsCommandLine([shim, ...args, 'app-server']), {
                    shell: true,
                    stdio: 'ignore',
                    timeout: 30_000,
                    env: { ...process.env, ONW_ARGV_OUT: outputFile },
                })

                assert.equal(result.status, 0, `the shim did not run for ${skillPath}`)
                assert.equal(
                    fs.readFileSync(outputFile, 'utf8'),
                    JSON.stringify([...args, 'app-server']),
                    `an argument was altered for ${skillPath}`
                )
            }
        } finally {
            fs.rmSync(directory, { recursive: true, force: true })
        }
    }
)
