import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build as buildVite } from 'vite'
import { resolveConfig } from 'electron-vite'
import { build as buildScript } from 'esbuild'
import { _electron, expect } from '@playwright/test'
import type { BrowserWindow, WebContentsView } from 'electron'
import { nativeFixture } from '../test-helpers/native.ts'
import type { BrowserOverlayOwner } from './overlay.ts'
import { model } from './overlay.fixture.ts'

interface OverlayProbe {
  ready: ReturnType<BrowserOverlayOwner['publish']>
  window: BrowserWindow
  owner: BrowserOverlayOwner
  overlayView: WebContentsView
}

test('actual preload build emits self-contained sandbox-compatible entry bundles', async () => {
  const directory = fileURLToPath(new URL('../../', import.meta.url))
  const config = await resolveConfig(
    { root: directory, configFile: join(directory, 'electron.vite.config.ts') },
    'build',
    'production'
  )
  const preloadConfig = config.config?.preload
  assert.ok(preloadConfig)
  const result = await buildVite({
    ...preloadConfig,
    root: directory,
    configFile: false,
    build: { ...preloadConfig.build, write: false, emptyOutDir: false },
  })
  const outputs = Array.isArray(result) ? result : [result]
  const files = outputs.flatMap((output) => ('output' in output ? output.output : []))
  for (const name of ['index.js', 'overlay.js']) {
    const file = files.find((file) => file.fileName === name)
    assert.ok(file, `missing ${name}`)
    const code = file.type === 'chunk' ? file.code : String(file.source)
    if (name === 'index.js') assert.match(code, /sendSync\(OVERLAY_CHANNEL.dismissSync\)/)
    assert.equal(
      /require\(["']\.[^"']*["']\)/.test(code),
      false,
      `${name} has forbidden local sandbox require`
    )
    if (file.type === 'chunk') assert.deepEqual(file.imports, ['electron'])
  }
  const overlay = files.find((file) => file.fileName === 'overlay.js')!
  const code = overlay.type === 'chunk' ? overlay.code : String(overlay.source)
  assert.match(code, /exposeInMainWorld\(["']suggestions["']/)
  assert.doesNotMatch(code, /exposeInMainWorld\(["']scholarseed["']/)
})

test(
  'actual sandboxed Electron overlay exposes only suggestions and completes ready handshake',
  { timeout: 120_000 },
  async (context) => {
    const directory = fileURLToPath(new URL('../../', import.meta.url))
    const temporary = mkdtempSync(join(tmpdir(), 'overlay-sandbox-'))
    const fixture = nativeFixture(context, () =>
      rmSync(temporary, { recursive: true, force: true })
    )
    const config = await resolveConfig(
      { root: directory, configFile: join(directory, 'electron.vite.config.ts') },
      'build',
      'production'
    )
    const preloadConfig = config.config?.preload
    assert.ok(preloadConfig)
    const result = await buildVite({
      ...preloadConfig,
      root: directory,
      configFile: false,
      build: { ...preloadConfig.build, write: false, emptyOutDir: false },
    })
    const outputs = Array.isArray(result) ? result : [result]
    const files = outputs.flatMap((output) => ('output' in output ? output.output : []))
    const preload = files.find((file) => file.fileName === 'overlay.js')!
    const productPreload = files.find((file) => file.fileName === 'index.js')!
    writeFileSync(
      join(temporary, 'index.js'),
      productPreload.type === 'chunk' ? productPreload.code : productPreload.source
    )
    writeFileSync(
      join(temporary, 'overlay.js'),
      preload.type === 'chunk' ? preload.code : preload.source
    )
    mkdirSync(join(temporary, 'assets'))
    writeFileSync(
      join(temporary, 'overlay.html'),
      '<!doctype html><script>window.startSuggestions = () => { window.suggestions.subscribeFocus(revision => { window.focusRevision = revision }); window.suggestions.subscribe(model => { window.receivedModel = model }) }</script>'
    )
    const entry = join(temporary, 'main.cjs')
    await buildScript({
      stdin: {
        contents: `
    import { app, BrowserWindow, WebContentsView, ipcMain, session } from 'electron'
    import { createBrowserOverlay } from './src/main/overlay.ts'
    app.setPath('userData', ${JSON.stringify(join(temporary, 'profile'))})
    app.setPath('sessionData', ${JSON.stringify(join(temporary, 'sessions'))})
    globalThis.ready = app.whenReady().then(async () => {
      ipcMain.on('scholarseed:boot', event => { event.returnValue = { apiBase: '', preferences: {}, browserEnabled: true } })
      const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true,
        nodeIntegration: false, preload: ${JSON.stringify(join(temporary, 'index.js'))} } })
      await window.loadURL('about:blank')
      window.show()
      if (process.platform === 'darwin') app.focus({ steal: true })
      window.focus()
      if (!window.isFocused()) await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Native window focus unavailable')), 10_000)
        window.once('focus', () => { clearTimeout(timer); resolve() })
      })
      globalThis.window = window
      const owner = createBrowserOverlay(window, {
        ipc: ipcMain, directory: ${JSON.stringify(temporary)}, preload: ${JSON.stringify(join(temporary, 'overlay.js'))},
        createSession: () => session.fromPartition('overlay-sandbox-probe', { cache: false }),
        createView: webPreferences => { const view = new WebContentsView({ webPreferences }); globalThis.overlayView = view; return view }
      })
      globalThis.owner = owner
      return owner.publish(${JSON.stringify(model)})
    })
  `,
        resolveDir: directory,
      },
      outfile: entry,
      platform: 'node',
      format: 'cjs',
      bundle: true,
      external: ['electron'],
    })
    const environment = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined
      )
    )
    delete environment.ELECTRON_RUN_AS_NODE
    const application = await fixture.launch(() =>
      _electron.launch({ args: [entry], env: environment })
    )
    try {
      const beforeReady = await application.evaluate(async () => {
        const state = globalThis as unknown as OverlayProbe
        const reply = await state.ready
        return {
          reply,
          attached: state.window.contentView.children.includes(state.overlayView),
          visible: state.overlayView.getVisible(),
          revision: await state.overlayView.webContents.executeJavaScript(
            'window.receivedModel ?? null'
          ),
        }
      })
      assert.deepEqual(beforeReady, {
        reply: { ok: true },
        attached: false,
        visible: false,
        revision: null,
      })
      await application.evaluate(async () => {
        const state = globalThis as unknown as OverlayProbe
        await state.overlayView.webContents.executeJavaScript('window.startSuggestions()')
      })
      await expect
        .poll(() =>
          application.evaluate(async () => {
            const state = globalThis as unknown as OverlayProbe
            return {
              attached: state.window.contentView.children.includes(state.overlayView),
              visible: state.overlayView.getVisible(),
              revision: await state.overlayView.webContents.executeJavaScript(
                'window.receivedModel?.revision ?? null'
              ),
            }
          })
        )
        .toEqual({ attached: true, visible: true, revision: 1 })
      const automaticFocusRevision = await application.evaluate(() =>
        (globalThis as unknown as OverlayProbe).overlayView.webContents.executeJavaScript(
          'window.focusRevision ?? null'
        )
      )
      await application.evaluate(() => (globalThis as unknown as OverlayProbe).owner.focus())
      await expect
        .poll(() =>
          application.evaluate(() =>
            (globalThis as unknown as OverlayProbe).overlayView.webContents.executeJavaScript(
              'window.focusRevision ?? null'
            )
          )
        )
        .toBe(1)
      const result = await application.evaluate(async () => {
        const state = globalThis as unknown as OverlayProbe
        const reply = await state.ready
        const view = state.window.contentView.children.find(
          (child) => 'webContents' in child
        ) as WebContentsView
        const projection = await view.webContents.executeJavaScript(
          `({ keys: Object.keys(window.suggestions), product: typeof window.scholarseed, node: typeof process, revision: window.receivedModel?.revision })`
        )
        const visible = view.getVisible()
        const explicitFocusRevision =
          await view.webContents.executeJavaScript('window.focusRevision')
        const synchronized = await state.window.webContents.executeJavaScript(
          `window.scholarseed.browserOverlay.dismissSync(); 'returned'`
        )
        const revoked = await view.webContents.executeJavaScript(
          `window.suggestions.send({ kind: 'select', revision: 1, itemId: 'first' })`
        )
        return {
          reply,
          visible,
          projection,
          explicitFocusRevision,
          synchronized,
          hiddenAfterReturn: !view.getVisible(),
          revoked,
        }
      })
      assert.deepEqual(
        { ...result, automaticFocusRevision },
        {
          reply: { ok: true },
          visible: true,
          projection: {
            keys: ['subscribeFocus', 'subscribe', 'send'],
            product: 'undefined',
            node: 'undefined',
            revision: 1,
          },
          automaticFocusRevision: null,
          explicitFocusRevision: 1,
          synchronized: 'returned',
          hiddenAfterReturn: true,
          revoked: { ok: false, error: 'invalid_command' },
        }
      )
    } finally {
      await fixture.close()
    }
  }
)
