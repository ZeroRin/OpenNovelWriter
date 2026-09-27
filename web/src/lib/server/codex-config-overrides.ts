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
