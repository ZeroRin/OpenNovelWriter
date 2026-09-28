function toToml(value: unknown): string {
    if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
        return JSON.stringify(value)
    }
    if (Array.isArray(value)) return `[${value.map(toToml).join(', ')}]`
    if (value && typeof value === 'object') {
        return `{${Object.entries(value).map(([key, entry]) => `${JSON.stringify(key)} = ${toToml(entry)}`).join(', ')}}`
    }
    throw new Error('Unsupported Codex configuration value.')
}

export function codexConfigOverrideArgs(config: Record<string, unknown>) {
    return Object.entries(config).flatMap(([key, value]) => ['-c', `${key}=${toToml(value)}`])
}

/**
 * Quote one argument for a `cmd.exe` command line, using the MSVCRT rules Node itself applies to
 * non-shell Windows spawns.
 *
 * Windows resolves `codex` through the npm `.cmd` shim, which forces `shell: true`; with a shell Node
 * only concatenates the argument array and escapes nothing (DEP0190), so `cmd.exe` re-splits any
 * value containing a space. `-c` values are TOML and routinely contain both spaces and quotes —
 * `skills.config=[{"path" = "C:\\...\\SKILL.md", "enabled" = true}]` — so without this every Codex
 * session on Windows dies at argument parsing with "unexpected argument '...SKILL.md,' found".
 */
export function quoteWindowsShellArgument(argument: string) {
    if (argument !== '' && !/[\s"]/.test(argument)) return argument

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
