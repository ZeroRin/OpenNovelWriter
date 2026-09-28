/**
 * Getting a `-c` override to the Codex CLI intact.
 *
 * The value is TOML and would travel on a command line that cmd.exe parses, then parses again through
 * the npm shim's `%*`. cmd.exe reads every double quote as a delimiter — it does not treat the
 * backslash in `\"` as an escape — so embedded quotes flip its quoting state, and any value left
 * outside the quotes is subject to its metacharacter rules: an ampersand becomes a command separator,
 * a caret disappears. A `%NAME%` naming a defined environment variable is expanded even inside
 * quotes, and a cmd.exe command line has no escape for it, so no amount of quoting makes a
 * shell-based path fully safe.
 *
 * The command line is therefore avoided on Windows. `codex` is an npm `.cmd` shim there, and Node
 * refuses to spawn a batch file without a shell (EINVAL, since the fix for CVE-2024-27980), so the
 * shim is resolved to the program it launches and that program is spawned directly. Node hands an
 * argument array to a shell-less child untouched, so the overrides need no quoting at all. Only when
 * the installation does not match the npm layout does the shell stay in play, and then every argument
 * is quoted for it — which covers spaces, ampersands, carets, parentheses and non-ASCII paths, with
 * the `%NAME%` expansion above as the single remaining gap.
 */

import fs from 'node:fs'
import path from 'node:path'

const BARE_KEY = /^[A-Za-z0-9_-]+$/
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/

/**
 * Encode a string as TOML without introducing a double quote.
 *
 * A literal string carries the value verbatim and needs no escaping at all, which is also the correct
 * rendering for a Windows path (a basic string would have to double every backslash). The multi-line
 * form covers a value that itself contains an apostrophe, which is legal in a path.
 */
function toTomlString(value: string): string {
    if (!CONTROL_CHARACTER.test(value)) {
        if (!value.includes("'")) return `'${value}'`
        if (!value.includes("'''")) return `'''${value}'''`
    }
    // Not reachable for the paths and session ids passed here. A basic string is valid TOML, but it
    // re-introduces the double quote this encoding exists to avoid.
    return JSON.stringify(value)
}

function toTomlKey(key: string): string {
    return BARE_KEY.test(key) ? key : toTomlString(key)
}

function toToml(value: unknown): string {
    if (typeof value === 'string') return toTomlString(value)
    if (typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value)
    if (Array.isArray(value)) return `[${value.map(toToml).join(', ')}]`
    if (value && typeof value === 'object') {
        return `{${Object.entries(value).map(([key, entry]) => `${toTomlKey(key)} = ${toToml(entry)}`).join(', ')}}`
    }
    throw new Error('Unsupported Codex configuration value.')
}

export function codexConfigOverrideArgs(config: Record<string, unknown>) {
    return Object.entries(config).flatMap(([key, value]) => ['-c', `${key}=${toToml(value)}`])
}

/** Where the npm shim for `@openai/codex` keeps the script it launches. */
const NPM_SHIM_TARGET = ['node_modules', '@openai', 'codex', 'bin', 'codex.js']

export type CodexLaunch = {
    /** Program to start. */
    command: string
    /** Arguments that must precede the CLI's own, such as the resolved script path. */
    args: string[]
    /** Whether the command line goes through a shell, in which case every argument must be quoted. */
    shell: boolean
}

/**
 * Decide how to start the Codex CLI.
 *
 * Windows prefers a shell-less launch so the arguments are passed verbatim; the shell is kept only as
 * a fallback for installations whose layout is not the npm one. Every other platform already spawns
 * without a shell.
 */
export function resolveCodexLaunch(options: {
    platform?: NodeJS.Platform
    /** Only `PATH` is read, so the parameter stays assignable from `process.env`. */
    env?: { PATH?: string }
    fileExists?: (file: string) => boolean
    nodePath?: string
} = {}): CodexLaunch {
    const platform = options.platform ?? process.platform
    const env = options.env ?? process.env
    const fileExists = options.fileExists ?? fs.existsSync

    if (platform !== 'win32') return { command: 'codex', args: [], shell: false }

    const directories = (env.PATH ?? '').split(path.win32.delimiter).filter(Boolean)

    // A native install ships a real executable, which needs no shell either.
    for (const directory of directories) {
        const executable = path.win32.join(directory, 'codex.exe')
        if (fileExists(executable)) return { command: executable, args: [], shell: false }
    }

    // The npm shim is a batch file. Run the script it forwards to, under the same node that runs this
    // app, so the shim — and with it a second round of cmd.exe parsing — is skipped.
    const nodePath = options.nodePath ?? process.execPath
    for (const directory of directories) {
        const shimmed = ['codex.cmd', 'codex.bat'].some((name) => fileExists(path.win32.join(directory, name)))
        if (!shimmed) continue
        const entry = path.win32.join(directory, ...NPM_SHIM_TARGET)
        if (fileExists(entry)) return { command: nodePath, args: [entry], shell: false }
    }

    return { command: 'codex', args: [], shell: true }
}

/**
 * Quote one argument for a `cmd.exe` command line, using the MSVCRT rules Node applies to non-shell
 * Windows spawns: those are what the receiving program's parser expects.
 *
 * Every argument is quoted, never left bare, because cmd.exe honours its metacharacters in a bare
 * argument too — `skills.config=[{path = 'D:\a^b\SKILL.md', enabled = true}]` loses the caret even
 * though it contains neither a space nor a quote.
 */
export function quoteWindowsShellArgument(argument: string) {
    let quoted = '"'
    let backslashes = 0
    for (const character of argument) {
        if (character === '\\') {
            backslashes += 1
            continue
        }
        if (character === '"') {
            // Double the pending backslashes so the target sees them, then escape the quote itself.
            quoted += `${'\\'.repeat(backslashes * 2 + 1)}"`
            backslashes = 0
            continue
        }
        quoted += '\\'.repeat(backslashes) + character
        backslashes = 0
    }
    return `${quoted}${'\\'.repeat(backslashes * 2)}"`
}

/** Join a command and its arguments into one `cmd.exe` command line. */
export function windowsCommandLine(parts: string[]) {
    return parts.map((part) => quoteWindowsShellArgument(part)).join(' ')
}
