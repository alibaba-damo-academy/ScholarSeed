import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

test('live translation verifies before enabling, restores statuses and never falls back', async () => {
  const desktop = fileURLToPath(new URL('../../../../../', import.meta.url))
  const directory = mkdtempSync(join(desktop, 'node_modules/.translation-live-'))
  try {
    const output = join(directory, 'live.mjs')
    await build({
      entryPoints: [join(desktop, 'src/renderer/src/features/translation/live.tsx')],
      outfile: output,
      bundle: true,
      platform: 'node',
      format: 'esm',
      packages: 'external',
      jsx: 'automatic',
    })
    const { createLiveTranslation, translationError } = await import(pathToFileURL(output).href)
    const calls: Array<Record<string, unknown>> = []
    let verified = false
    let reject = false
    const send = async (request: Record<string, unknown>) => {
      calls.push(request)
      if (reject) return { status: 422, body: JSON.stringify({ detail: 'authentication' }) }
      if (request.operation === 'verify') verified = true
      if (request.operation === 'invalidate') verified = false
      return {
        status: 200,
        body: JSON.stringify(
          request.operation === 'translate'
            ? { text: '你好' }
            : {
                services: { deepl: verified ? 'configured' : 'unconfigured' },
                preferences: { toolbar: true, selectionAutomatic: false },
              }
        ),
      }
    }
    const backend = createLiveTranslation(send)
    await backend.load()
    assert.equal(backend.snapshot().services.deepl, 'unconfigured')
    assert.deepEqual(backend.snapshot().packages, {})
    const choice = { engine: 'deepl', source: 'en', target: 'zh-CN' }
    await assert.rejects(
      backend.translate(choice, 'Hello', new AbortController().signal),
      /direction/
    )
    assert.equal(calls.length, 1)
    reject = true
    await assert.rejects(backend.verify('deepl', { apiKey: 'invalid' }), /authentication/)
    assert.equal(backend.snapshot().services.deepl, 'failed')
    reject = false
    assert.equal(await backend.verify('deepl', { apiKey: 'unit-test-key' }), true)
    assert.equal(backend.snapshot().services.deepl, 'configured')
    assert.equal(JSON.stringify(backend.snapshot()).includes('unit-test-key'), false)
    const restored = createLiveTranslation(send)
    await restored.load()
    assert.equal(restored.snapshot().services.deepl, 'configured')
    assert.equal(await restored.translate(choice, 'Hello', new AbortController().signal), '你好')
    assert.deepEqual(calls.at(-1), {
      operation: 'translate',
      provider: 'deepl',
      text: 'Hello',
      source: 'en',
      target: 'zh-CN',
    })
    reject = true
    const before = calls.length
    await assert.rejects(
      restored.translate(choice, 'Hello', new AbortController().signal),
      /authentication/
    )
    assert.equal(calls.length, before + 1)
    assert.equal(translationError(new Error('secret key and upstream body')), 'network')
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(restored.translate(choice, 'Hello', controller.signal))
    assert.equal(calls.length, before + 1)
    reject = false
    let recovered = 0
    const limited = createLiveTranslation(async () => ({
      status: 429,
      body: JSON.stringify({ detail: 'rate_limited' }),
    }))
    await assert.rejects(limited.verify('deepl', { apiKey: 'test' }), /rate_limited/)
    assert.equal(translationError(new Error('rate_limited')), 'rate_limited')
    const retried = createLiveTranslation(async (request: Record<string, unknown>) => ({
      status: 200,
      body: JSON.stringify(
        request.operation === 'translate'
          ? { text: '你好', retries: 1 }
          : { services: { deepl: 'configured' }, retries: 2 }
      ),
    }))
    const onRecovered = () => {
      recovered += 1
    }
    await retried.verify('deepl', { apiKey: 'test' }, onRecovered)
    assert.equal(recovered, 1)
    assert.equal(
      await retried.translate(choice, 'Hello', new AbortController().signal, onRecovered),
      '你好'
    )
    assert.equal(recovered, 2)
    await assert.rejects(retried.translate(choice, 'Hello', controller.signal, onRecovered))
    assert.equal(recovered, 2)
    restored.invalidate('deepl')
    assert.equal(restored.snapshot().services.deepl, 'unconfigured')
    await restored.verify('deepl', { apiKey: 'replacement' })
    assert.equal(restored.snapshot().services.deepl, 'configured')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
