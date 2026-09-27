import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
    detectCherryStudioModelTypes,
    inferCherryStudioProviderId,
    isImageGenerationModel,
    resolveCherryStudioIcon,
} from './index'

test('recognizes vision, reasoning, and tools for newly catalogued chat models', () => {
    for (const modelId of [
        'gpt-6-astra',
        'gpt-6-sol',
        'gpt-6-luna',
        'claude-opus-5.5',
        'deepseek-v4.1-flash',
        'qwen3.8-flash',
        'mimo-v2.6-pro',
    ]) {
        assert.deepEqual(detectCherryStudioModelTypes({ modelId }), {
            vision: true,
            reasoning: true,
            tool: true,
            reranker: false,
            embedding: false,
        }, modelId)
    }
})

test('preserves model size when resolving namespaced and tagged model ids', () => {
    for (const modelId of ['nvidia/nemotron-nano-9b-v2', 'nemotron-nano:9b-v2']) {
        assert.deepEqual(detectCherryStudioModelTypes({ modelId }), {
            vision: false,
            reasoning: true,
            tool: true,
            reranker: false,
            embedding: false,
        }, modelId)
    }

    for (const providerId of [undefined, 'nvidia']) {
        const unknownSize = detectCherryStudioModelTypes({ modelId: 'qwen3.5-999b', providerId })
        assert.equal(unknownSize.vision, false)
        assert.equal(unknownSize.tool, false)
    }
})

test('keeps CherryIN regular and free model capabilities distinct', () => {
    const regular = detectCherryStudioModelTypes({ modelId: 'qwen/qwen3.5-9b', providerId: 'cherryin' })
    const free = detectCherryStudioModelTypes({ modelId: 'qwen/qwen3.5-9b(free)', providerId: 'cherryin' })

    assert.equal(regular.vision, true)
    assert.equal(regular.reasoning, true)
    assert.equal(regular.tool, true)
    assert.equal(free.vision, true)
    assert.equal(free.reasoning, false)
    assert.equal(free.tool, false)
})

test('recognizes GPT Image 2.5 variants from the model catalog', () => {
    assert.equal(isImageGenerationModel({ modelId: 'gpt-image-2.5-sunburst' }), true)
    assert.equal(isImageGenerationModel({ modelId: 'openai/gpt-image-2.5-flare' }), true)
    assert.equal(isImageGenerationModel({ modelId: 'gpt-6-astra' }), false)
})

test('classifies Qwen3 rerankers as reranker only', () => {
    assert.deepEqual(detectCherryStudioModelTypes({ modelId: 'Qwen/Qwen3-Reranker-8B' }), {
        vision: false,
        reasoning: false,
        tool: false,
        reranker: true,
        embedding: false,
    })
})

test('keeps embedding and reranker classifications mutually exclusive', () => {
    const embedding = detectCherryStudioModelTypes({ modelId: 'text-embedding-3-small' })
    const reranker = detectCherryStudioModelTypes({ modelId: 'bge-reranker-v2-m3' })

    assert.equal(embedding.embedding, true)
    assert.equal(embedding.reranker, false)
    assert.equal(reranker.reranker, true)
    assert.equal(reranker.embedding, false)
})

test('only infers reasoning for uncatalogued model ids', () => {
    assert.deepEqual(detectCherryStudioModelTypes({ modelId: 'custom-thinking-model' }), {
        vision: false,
        reasoning: true,
        tool: false,
        reranker: false,
        embedding: false,
    })
    assert.deepEqual(detectCherryStudioModelTypes({ modelId: 'custom-chat-model' }), {
        vision: false,
        reasoning: false,
        tool: false,
        reranker: false,
        embedding: false,
    })
})

test('uses provider registry base URLs and latest icon routing', () => {
    const providerId = inferCherryStudioProviderId({
        baseUrl: 'https://api.siliconflow.cn/v1',
        providerType: 'openai-chat',
    })

    assert.equal(providerId, 'silicon')
    assert.equal(inferCherryStudioProviderId({ baseUrl: 'https://api.moonshot.ai/v1' }), 'moonshot-global')
    assert.equal(inferCherryStudioProviderId({ baseUrl: 'http://localhost:8000/v1' }), 'omlx')
    assert.deepEqual(resolveCherryStudioIcon('gpt-5.4-mini', providerId), {
        kind: 'model',
        key: 'gpt-5-4-mini',
    })
    assert.deepEqual(resolveCherryStudioIcon('k3', providerId), {
        kind: 'model',
        key: 'kimi',
    })
    assert.notEqual(resolveCherryStudioIcon('taiwan-llm', providerId)?.key, 'qwen')
})
