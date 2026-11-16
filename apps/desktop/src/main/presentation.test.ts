import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, access, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { _electron, expect } from '@playwright/test'
import { build } from 'esbuild'
import react from '@vitejs/plugin-react'
import type { BrowserWindow, WebContentsView } from 'electron'
import type { UpdateSnapshot } from '../updates.ts'
import { nativeFixture } from '../test-helpers/native.ts'
import { renderServers } from '../test-helpers/render.ts'

const DESKTOP = resolve(import.meta.dirname, '../..')
const SCREENSHOTS = process.env.MOCK_UPDATE_SCREENSHOTS
const STABILITY_SAMPLES = 64
const STABILITY_INTERVAL_MS = 20

interface PresentationFixture {
  ready: Promise<void>
  product: BrowserWindow
  web: WebContentsView
  publish(next: Partial<UpdateSnapshot>): void
  modalCreations: number
  modalVisibility: boolean[]
}

test(
  'MOCK native update lifecycle covers the webpage, preserves it, and removes all temporary state',
  {
    timeout: 180_000,
  },
  async (context) => {
    const temporary = await mkdtemp(join(tmpdir(), 'scholarseed-mock-update-'))
    const servers = renderServers(context)
    const fixture = nativeFixture(context, async () => {
      await rm(temporary, { recursive: true, force: true })
      await assert.rejects(access(temporary))
      console.log('MOCK update runtime/profile/session data removed')
    })
    const server = await servers.create({
      root: resolve(DESKTOP, 'src/renderer/src'),
      cacheKey: 'mock-native-update',
      configFile: false,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const url = new URL('/shell/update.render.fixture.html', server.resolvedUrls!.local[0]).href
    const preload = join(temporary, 'preload.cjs')
    const portalPreload = join(temporary, 'portal.cjs')
    const entry = join(temporary, 'main.cjs')
    await writeFile(portalPreload, '')
    await build({
      stdin: {
        resolveDir: DESKTOP,
        contents: `
        import { contextBridge, ipcRenderer } from 'electron'
        import { UPDATE_PORTAL } from './src/portal.ts'
        contextBridge.exposeInMainWorld('scholarseed', {
          getUpdateState: () => ipcRenderer.invoke('mock:snapshot'),
          onUpdateState: (callback) => {
            const listener = (_, state) => callback(state)
            ipcRenderer.on('mock:changed', listener)
            return () => ipcRenderer.removeListener('mock:changed', listener)
          },
          cancelUpdate: () => ipcRenderer.invoke('mock:cancel'),
          updatePortal: {
            reserve: () => ipcRenderer.invoke(UPDATE_PORTAL.channels.reserve),
            paint: id => ipcRenderer.invoke(UPDATE_PORTAL.channels.paint, id),
            close: id => ipcRenderer.invoke(UPDATE_PORTAL.channels.close, id),
            subscribeRevoked: callback => {
              const listener = (_, id) => callback(id)
              ipcRenderer.on(UPDATE_PORTAL.channels.revoked, listener)
              return () => ipcRenderer.removeListener(UPDATE_PORTAL.channels.revoked, listener)
            }
          }
        })`,
      },
      outfile: preload,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: ['electron'],
    })
    await build({
      stdin: {
        resolveDir: DESKTOP,
        contents: `
        import { app, BrowserWindow, WebContentsView, ipcMain } from 'electron'
        import { createPortalHost } from './src/main/portal.ts'
        import { UPDATE_PORTAL } from './src/portal.ts'
        app.setName('ScholarSeed MOCK Update')
        app.setPath('userData', ${JSON.stringify(join(temporary, 'profile'))})
        app.setPath('sessionData', ${JSON.stringify(join(temporary, 'session'))})
        app.commandLine.appendSwitch('use-mock-keychain')
        globalThis.ready = app.whenReady().then(async () => {
          const window = new BrowserWindow({ width:1280, height:840, show:true,
            webPreferences:{ preload:${JSON.stringify(preload)}, sandbox:true, contextIsolation:true, nodeIntegration:false } })
          globalThis.product = window
          let snapshot = { phase:'ready', currentVersion:'0.3.2', candidate: {
            id:'mock-update', version:'0.3.2', build_number:'202611110001',
            release_notes:'MOCK ONLY — no installer or real restart is executed',
            product_id:'scholarseed', bundle_id:'com.scholarseed.desktop',
            arch_type:'darwin-arm64', channel:'preview', file_size:100, sha512:'a'.repeat(128)
          } }
          globalThis.publish = next => { snapshot = {...snapshot, ...next}; window.webContents.send('mock:changed',snapshot) }
          ipcMain.handle('mock:snapshot', () => snapshot)
          ipcMain.handle('mock:cancel', () => { globalThis.publish({phase:'ready',restartPending:false}); return {ok:true} })
          globalThis.modalCreations = 0
          globalThis.modalVisibility = []
          const host = createPortalHost(window, {surface:UPDATE_PORTAL, ipc:ipcMain,
            preload:${JSON.stringify(portalPreload)}, createView: options => {
              globalThis.modalCreations++
              const view = new WebContentsView(options)
              const setVisible = view.setVisible.bind(view)
              view.setVisible = visible => { globalThis.modalVisibility.push(visible); setVisible(visible) }
              return view
            }})
          window.webContents.setWindowOpenHandler(details => host.windowOpen(details) ?? {action:'deny'})
          window.once('closed', () => host.dispose())
          await window.loadURL(${JSON.stringify(url)})
          const web = new WebContentsView({webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}})
          web.setBounds({x:640,y:120,width:640,height:680})
          window.contentView.addChildView(web)
          await web.webContents.loadURL('data:text/html,<title>MOCK webpage</title><body style="background:teal;color:white;font-size:32px">MOCK WEBPAGE<input aria-label="Webpage sentinel" value="preserved"></body>')
          globalThis.web = web
        })`,
      },
      outfile: entry,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: ['electron'],
    })
    const environment = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined
      )
    )
    delete environment.ELECTRON_RUN_AS_NODE
    environment.SCHOLARSEED_HOME = join(temporary, 'home')
    const application = await fixture.launch(() =>
      _electron.launch({ args: [entry], env: environment })
    )
    try {
      await application.evaluate(async () => {
        await (globalThis as unknown as PresentationFixture).ready
      })
      const page = application
        .context()
        .pages()
        .find((page) => page.url() === url)!
      assert.ok(page)
      const browserBefore = await application.evaluate(() => {
        const web = (globalThis as unknown as PresentationFixture).web
        return { bounds: web.getBounds(), visible: web.getVisible() }
      })
      const nextWindow = application.context().waitForEvent('page')
      await application.evaluate(() =>
        (globalThis as unknown as PresentationFixture).publish({ phase: 'installing' })
      )
      const modal = await nextWindow
      await expect(modal.getByTestId('update-overlay')).toBeVisible()
      await expect.poll(() => modal.evaluate('document.body.inert')).toBe(false)
      await application.evaluate(() =>
        (globalThis as unknown as PresentationFixture).publish({
          phase: 'restarting',
          installStage: 'restarting',
        })
      )
      await expect(modal.getByTestId('update-overlay-description')).toContainText('在后台完成更新')
      await expect(modal.getByTestId('update-overlay-cancel')).toHaveCount(0)
      await expect(modal.getByTestId('update-overlay-notes')).toContainText('MOCK ONLY')
      const stable = await application.evaluate(
        async (_, { samples, interval }) => {
          const fixture = globalThis as unknown as PresentationFixture
          const children = fixture.product.contentView.children
          const original = children[children.length - 1] as WebContentsView
          const visibilityCalls = fixture.modalVisibility.length
          let stableSamples = 0
          for (let index = 0; index < samples; index++) {
            fixture.publish({
              phase: index % 2 ? 'restarting' : 'installing',
              installStage: 'restarting',
            })
            await new Promise((resolve) => setTimeout(resolve, interval))
            const current = fixture.product.contentView.children
            if (
              current[current.length - 1] === original &&
              original.getVisible() &&
              fixture.web.getVisible()
            )
              stableSamples++
          }
          return {
            stableSamples,
            creations: fixture.modalCreations,
            extraVisibilityCalls: fixture.modalVisibility.length - visibilityCalls,
          }
        },
        { samples: STABILITY_SAMPLES, interval: STABILITY_INTERVAL_MS }
      )
      assert.deepEqual(stable, {
        stableSamples: STABILITY_SAMPLES,
        creations: 1,
        extraVisibilityCalls: 0,
      })
      console.log(
        `MOCK stability: ${stable.stableSamples} consecutive state updates, one native modal, no visibility toggles`
      )
      const nativeState = await application.evaluate(() => {
        const { product, web } = globalThis as unknown as PresentationFixture
        const children = product.contentView.children
        const top = children[children.length - 1] as WebContentsView
        return {
          webVisible: web.getVisible(),
          webBounds: web.getBounds(),
          topIsWeb: top === web,
          modalBounds: top.getBounds(),
          focused: top.webContents.isFocused(),
        }
      })
      assert.equal(nativeState.topIsWeb, false)
      assert.equal(nativeState.webVisible, true)
      assert.deepEqual(nativeState.webBounds, browserBefore.bounds)
      assert.equal(nativeState.modalBounds.x, 0)
      assert.equal(nativeState.modalBounds.width, 1280)
      if (SCREENSHOTS) {
        await mkdir(SCREENSHOTS, { recursive: true })
        await modal.screenshot({ path: join(SCREENSHOTS, 'mock-restarting-native-surface.png') })
        const composite = await application.evaluate(
          async ({ desktopCapturer, systemPreferences }) => {
            if (
              process.platform === 'darwin' &&
              systemPreferences.getMediaAccessStatus('screen') !== 'granted'
            )
              return null
            const product = (globalThis as unknown as PresentationFixture).product
            const bounds = product.getBounds()
            const sources = await desktopCapturer.getSources({
              types: ['window'],
              thumbnailSize: { width: bounds.width, height: bounds.height },
            })
            return (
              sources
                .find((source) => source.id === product.getMediaSourceId())
                ?.thumbnail.toPNG()
                .toString('base64') ?? null
            )
          }
        )
        if (composite)
          await writeFile(
            join(SCREENSHOTS, 'mock-restarting-composite.png'),
            Buffer.from(composite, 'base64')
          )
        else
          console.log(
            'Native composite capture unavailable; surface screenshot is not a compositor proof'
          )
      }
      await application.evaluate(() =>
        (globalThis as unknown as PresentationFixture).publish({
          phase: 'ready',
          installStage: undefined,
        })
      )
      await expect.poll(() => modal.isClosed()).toBe(true)
      const cancelledWindow = application.context().waitForEvent('page')
      await application.evaluate(() =>
        (globalThis as unknown as PresentationFixture).publish({
          phase: 'downloading',
          restartPending: true,
        })
      )
      const cancellable = await cancelledWindow
      await expect(cancellable.getByTestId('update-overlay-cancel')).toBeEnabled()
      await cancellable.getByTestId('update-overlay-cancel').click()
      await expect.poll(() => cancellable.isClosed()).toBe(true)
      const browserAfter = await application.evaluate(async () => {
        const web = (globalThis as unknown as PresentationFixture).web
        return {
          bounds: web.getBounds(),
          visible: web.getVisible(),
          sentinel: await web.webContents.executeJavaScript(
            'document.querySelector("input").value'
          ),
        }
      })
      assert.deepEqual(browserAfter, { ...browserBefore, sentinel: 'preserved' })
      console.log(
        'MOCK restart, completion, pending-restart cancellation, native order and webpage preservation passed'
      )
    } finally {
      await fixture.close()
      await servers.close()
    }
  }
)
