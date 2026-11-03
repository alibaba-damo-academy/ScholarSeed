import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { build } from 'esbuild'
import { _electron, chromium } from '@playwright/test'
import type { BrowserWindow, Session, WebPreferences } from 'electron'
import type { ChromiumInspectorHost, InspectorState } from './inspector.ts'

interface InspectorProbe {
  ready: Promise<void>
  host: ChromiumInspectorHost
  BrowserWindow: typeof BrowserWindow
  defaultSession: Session
  states: InspectorState[]
  emitPipeClose(error: Error): void
  setAttachError(error: Error): void
  pipeCloseCalls: number
}

async function launchInspectorProbe() {
  const temporary = await mkdtemp(join(tmpdir(), 'browser-inspector-'))
  const entry = join(temporary, 'main.cjs')
  await build({
    stdin: {
      contents: `
    import { app, BrowserWindow, session } from 'electron'
    import { createChromiumInspectorHost } from './src/main/inspector.ts'
    import { ChromiumProtocolError } from './src/main/chromium.ts'
    app.setPath('userData', ${JSON.stringify(join(temporary, 'profile'))})
    app.commandLine.appendSwitch('use-mock-keychain')
    app.on('window-all-closed', () => undefined)
    const listeners = new Set()
    const closeListeners = new Set()
    globalThis.pipeCloseCalls = 0
    const pipe = {
      command(method, params) {
        if (method === 'Target.attachToTarget' && globalThis.attachError) {
          return Promise.reject(new ChromiumProtocolError(globalThis.attachError.message, -32000))
        }
        if (method === 'Target.attachToTarget') return Promise.resolve({ sessionId: 'inspector-session' })
        return Promise.resolve({})
      },
      onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener) },
      onClose(listener) { closeListeners.add(listener); return () => closeListeners.delete(listener) },
      close() { globalThis.pipeCloseCalls += 1; return Promise.resolve() }
    }
    globalThis.ready = app.whenReady().then(() => {
      globalThis.BrowserWindow = BrowserWindow
      globalThis.defaultSession = session.defaultSession
      globalThis.states = []
      globalThis.emitPipeClose = error => { for (const listener of closeListeners) listener(error) }
      globalThis.setAttachError = error => { globalThis.attachError = error }
      globalThis.host = createChromiumInspectorHost(pipe, { onState: state => globalThis.states.push(state) })
    })
  `,
      resolveDir: resolve('.'),
    },
    outfile: entry,
    platform: 'node',
    format: 'cjs',
    bundle: true,
    external: ['electron'],
  })
  const environment = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  )
  delete environment.ELECTRON_RUN_AS_NODE
  const application = await _electron.launch({ args: [entry], env: environment })
  return { application, temporary }
}

test(
  'one target opens one isolated bundled DevTools window and closes its relay',
  { timeout: 30_000 },
  async () => {
    const { application, temporary } = await launchInspectorProbe()
    try {
      const result = await application.evaluate(async () => {
        const probe = globalThis as unknown as InspectorProbe
        await probe.ready
        const host = probe.host
        await Promise.all([host.open('target-a'), host.open('target-a')])
        const first = host.inspect('target-a')
        const windows = probe.BrowserWindow.getAllWindows()
        const window = windows[0]
        const preferences = (
          window.webContents as typeof window.webContents & {
            getLastWebPreferences(): WebPreferences
          }
        ).getLastWebPreferences()
        const isolatedSession = window.webContents.session !== probe.defaultSession
        const url = window.webContents.getURL()
        await host.close('target-a')
        return {
          first,
          windows: windows.length,
          url,
          preferences,
          isolatedSession,
          closed: host.inspect('target-a'),
          destroyed: window.isDestroyed(),
          states: probe.states,
        }
      })
      assert.equal(result.first.status, 'open')
      assert.equal(result.windows, 1)
      assert.match(
        result.url,
        /^devtools:\/\/devtools\/bundled\/inspector\.html\?ws=127\.0\.0\.1%3A\d+%2Fdevtools%2Fpage%2F[0-9a-f]+$/
      )
      assert.equal(result.preferences.sandbox, true)
      assert.equal(result.preferences.contextIsolation, true)
      assert.equal(result.preferences.nodeIntegration, false)
      assert.equal(result.preferences.preload, undefined)
      assert.equal(result.isolatedSession, true)
      assert.equal(result.destroyed, true)
      assert.deepEqual(result.closed, { status: 'closed' })
      assert.ok(
        result.states.some(
          (state: { targetId: string; status: string }) =>
            state.targetId === 'target-a' && state.status === 'open'
        )
      )
      assert.equal(
        result.states.filter(
          (state: InspectorState) => state.targetId === 'target-a' && state.status === 'closed'
        ).length,
        1
      )
      assert.equal(
        result.states.some(
          (state: InspectorState) => state.targetId === 'target-a' && state.status === 'error'
        ),
        false
      )
    } finally {
      await application.close()
      await rm(temporary, { recursive: true, force: true })
    }
  }
)

test(
  'detached DevTools frontend closes the window and publishes an error',
  { timeout: 30_000 },
  async () => {
    const { application, temporary } = await launchInspectorProbe()
    try {
      const result = await application.evaluate(async () => {
        const probe = globalThis as unknown as InspectorProbe
        await probe.ready
        await probe.host.open('target-a')
        const window = probe.BrowserWindow.getAllWindows()[0]
        const navigation = await window.webContents.loadURL('about:blank').then(
          () => null,
          (error: Error & { code?: string; errno?: number; url?: string }) => ({
            code: error.code,
            errno: error.errno,
            url: error.url,
          })
        )
        for (
          let attempt = 0;
          attempt < 100 && probe.host.inspect('target-a').status !== 'error';
          attempt += 1
        ) {
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
        return {
          state: probe.host.inspect('target-a'),
          destroyed: window.isDestroyed(),
          navigation,
          states: probe.states.filter((state) => state.targetId === 'target-a'),
        }
      })
      assert.deepEqual(result.state, {
        status: 'error',
        error: 'Chromium DevTools frontend disconnected',
      })
      assert.equal(result.destroyed, true)
      assert.deepEqual(
        result.states.map((state: InspectorState) => state.status),
        ['opening', 'open', 'error']
      )
      if (result.navigation) {
        assert.ok(
          result.navigation.code === 'ERR_FAILED' || result.navigation.code === 'ERR_ABORTED',
          JSON.stringify(result.navigation)
        )
        assert.equal(result.navigation.url, 'about:blank')
        assert.equal(result.navigation.errno, result.navigation.code === 'ERR_FAILED' ? -2 : -3)
      }
      console.log('Detached frontend navigation outcome', result)
    } finally {
      await application.close()
      await rm(temporary, { recursive: true, force: true })
    }
  }
)

test(
  'DevTools open waits for real target attachment and preserves sidecar on explicit refusal',
  { timeout: 30_000 },
  async () => {
    const { application, temporary } = await launchInspectorProbe()
    try {
      const result = await application.evaluate(async () => {
        const probe = globalThis as unknown as InspectorProbe
        await probe.ready
        probe.setAttachError(new Error('No target with given id'))
        let failure = ''
        try {
          await probe.host.open('missing-target')
        } catch (error) {
          failure = error instanceof Error ? error.message : String(error)
        }
        return {
          failure,
          state: probe.host.inspect('missing-target'),
          windows: probe.BrowserWindow.getAllWindows().length,
          pipeCloseCalls: probe.pipeCloseCalls,
        }
      })
      assert.match(result.failure, /No target with given id/)
      assert.deepEqual(result.state, { status: 'error', error: 'No target with given id' })
      assert.equal(result.windows, 0)
      assert.equal(result.pipeCloseCalls, 0)
    } finally {
      await application.close()
      await rm(temporary, { recursive: true, force: true })
    }
  }
)

test(
  'target destruction and failed load leave observable errors and no live window',
  { timeout: 30_000 },
  async () => {
    const { application, temporary } = await launchInspectorProbe()
    try {
      const result = await application.evaluate(async () => {
        const probe = globalThis as unknown as InspectorProbe
        await probe.ready
        const host = probe.host
        await host.open('target-a')
        await host.targetDestroyed('target-a')
        const afterDestroy = host.inspect('target-a')
        const BrowserWindow = probe.BrowserWindow
        const originalLoad = BrowserWindow.prototype.loadURL
        BrowserWindow.prototype.loadURL = () => Promise.reject(new Error('forced load failure'))
        let message = ''
        try {
          await host.open('target-b')
        } catch (error) {
          message = error instanceof Error ? error.message : String(error)
        }
        BrowserWindow.prototype.loadURL = originalLoad
        const failed = host.inspect('target-b')
        await host.targetDestroyed('target-b')
        return {
          afterDestroy,
          message,
          failed,
          afterFailureDestroy: host.inspect('target-b'),
          windows: BrowserWindow.getAllWindows().length,
          states: probe.states,
        }
      })
      assert.deepEqual(result.afterDestroy, { status: 'closed' })
      assert.match(result.message, /forced load failure/)
      assert.equal(result.failed.status, 'error')
      assert.match(result.failed.error ?? '', /forced load failure/)
      assert.deepEqual(result.afterFailureDestroy, { status: 'closed' })
      assert.equal(result.windows, 0)
      assert.ok(
        result.states.some(
          (state: { targetId: string; status: string }) =>
            state.targetId === 'target-b' && state.status === 'error'
        )
      )
    } finally {
      await application.close()
      await rm(temporary, { recursive: true, force: true })
    }
  }
)

test(
  'native window close and sidecar exit release per-target hosts',
  { timeout: 30_000 },
  async () => {
    const { application, temporary } = await launchInspectorProbe()
    try {
      const result = await application.evaluate(async () => {
        const probe = globalThis as unknown as InspectorProbe
        await probe.ready
        await probe.host.open('target-a')
        probe.BrowserWindow.getAllWindows()[0].close()
        for (
          let attempt = 0;
          attempt < 100 && probe.host.inspect('target-a').status !== 'closed';
          attempt += 1
        ) {
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
        const afterNativeClose = probe.host.inspect('target-a')
        await probe.host.open('target-b')
        probe.emitPipeClose(new Error('Chromium exited'))
        for (
          let attempt = 0;
          attempt < 100 && probe.host.inspect('target-b').status !== 'error';
          attempt += 1
        ) {
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
        return {
          afterNativeClose,
          afterExit: probe.host.inspect('target-b'),
          windows: probe.BrowserWindow.getAllWindows().length,
        }
      })
      assert.deepEqual(result.afterNativeClose, { status: 'closed' })
      assert.deepEqual(result.afterExit, { status: 'error', error: 'Chromium exited' })
      assert.equal(result.windows, 0)
    } finally {
      await application.close()
      await rm(temporary, { recursive: true, force: true })
    }
  }
)

test(
  'reopening DevTools reuses one isolated nonpersistent session',
  { timeout: 30_000 },
  async () => {
    const { application, temporary } = await launchInspectorProbe()
    try {
      const result = await application.evaluate(async () => {
        const probe = globalThis as unknown as InspectorProbe
        await probe.ready
        await probe.host.open('target-a')
        const first = probe.BrowserWindow.getAllWindows()[0].webContents.session
        await probe.host.close('target-a')
        await probe.host.open('target-a')
        const second = probe.BrowserWindow.getAllWindows()[0].webContents.session
        await probe.host.close('target-a')
        return {
          reused: first === second,
          isolated: second !== probe.defaultSession,
          status: probe.host.inspect('target-a'),
          windows: probe.BrowserWindow.getAllWindows().length,
        }
      })
      assert.equal(result.reused, true)
      assert.equal(result.isolated, true)
      assert.deepEqual(result.status, { status: 'closed' })
      assert.equal(result.windows, 0)
    } finally {
      await application.close()
      await rm(temporary, { recursive: true, force: true })
    }
  }
)

test(
  'failed target state is bounded while recent failure remains observable',
  { timeout: 30_000 },
  async () => {
    const { application, temporary } = await launchInspectorProbe()
    try {
      const result = await application.evaluate(async () => {
        const probe = globalThis as unknown as InspectorProbe
        await probe.ready
        const originalLoad = probe.BrowserWindow.prototype.loadURL
        probe.BrowserWindow.prototype.loadURL = () =>
          Promise.reject(new Error('inspector unavailable'))
        try {
          for (let target = 0; target < 65; target += 1) {
            await probe.host.open(`target-${target}`).catch(() => undefined)
          }
          return {
            oldest: probe.host.inspect('target-0'),
            newest: probe.host.inspect('target-64'),
            windows: probe.BrowserWindow.getAllWindows().length,
          }
        } finally {
          probe.BrowserWindow.prototype.loadURL = originalLoad
        }
      })
      assert.deepEqual(result.oldest, { status: 'closed' })
      assert.deepEqual(result.newest, { status: 'error', error: 'inspector unavailable' })
      assert.equal(result.windows, 0)
    } finally {
      await application.close()
      await rm(temporary, { recursive: true, force: true })
    }
  }
)

test(
  'real isolated Chromium inspector and external Playwright share one Main-owned page',
  {
    skip: !existsSync(chromium.executablePath()),
    timeout: 90_000,
  },
  async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'browser-inspector-real-'))
    const entry = join(temporary, 'main.cjs')
    const screenshotDirectory = resolve('../../tmp/test_snapshot/desktop')
    const pageMarkup =
      '<title>Sidecar inspector probe</title><input id="name"><button id="go" onclick="this.textContent=document.querySelector(\'#name\').value">go</button>'
    const consoleMarker = `sidecar-console-${randomUUID()}`
    const requestMarker = `sidecar-network-${randomUUID()}`
    const requestedPaths: string[] = []
    let server: ReturnType<typeof createServer> | undefined
    let application: Awaited<ReturnType<typeof _electron.launch>> | undefined
    try {
      await mkdir(screenshotDirectory, { recursive: true })
      const httpServer = createServer((request, response) => {
        requestedPaths.push(request.url ?? '')
        response.writeHead(200, {
          'content-type': request.url === '/' ? 'text/html' : 'text/plain',
          'cache-control': 'no-store',
        })
        response.end(request.url === '/' ? pageMarkup : requestMarker)
      })
      server = httpServer
      await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
      const pageUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/`
      const requestUrl = `${pageUrl}${requestMarker}`
      await build({
        stdin: {
          contents: `
    import { app, BrowserWindow } from 'electron'
    import { spawn } from 'node:child_process'
    import { join } from 'node:path'
    import { ChromiumPipe } from './src/main/chromium.ts'
    import { createChromiumCdpRelay } from './src/main/chromiumrelay.ts'
    import { createChromiumInspectorHost } from './src/main/inspector.ts'
    app.setPath('userData', ${JSON.stringify(join(temporary, 'electron-profile'))})
    app.commandLine.appendSwitch('use-mock-keychain')
    app.on('window-all-closed', () => undefined)
    globalThis.ready = app.whenReady().then(async () => {
      const profileDirectory = join(${JSON.stringify(temporary)}, 'chromium-profile')
      const child = spawn(${JSON.stringify(chromium.executablePath())}, [
        '--headless=new', '--use-mock-keychain', '--no-first-run', '--no-default-browser-check',
        '--remote-debugging-pipe', '--user-data-dir=' + profileDirectory, 'about:blank'
      ], { shell: false, stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] })
      const pipe = new ChromiumPipe(child, { profileDirectory })
      globalThis.cleanup = async () => { await pipe.close() }
      await pipe.command('Browser.getVersion')
      const { targetId } = await pipe.command('Target.createTarget', { url: 'about:blank' })
      const { sessionId } = await pipe.command('Target.attachToTarget', { targetId, flatten: true })
      await pipe.command('Page.enable', {}, sessionId)
      await pipe.command('Runtime.enable', {}, sessionId)
      const loaded = new Promise(resolve => {
        const unsubscribe = pipe.onEvent(message => {
          if (message.sessionId !== sessionId || message.method !== 'Page.loadEventFired') return
          unsubscribe()
          resolve()
        })
      })
      await pipe.command('Page.navigate', { url: ${JSON.stringify(pageUrl)} }, sessionId)
      await loaded
      const relay = createChromiumCdpRelay(pipe)
      const { endpoint } = await relay.start()
      const host = createChromiumInspectorHost(pipe)
      globalThis.cleanup = async () => { await host.dispose(); await relay.stop(); await pipe.close() }
      await host.open(targetId)
      globalThis.probe = {
        endpoint, targetId,
        status: () => host.inspect(targetId),
        frameTree: () => pipe.command('Page.getFrameTree', {}, sessionId),
        readButton: async () => {
          const response = await pipe.command('Runtime.evaluate', {
            expression: 'document.querySelector("#go")?.textContent', returnByValue: true
          }, sessionId)
          return response.result?.value
        },
        log: async marker => pipe.command('Runtime.evaluate', {
          expression: 'console.log(' + JSON.stringify(marker) + ')'
        }, sessionId),
        request: async url => pipe.command('Runtime.evaluate', {
          expression: 'fetch(' + JSON.stringify(url) + ').catch(console.error)'
        }, sessionId),
        close: async () => { await host.dispose(); await relay.stop(); await pipe.close() },
        windows: () => BrowserWindow.getAllWindows().length
      }
    })
  `,
          resolveDir: resolve('.'),
        },
        outfile: entry,
        platform: 'node',
        format: 'cjs',
        bundle: true,
        external: ['electron'],
      })
      const environment = Object.fromEntries(
        Object.entries(process.env).filter(
          (item): item is [string, string] => item[1] !== undefined
        )
      )
      delete environment.ELECTRON_RUN_AS_NODE
      application = await _electron.launch({ args: [entry], env: environment })
      const connection = await application.evaluate(async () => {
        const probe = globalThis as unknown as {
          ready: Promise<void>
          probe: {
            endpoint: string
            targetId: string
            status(): { status: string }
            windows(): number
          }
        }
        await probe.ready
        return {
          endpoint: probe.probe.endpoint,
          targetId: probe.probe.targetId,
          status: probe.probe.status(),
          windows: probe.probe.windows(),
        }
      })
      assert.equal(connection.status.status, 'open')
      assert.equal(connection.windows, 1)
      const inspectorPage = application.windows()[0]
      await assert.doesNotReject(
        inspectorPage.getByText('Elements', { exact: true }).first().waitFor()
      )
      await inspectorPage.locator('[aria-label="More tabs"]').first().click()
      await inspectorPage.getByText('Console', { exact: true }).last().click()
      await inspectorPage.getByLabel('Console panel').waitFor()
      await application.evaluate(async (_electron, marker) => {
        const probe = globalThis as unknown as { probe: { log(marker: string): Promise<unknown> } }
        await probe.probe.log(marker)
      }, consoleMarker)
      await inspectorPage
        .getByLabel('Console panel')
        .getByText(consoleMarker, { exact: false })
        .first()
        .waitFor({ timeout: 5_000 })
      await inspectorPage.screenshot({
        path: join(screenshotDirectory, 'sidecar-electron-console.png'),
      })
      await inspectorPage.locator('[aria-label="More tabs"]').first().click()
      await inspectorPage.getByText('Network', { exact: true }).first().click()
      await inspectorPage.getByLabel('Network panel').waitFor()
      await application.evaluate(async (_electron, url) => {
        const probe = globalThis as unknown as { probe: { request(url: string): Promise<unknown> } }
        await probe.probe.request(url)
      }, requestUrl)
      await inspectorPage
        .getByLabel('Network panel')
        .getByText(requestMarker, { exact: false })
        .first()
        .waitFor({ timeout: 5_000 })
      assert.ok(requestedPaths.includes(`/${requestMarker}`))
      await inspectorPage.screenshot({
        path: join(screenshotDirectory, 'sidecar-electron-network.png'),
      })
      await inspectorPage.locator('[aria-label="More tabs"]').first().click()
      await inspectorPage.getByText('Elements', { exact: true }).first().click()
      await inspectorPage.locator('.elements-tree-outline').first().waitFor()
      const elementTree = (
        await inspectorPage.locator('.elements-tree-outline').first().innerText()
      ).replaceAll('\u200b', '')
      assert.match(elementTree, /id="name"/)
      assert.match(elementTree, /id="go"/)
      const browser = await chromium.connectOverCDP(connection.endpoint)
      try {
        const pages = browser.contexts().flatMap((context) => context.pages())
        const ownedPage = (
          await Promise.all(pages.map(async (page) => ({ page, title: await page.title() })))
        ).find((candidate) => candidate.title === 'Sidecar inspector probe')?.page
        assert.ok(ownedPage, 'external Playwright must discover the Main-owned page')
        await ownedPage.locator('#name').fill('shared')
        await ownedPage.locator('#go').click()
        assert.equal(await ownedPage.locator('#go').textContent(), 'shared')
        const screenshot = await ownedPage.screenshot({
          path: join(screenshotDirectory, 'sidecar-cdp-page.png'),
        })
        assert.ok(screenshot.length > 1000)
        await inspectorPage.screenshot({
          path: join(screenshotDirectory, 'sidecar-electron-devtools.png'),
        })
        assert.equal(
          await application.evaluate(async () => {
            const probe = globalThis as unknown as {
              probe: { status(): { status: string }; frameTree(): Promise<unknown> }
            }
            await probe.probe.frameTree()
            return probe.probe.status().status
          }),
          'open'
        )
      } finally {
        await browser.close()
      }
      let reconnectedBrowser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined
      let reconnectError: unknown
      for (let attempt = 1; attempt <= 20; attempt += 1) {
        try {
          reconnectedBrowser = await chromium.connectOverCDP(connection.endpoint)
          if (attempt > 1)
            console.info(`Chromium CDP relay recovered after ${attempt} connect attempts`)
          break
        } catch (error) {
          reconnectError = error
          if (attempt < 20) await sleep(50)
        }
      }
      assert.ok(
        reconnectedBrowser,
        `Chromium CDP relay did not release the previous client: ${String(reconnectError)}`
      )
      try {
        const pages = reconnectedBrowser.contexts().flatMap((context) => context.pages())
        const ownedPage = (
          await Promise.all(pages.map(async (page) => ({ page, title: await page.title() })))
        ).find((candidate) => candidate.title === 'Sidecar inspector probe')?.page
        assert.ok(ownedPage, 'reconnected Playwright must find the same Main-owned page')
        assert.equal(await ownedPage.locator('#go').textContent(), 'shared')
        await ownedPage.locator('#name').fill('reconnected')
        await ownedPage.locator('#go').click()
        assert.equal(await ownedPage.locator('#go').textContent(), 'reconnected')
      } finally {
        await reconnectedBrowser.close()
      }
      assert.deepEqual(
        await application.evaluate(async () => {
          const probe = globalThis as unknown as {
            probe: {
              status(): { status: string }
              frameTree(): Promise<unknown>
              readButton(): Promise<string>
            }
          }
          await probe.probe.frameTree()
          return { status: probe.probe.status().status, button: await probe.probe.readButton() }
        }),
        { status: 'open', button: 'reconnected' }
      )
      await inspectorPage.locator('[aria-label="More tabs"]').first().click()
      await inspectorPage.getByText('Console', { exact: true }).last().click()
      await inspectorPage.getByLabel('Console panel').waitFor()
      await application.evaluate(async () => {
        const probe = globalThis as unknown as { probe: { close(): Promise<void> } }
        await probe.probe.close()
      })
    } finally {
      try {
        await application?.evaluate(async () => {
          const probe = globalThis as unknown as { cleanup?: () => Promise<void> }
          await probe.cleanup?.()
        })
      } finally {
        try {
          await application?.close()
        } finally {
          try {
            await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
          } finally {
            const activeServer = server
            if (activeServer?.listening) {
              await new Promise<void>((resolve, reject) =>
                activeServer.close((error) => (error ? reject(error) : resolve()))
              )
            }
          }
        }
      }
    }
  }
)
