import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createPreviewTranslation } from './translation.ts'

function memory() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    },
    values,
  }
}

test('mock validation requires complete fields, protects duplicate submissions, and never stores credentials', async () => {
  const storage = memory()
  const backend = createPreviewTranslation(storage, 'a', 'translation-settings')
  assert.equal(await backend.verify('deepl', {}), false)
  assert.equal(backend.snapshot().services.deepl, 'unconfigured')
  const first = backend.verify('deepl', { apiKey: 'DEMO-NOT-A-REAL-KEY' })
  assert.equal(backend.snapshot().services.deepl, 'pending')
  assert.equal(await backend.verify('deepl', { apiKey: 'duplicate' }), false)
  assert.equal(await first, true)
  assert.equal(backend.snapshot().services.deepl, 'configured')
  assert.equal(
    [...storage.values.values()].some((value) => value.includes('DEMO-NOT-A-REAL-KEY')),
    false
  )
  backend.invalidate('deepl')
  assert.equal(backend.snapshot().services.deepl, 'unconfigured')
})

test('mock installation is single-flight and failed packages never become usable', async () => {
  const backend = createPreviewTranslation(memory(), 'a', 'translation-installation-failed')
  const first = backend.install('fr')
  assert.equal(backend.snapshot().packages.fr, 'installing')
  assert.equal(await backend.install('fr'), false)
  assert.equal(await first, false)
  assert.equal(backend.snapshot().packages.fr, 'failed')
  assert.equal(await backend.install('fr'), false)
  assert.equal(backend.snapshot().packages.fr, 'failed')
})

test('mock success persists within one instance but not another instance or reset scene', async () => {
  const storage = memory()
  const backend = createPreviewTranslation(storage, 'a', 'translation-settings')
  backend.update({ selectionAutomatic: true, toolbar: false })
  assert.equal(await backend.install('ja'), true)
  const reloaded = createPreviewTranslation(storage, 'a', 'translation-settings')
  assert.equal(reloaded.snapshot().selectionAutomatic, true)
  assert.equal(reloaded.snapshot().toolbar, false)
  assert.equal(reloaded.snapshot().packages.ja, 'installed')
  assert.equal(
    createPreviewTranslation(storage, 'b', 'translation-settings').snapshot().packages.ja,
    'missing'
  )
  assert.equal(
    createPreviewTranslation(storage, 'a', 'other-scene').snapshot().packages.ja,
    'missing'
  )
  assert.equal(
    createPreviewTranslation(storage, 'a', 'translation-settings', 'new-generation').snapshot()
      .packages.ja,
    'missing'
  )
})

test('mock failed validation remains failed until an explicitly different policy is selected', async () => {
  const backend = createPreviewTranslation(memory(), 'a', 'translation-verification-failed')
  assert.equal(await backend.verify('deepl', { apiKey: 'demo' }), false)
  assert.equal(backend.snapshot().services.deepl, 'failed')
  assert.equal(await backend.verify('deepl', { apiKey: 'demo' }), false)
})

test('cancelled or invalid-direction translation cannot produce a mock result', async () => {
  const backend = createPreviewTranslation(memory(), 'a', 'translation-settings')
  const controller = new AbortController()
  const pending = backend.translate(
    { engine: 'offline', source: 'en', target: 'zh-CN' },
    'source',
    controller.signal
  )
  controller.abort()
  await assert.rejects(pending, { name: 'AbortError' })
  await assert.rejects(
    backend.translate(
      { engine: 'offline', source: 'auto', target: 'fr' },
      'source',
      new AbortController().signal
    )
  )
})
