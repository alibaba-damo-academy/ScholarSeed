import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { translationRequest, type TranslationRequest } from '../../../../translation.ts'
import { automaticSelection } from './model.ts'

test('selection preferences use the host translation bridge without provider fields', () => {
  assert.deepEqual(
    translationRequest({ operation: 'preferences', preferences: { selectionAutomatic: true } }),
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ selectionAutomatic: true }),
    }
  )
})

test('live selection preferences restore, retain the child choice and surface failures', async () => {
  const desktop = fileURLToPath(new URL('../../../../../', import.meta.url))
  const directory = mkdtempSync(join(desktop, 'node_modules/.translation-preferences-'))
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
    const { createLiveTranslation } = await import(pathToFileURL(output).href)
    let stored = { toolbar: true, selectionAutomatic: false }
    let fail = false
    const calls: TranslationRequest[] = []
    const send = async (request: TranslationRequest) => {
      calls.push(request)
      if (fail) return { status: 503, body: JSON.stringify({ detail: 'storage' }) }
      if (request.operation === 'preferences') stored = { ...stored, ...request.preferences }
      return { status: 200, body: JSON.stringify({ services: {}, preferences: stored }) }
    }
    const backend = createLiveTranslation(send)
    assert.equal(backend.snapshot().preferencesReady, false)
    assert.equal(automaticSelection(backend.snapshot()), false)
    const firstLoad = backend.load()
    assert.equal(backend.load(), firstLoad)
    await firstLoad
    assert.equal(backend.snapshot().preferencesReady, true)
    assert.equal(backend.snapshot().selectionAutomatic, false)
    await backend.update({ selectionAutomatic: true })
    assert.equal(automaticSelection(backend.snapshot()), true)
    await backend.update({ toolbar: false })
    assert.equal(backend.snapshot().selectionAutomatic, true)
    assert.equal(automaticSelection(backend.snapshot()), false)
    const restored = createLiveTranslation(send)
    await restored.load()
    assert.equal(restored.snapshot().toolbar, false)
    assert.equal(restored.snapshot().selectionAutomatic, true)
    await restored.update({ toolbar: true })
    assert.equal(automaticSelection(restored.snapshot()), true)
    fail = true
    await restored.update({ selectionAutomatic: false })
    assert.equal(restored.snapshot().selectionAutomatic, true)
    assert.equal(restored.snapshot().preferencesError, 'storage')
    assert.equal(restored.snapshot().preferencesSaving, false)
    fail = false
    await restored.update({ selectionAutomatic: false })
    assert.equal(restored.snapshot().selectionAutomatic, false)
    assert.equal(restored.snapshot().preferencesError, undefined)
    const count = calls.length
    await restored.update({ focusService: 'deepl' })
    assert.equal(calls.length, count)
    fail = true
    const unavailable = createLiveTranslation(send)
    await unavailable.load()
    assert.equal(unavailable.snapshot().preferencesReady, false)
    assert.equal(unavailable.snapshot().preferencesError, 'storage')
    fail = false
    await unavailable.load()
    assert.equal(unavailable.snapshot().preferencesReady, true)
    await Promise.all([
      unavailable.update({ selectionAutomatic: true }),
      unavailable.update({ toolbar: false }),
      unavailable.update({ toolbar: true }),
    ])
    assert.deepEqual(stored, { toolbar: true, selectionAutomatic: true })
    assert.equal(automaticSelection(unavailable.snapshot()), true)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
