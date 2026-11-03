import { app, BrowserWindow, clipboard } from 'electron'
import { createServer } from 'node:http'
import { once } from 'node:events'
import assert from 'node:assert/strict'
import { createInterface } from 'node:readline'
import { writeFile } from 'node:fs/promises'
import { createBrowserRegistry } from '../../src/main/browser.ts'
import { selectStorage, publishStorage } from '../../src/main/storage.ts'
import { createCdpBroker } from '../../src/main/cdp.ts'

app.setPath('userData', process.env.BROWSER_PROBE_PROFILE!)
if (!process.env.SCHOLARSEED_HOME) throw new Error('Probe requires isolated home')
const unexpectedPointer = () => { throw new Error('Explicit probe home must not read pointer') }
publishStorage(selectStorage('browser-probe', {
  pin: unexpectedPointer, readAt: unexpectedPointer, release: unexpectedPointer
}))
void app.whenReady().then(async () => {
  console.error('probe: ready')
  const server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html')
    response.end(`<title>CDP probe</title><body data-page="${_request.url === '/second' ? 'B' : 'A'}"><h1>Registered browser page</h1><input id="name"><button id="submit" onclick="document.querySelector('#result').textContent=document.querySelector('#name').value">Submit</button><p id="result"></p></body>`)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  console.error('probe: fixture listening')
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const window = new BrowserWindow({ show: true, width: 900, height: 600 })
  let synchronize = async () => {}
  const registry = createBrowserRegistry(window, { apiBase: origin, publish() { void synchronize().catch(console.error) }, log: console.error })
  await registry.dispatch({ kind: 'open', input: process.env.BROWSER_PROBE_REMOTE ? undefined : origin })
  console.error('probe: registered')
  await registry.dispatch({ kind: 'bounds', tabId: registry.snapshot().activeTabId!, visible: true, x: 0, y: 0, width: 900, height: 600 })
  const broker = createCdpBroker(registry, { publish() {}, log: console.error })
  synchronize = () => broker.syncTargets()
  await broker.start()
  console.error('probe: broker started')
  const originalWrite = clipboard.writeText
  let endpoint = ''
  clipboard.writeText = async value => { endpoint = value }
  broker.copyEndpoint()
  const originalToken = new URL(endpoint).pathname
  assert.match(originalToken, /^\/devtools\/browser\/[a-f0-9]{64}$/)
  await broker.stop()
  await broker.start()
  broker.copyEndpoint()
  assert.notEqual(new URL(endpoint).pathname, originalToken)
  clipboard.writeText = originalWrite
  process.stdout.write(`BROWSER_PROBE_ENDPOINT ${endpoint}\n`)
  const firstTab = registry.snapshot().activeTabId!
  const detached: { tabId: string; reason: string }[] = []
  registry.onDebuggerDetach((tabId, reason) => detached.push({ tabId, reason }))
  createInterface({ input: process.stdin }).on('line', data => {
    if (data.startsWith('{')) {
      void (async () => {
        const request = JSON.parse(data)
        const contents = registry.target(firstTab)
        let result: unknown
        switch (request.command) {
          case 'open':
            await registry.dispatch({ kind: 'open', input: `${origin}/second` })
            await registry.dispatch({ kind: 'bounds', tabId: registry.snapshot().activeTabId!, visible: true, x: 0, y: 0, width: 900, height: 600 })
            break
          case 'select': await registry.dispatch({ kind: 'select', tabId: firstTab }); break
          case 'agent': {
            const prototype = Object.getPrototypeOf(contents) as { loadURL: (url: string) => Promise<void> }
            const originalLoad = prototype.loadURL
            try {
              prototype.loadURL = async function (this: Electron.WebContents, url: string) {
                Object.defineProperty(this, 'getURL', { value: () => url, configurable: true })
                this.emit('did-navigate', {} as Electron.Event, url, 200)
                this.emit('dom-ready')
              }
              await registry.agentNavigate(firstTab, 'https://example.org/agent-isolated', 'https://example.org')
            } finally { prototype.loadURL = originalLoad }
            await broker.syncTargets()
            result = { tabId: firstTab, agentUrl: registry.target(firstTab).getURL() }
            break
          }
          case 'detach': contents.debugger.detach(); break
          case 'devtools':
            if (request.open) {
              const opened = once(contents, 'devtools-opened')
              await registry.dispatch({ kind: 'devtools', tabId: firstTab, open: true })
              await opened
            } else {
              const closed = once(contents.devToolsWebContents!, 'destroyed')
              await registry.dispatch({ kind: 'devtools', tabId: firstTab, open: false })
              await closed
            }
            break
          case 'frontend': result = await contents.devToolsWebContents!.executeJavaScript(request.expression); break
          case 'screenshot': await writeFile(request.path, (await contents.devToolsWebContents!.capturePage()).toPNG()); break
          case 'snapshot': result = { snapshot: registry.snapshot(), detached, mainDevtoolsOpen: window.webContents.isDevToolsOpened(), firstTab,
            windowCount: BrowserWindow.getAllWindows().length, debuggerAttached: contents.debugger.isAttached() }; break
          default: throw new Error('unknown probe command')
        }
        process.stdout.write(`BROWSER_PROBE_RESULT ${JSON.stringify({ id: request.id, result })}\n`)
      })().catch(error => process.stdout.write(`BROWSER_PROBE_RESULT ${JSON.stringify({ id: JSON.parse(data).id, error: String(error) })}\n`))
    } else if (data === 'open') {
      void registry.dispatch({ kind: 'open', input: origin }).then(() => broker.syncTargets())
    } else void broker.stop().then(() => registry.dispose()).finally(() => { server.close(); app.quit() })
  })
}).catch(error => { console.error(error); app.exit(1) })
