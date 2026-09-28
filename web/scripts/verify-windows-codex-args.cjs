/*
 * Manual verification for how `-c` overrides reach the Codex CLI (review aid).
 *
 * Run from web/:
 *   node scripts/verify-windows-codex-args.cjs
 *
 * Requires Node 24, or any Node started with --experimental-strip-types, because it imports the
 * TypeScript module directly.
 *
 * It reports which launch the current installation resolves to and then measures argument fidelity
 * on both paths:
 *
 *   - the shell-less launch, which is what production uses whenever the CLI can be resolved;
 *   - the cmd.exe + npm `.cmd` shim fallback, which applies only when the layout is not the npm one.
 *
 * The child reports the argv it actually received, which is compared against the argv that was
 * intended.
 */
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { codexConfigOverrideArgs, resolveCodexLaunch, windowsCommandLine } = require('../src/lib/server/codex-config-overrides.ts')

const launch = resolveCodexLaunch()
console.log(`node ${process.version} | platform ${process.platform}`)
console.log('resolved launch:', JSON.stringify(launch), '\n')

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'onw-verify-args-'))
const outputFile = path.join(directory, 'argv.json')
const helper = path.join(directory, 'echo-argv.cjs')
const shim = path.join(directory, 'codex-probe.cmd')
fs.writeFileSync(helper,
    'require("node:fs").writeFileSync(process.env.ONW_ARGV_OUT, JSON.stringify(process.argv.slice(2)))\n')
// Shaped like the installed codex.cmd: a batch file that forwards with %*, so the command line is
// parsed by cmd.exe and then parsed again inside the batch context.
fs.writeFileSync(shim, '@ECHO off\r\nnode "%~dp0echo-argv.cjs" %*\r\n')

const cases = {
    'plain': 'D:\\skills\\SKILL.md',
    'space (user name / data dir)': 'C:\\Users\\John Doe\\AppData\\Roaming\\ONW\\skills\\SKILL.md',
    'ampersand': 'D:\\A & B\\skills\\SKILL.md',
    'ampersand, no space': 'D:\\A&B\\skills\\SKILL.md',
    'caret': 'D:\\a^b\\skills\\SKILL.md',
    'apostrophe': "D:\\O'Brien & Co\\skills\\SKILL.md",
    'parentheses': 'D:\\Notes (draft) & final\\skills\\SKILL.md',
    'exclamation': 'D:\\a!b\\skills\\SKILL.md',
    'brackets / braces': 'D:\\a[b]c{d}\\skills\\SKILL.md',
    'punctuation': 'D:\\a+b=c;d,e#f$g@h~i\\skills\\SKILL.md',
    'chinese': 'C:\\用户\\skills\\预设-场景续写\\SKILL.md',
    'emoji': 'D:\\📁中文\\skills\\SKILL.md',
    'combined': "D:\\A & B (draft) O'Brien ^! 笔记\\skills\\预设-场景续写\\SKILL.md",
    'percent, unpaired': 'D:\\100%\\skills\\SKILL.md',
    'percent, undefined name': 'D:\\%ONW_NOT_DEFINED%\\skills\\SKILL.md',
    'percent, DEFINED name': 'D:\\%TEMP%\\skills\\SKILL.md',
}

function argsFor(skillPath) {
    return codexConfigOverrideArgs({
        'skills.config': [{ path: skillPath, enabled: true }],
        'model_providers.opennovelwriter.http_headers': { 'x-opencode-session': 'cmtvmwz8g000hiovn0423v9yy' },
    })
}

function measure(label, spawnFor) {
    const failures = []
    for (const [caseLabel, skillPath] of Object.entries(cases)) {
        const args = argsFor(skillPath)
        fs.rmSync(outputFile, { force: true })
        spawnFor(args)
        const received = fs.existsSync(outputFile) ? fs.readFileSync(outputFile, 'utf8') : ''
        if (received !== JSON.stringify([...args, 'app-server'])) failures.push(caseLabel)
    }
    const passed = Object.keys(cases).length - failures.length
    console.log(`== ${label}: ${passed}/${Object.keys(cases).length} passed ==`)
    if (failures.length) console.log(`   failed: ${failures.join(', ')}`)
    return failures
}

// The helper stands in for codex.js so the argv can be observed; the invocation has the same shape
// as production: node, then a script, then the CLI arguments.
measure('shell-less launch', (args) => {
    spawnSync(process.execPath, [helper, ...args, 'app-server'], {
        shell: false, stdio: 'ignore', timeout: 30_000,
        env: { ...process.env, ONW_ARGV_OUT: outputFile },
    })
})

const fallbackFailures = measure('cmd.exe + .cmd shim fallback', (args) => {
    spawnSync(windowsCommandLine([shim, ...args, 'app-server']), {
        shell: true, stdio: 'ignore', timeout: 30_000,
        env: { ...process.env, ONW_ARGV_OUT: outputFile },
    })
})
if (fallbackFailures.length) {
    console.log('   (the fallback cannot represent a %NAME% pair naming a defined environment')
    console.log('    variable: cmd.exe expands it even inside quotes, and offers no escape)')
}

// The real CLI, started the way production starts it, with a value that used to be split.
console.log('\n== real codex with the production launch ==')
const hostile = argsFor("D:\\A & B (draft) O'Brien ^! 笔记\\skills\\预设-场景续写\\SKILL.md")
const result = spawnSync(launch.command, [...launch.args, ...hostile, '--version'], {
    shell: launch.shell, stdio: 'inherit', timeout: 30_000,
})
console.log('exit:', result.status)

fs.rmSync(directory, { recursive: true, force: true })
