import assert from 'node:assert/strict'
import { test } from 'node:test'

import { outlineApi } from './api'
import { NOVEL_OUTLINE_DATA_CHANGED_EVENT } from './novel-outline-events'
import { useAuthStore } from './store'

test('saving an outline notifies previews only after the saved content is available', async (t) => {
    const events = new EventTarget()
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
    Object.defineProperty(globalThis, 'window', { configurable: true, value: events })
    t.after(() => {
        if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
        else Reflect.deleteProperty(globalThis, 'window')
    })
    const state = useAuthStore.getState()
    t.mock.method(useAuthStore, 'getState', () => ({ ...state, token: 'test-token' }))

    const notifications: unknown[] = []
    events.addEventListener(NOVEL_OUTLINE_DATA_CHANGED_EVENT, (event) => {
        notifications.push((event as CustomEvent).detail)
    })
    let finishSave!: (response: Response) => void
    const response = new Promise<Response>((resolve) => { finishSave = resolve })
    t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
        assert.equal(url, '/api/outlines/outline-1')
        assert.equal(init?.method, 'PUT')
        assert.deepEqual(JSON.parse(String(init?.body)), { content: '<p>云依 这是细纲测试</p>' })
        return response
    })

    const pending = outlineApi.update('outline-1', { content: '<p>云依 这是细纲测试</p>' })
    assert.deepEqual(notifications, [])
    const saved = { id: 'outline-1', novelId: 'novel-1', content: '<p>云依 这是细纲测试</p>' }
    finishSave(Response.json(saved))
    assert.deepEqual(await pending, saved)
    assert.deepEqual(notifications, [{ novelId: 'novel-1' }])
})

test('a failed outline save does not notify previews', async (t) => {
    const events = new EventTarget()
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
    Object.defineProperty(globalThis, 'window', { configurable: true, value: events })
    t.after(() => {
        if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
        else Reflect.deleteProperty(globalThis, 'window')
    })
    const state = useAuthStore.getState()
    t.mock.method(useAuthStore, 'getState', () => ({ ...state, token: 'test-token' }))
    let notifications = 0
    events.addEventListener(NOVEL_OUTLINE_DATA_CHANGED_EVENT, () => { notifications += 1 })
    t.mock.method(globalThis, 'fetch', async () => Response.json({ detail: 'Save failed' }, { status: 500 }))

    await assert.rejects(outlineApi.update('outline-1', { content: 'new content' }), /Save failed/)
    assert.equal(notifications, 0)
})
