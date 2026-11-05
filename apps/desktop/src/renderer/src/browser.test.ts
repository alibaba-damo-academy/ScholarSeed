import assert from 'node:assert/strict'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import type { RendererPreferences } from '../../preferences.ts'

const storageKey = 'scholarseed.web.preferences'
const bundled = build({
  entryPoints: [fileURLToPath(new URL('./browser.ts', import.meta.url))],
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'iife',
})

test('Electron keeps its preload bridge without touching Web storage or locale signals', async () => {
  const result = await bundled
  const bridge = Object.freeze({ preferences: { language: 'en', theme: 'dark' } })
  const window = {
    scholarseed: bridge,
    get localStorage(): never {
      throw new Error('Electron must not read Web preferences')
    },
  }
  const navigator = {
    platform: 'MacIntel',
    languages: ['zh-CN'],
    language: 'zh-CN',
  }
  assert.doesNotThrow(() =>
    runInNewContext(result.outputFiles[0].text, { window, TextEncoder, navigator })
  )
  assert.doesNotThrow(() => runInNewContext(result.outputFiles[0].text, { window, TextEncoder }))
  assert.equal(window.scholarseed, bridge)
  assert.equal(window.scholarseed.preferences.language, 'en')
  assert.equal(window.scholarseed.preferences.theme, 'dark')
})

test('Web bridge preserves saved preferences, defaults and save/reconcile behavior', async () => {
  const result = await bundled
  for (const stored of [null, '{invalid', JSON.stringify({ language: 'en', theme: 'dark' })]) {
    const storage = new Map<string, string>()
    if (stored !== null) storage.set(storageKey, stored)
    const reads: string[] = []
    const window: {
      scholarseed?: {
        preferences: RendererPreferences
        getApiBase(): string
        savePreferences(value: RendererPreferences): Promise<RendererPreferences>
        reconcilePreferences(): Promise<RendererPreferences>
      }
      localStorage: {
        getItem(key: string): string | null
        setItem(key: string, value: string): void
      }
    } = {
      localStorage: {
        getItem(key) {
          reads.push(key)
          return storage.get(key) ?? null
        },
        setItem(key, value) {
          storage.set(key, value)
        },
      },
    }
    runInNewContext(result.outputFiles[0].text, {
      window,
      TextEncoder,
      navigator: { platform: 'browser', languages: ['zh-CN'], language: 'zh-CN' },
      Intl: { DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone: 'Asia/Shanghai' }) }) },
    })
    const bridge = window.scholarseed!
    assert.deepEqual(reads, [storageKey])
    assert.equal(bridge.getApiBase(), '')
    assert.equal(bridge.preferences.language, stored?.startsWith('{"') ? 'en' : 'zh')
    assert.equal(bridge.preferences.theme, stored?.startsWith('{"') ? 'dark' : 'light')
    const saved = await bridge.savePreferences({
      ...bridge.preferences,
      language: 'en',
      languageMode: undefined,
      theme: 'dark',
    })
    assert.equal(JSON.parse(storage.get(storageKey)!).theme, 'dark')
    const reconciled = await bridge.reconcilePreferences()
    assert.equal(reconciled.theme, saved.theme)
    assert.equal(reconciled.language, saved.language)
  }
})
