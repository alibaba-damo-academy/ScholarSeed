import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'
import { _electron } from '@playwright/test'
import type { RendererPreferences } from '../preferences.ts'

interface PreferenceFixture {
  ready: Promise<void>
  load(): RendererPreferences
  save(value: unknown): RendererPreferences
  automation(enabled: boolean): RendererPreferences
  corrupt(): void
  diagnostics: string[]
}

test('CDP preferences survive real file restarts and stale renderer saves cannot revive opt-out', { timeout: 30_000 }, async () => {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), 'browser-preferences-')))
  await mkdir(join(temporary, 'profile'))
  const entry = join(temporary, 'main.cjs')
  await copyFile(resolve('out/main/lease.node'), join(temporary, 'lease.node'))
  await build({
    stdin: { contents: `
      import { app, BrowserWindow } from 'electron'
      import { writeFileSync } from 'node:fs'
      import { join } from 'node:path'
      import { loadRendererPreferences, saveRendererPreferences, saveBrowserAutomationPreference } from './src/main/preferences.ts'
      import { PreferenceDiagnostics } from './src/preference-diagnostics.ts'
      import { selectStorage, publishStorage } from './src/main/storage.ts'
      app.setPath('userData', ${JSON.stringify(join(temporary, 'profile'))})
      const unexpectedPointer = () => { throw Error('Unexpected pointer') }
      publishStorage(selectStorage('preferences-probe', {
        pin: unexpectedPointer, readAt: unexpectedPointer, release: unexpectedPointer
      }))
      globalThis.ready = app.whenReady().then(() => { new BrowserWindow({ show: false }) })
      globalThis.load = loadRendererPreferences
      globalThis.diagnostics = []
      globalThis.save = (value) => saveRendererPreferences(value, new PreferenceDiagnostics('main', (line) => globalThis.diagnostics.push(line)))
      globalThis.automation = saveBrowserAutomationPreference
      globalThis.corrupt = () => writeFileSync(join(app.getPath('userData'), 'renderer-preferences.json'), '{invalid')
    `, resolveDir: resolve('.') },
    outfile: entry, platform: 'node', format: 'cjs', bundle: true,
    external: ['electron', './lease.node'],
  })
  const environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
  delete environment.ELECTRON_RUN_AS_NODE
  environment.SCHOLARSEED_HOME = join(temporary, 'home')
  let application: Awaited<ReturnType<typeof _electron.launch>> | null = null
  try {
    application = await _electron.launch({ args: [entry], env: environment })
    const first = await application.evaluate(async () => {
      const fixture = globalThis as unknown as PreferenceFixture
      await fixture.ready
      const initial = fixture.load()
      fixture.automation(false)
      const saved = fixture.save({ ...initial, theme: 'dark' })
      return { initial: initial.browserAutomationEnabled, enabled: saved.browserAutomationEnabled, theme: saved.theme }
    })
    assert.deepEqual(first, { initial: true, enabled: false, theme: 'dark' })
    await application.close()
    application = await _electron.launch({ args: [entry], env: environment })
    const restarted = await application.evaluate(async () => {
      const fixture = globalThis as unknown as PreferenceFixture
      await fixture.ready
      const restored = fixture.load()
      fixture.automation(true)
      return { enabled: restored.browserAutomationEnabled, theme: restored.theme }
    })
    assert.deepEqual(restarted, { enabled: false, theme: 'dark' })
    await application.close()
    application = await _electron.launch({ args: [entry], env: environment })
    assert.equal(await application.evaluate(async () => {
      const fixture = globalThis as unknown as PreferenceFixture
      await fixture.ready
      return fixture.load().browserAutomationEnabled
    }), true)
    const corrupted = await application.evaluate(() => {
      const fixture = globalThis as unknown as PreferenceFixture
      fixture.corrupt()
      const enabled = fixture.load().browserAutomationEnabled
      let rejected = false
      try { fixture.automation(true) } catch { rejected = true }
      let saveRejected = false
      try { fixture.save({ language: 'en' }) } catch { saveRejected = true }
      return { enabled, rejected, saveRejected, diagnostics: fixture.diagnostics }
    })
    assert.equal(corrupted.enabled, false)
    assert.equal(corrupted.rejected, true)
    assert.equal(corrupted.saveRejected, true)
    assert.ok(corrupted.diagnostics.some((line) => line.includes('"stage":"read"') && line.includes('"name":"SyntaxError"')))
    assert.doesNotMatch(corrupted.diagnostics.join(''), /invalid|profile|renderer-preferences\.json/)
  } finally {
    await application?.close()
    await rm(temporary, { recursive: true, force: true })
  }
})
