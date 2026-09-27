const panelSaves = new Map<string, () => Promise<void>>()

export function registerContinuationPanelSave(panelId: string, save: () => Promise<void>) {
    panelSaves.set(panelId, save)
    return () => { if (panelSaves.get(panelId) === save) panelSaves.delete(panelId) }
}

export async function flushContinuationPanel(panelId: string | null | undefined) {
    if (panelId) await panelSaves.get(panelId)?.()
}
