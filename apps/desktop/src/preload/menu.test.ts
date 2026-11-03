import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { build as bundle } from 'esbuild'
import { build } from 'vite'
import { resolveConfig } from 'electron-vite'
import { _electron } from '@playwright/test'

test(
  'actual sandboxed menu has only model events paint and seed and acknowledges painted native view',
  { timeout: 120_000 },
  async (context) => {
    const directory = fileURLToPath(new URL('../../', import.meta.url))
    const temporary = mkdtempSync(join(tmpdir(), 'menu-sandbox-'))
    context.after(() => rmSync(temporary, { recursive: true, force: true }))
    const config = await resolveConfig(
      { root: directory, configFile: join(directory, 'electron.vite.config.ts') },
      'build',
      'production'
    )
    const preloadConfig = config.config?.preload
    assert.ok(preloadConfig)
    const result = await build({
      ...preloadConfig,
      root: directory,
      configFile: false,
      build: { ...preloadConfig.build, write: false, emptyOutDir: false },
    })
    const outputs = Array.isArray(result) ? result : [result]
    const files = outputs.flatMap((output) => ('output' in output ? output.output : []))
    const preload = files.find((file) => file.fileName === 'menu.js')
    assert.ok(preload)
    const code = preload.type === 'chunk' ? preload.code : String(preload.source)
    assert.equal(/require\(["']\.[^"']*["']\)/.test(code), false)
    writeFileSync(join(temporary, 'menu.js'), code)
    writeFileSync(
      join(temporary, 'product.html'),
      '<!doctype html><title>Product reload probe</title>'
    )
    writeFileSync(
      join(temporary, 'menu.html'),
      `<!doctype html><body style="background:transparent"><div id="content"></div><script>
    window.menu.subscribe(model => {
      document.getElementById('content').textContent = model.items[0].label;
      requestAnimationFrame(() => requestAnimationFrame(() => window.menu.paintReady({ sessionId: model.sessionId, revision: model.revision })));
    });
  </script>`
    )
    const entry = join(temporary, 'main.cjs')
    await bundle({
      stdin: {
        contents: `
    import { app, BrowserWindow, WebContentsView, session, ipcMain } from 'electron'
    import { createServer } from 'node:http'
    import { pathToFileURL } from 'node:url'
    import { createMenuOwner, MenuActionRegistry } from './src/main/menuhost.ts'
    app.setPath('userData', ${JSON.stringify(join(temporary, 'profile'))})
    app.setPath('sessionData', ${JSON.stringify(join(temporary, 'sessions'))})
    globalThis.ready = app.whenReady().then(async () => {
      const window = new BrowserWindow({ show:false, webPreferences:{ sandbox:true, contextIsolation:true, nodeIntegration:false } })
      await window.loadURL('about:blank'); window.show();
      if (process.platform === 'darwin') app.focus({ steal: true })
      window.focus();
      if (!window.isFocused()) await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Native window focus unavailable')), 10_000)
        window.once('focus', () => { clearTimeout(timer); resolve() })
      })
      const page = new WebContentsView({ webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false} })
      await page.webContents.loadURL('about:blank')
      page.setBounds({x:100,y:100,width:200,height:100}); page.setVisible(true);window.contentView.addChildView(page)
      globalThis.page=page
      const registry = new MenuActionRegistry()
      registry.register('browser.devtools', { surface:'browser-menu',close:'before',validateValue:value=>value.kind==='boolean',execute:()=>{} })
      const target = {kind:'browser',tabId:'tab',instanceId:'instance',navigationId:1}
      const owner = createMenuOwner(window, { rendererUrl:'about:blank', ipc:ipcMain, registry, directory:${JSON.stringify(temporary)},preload:${JSON.stringify(join(temporary, 'menu.js'))},
        target:()=>target, createSession:()=>session.fromPartition('menu-probe',{cache:false}),createView:webPreferences=>new WebContentsView({webPreferences}) })
      globalThis.owner=owner;globalThis.window=window;
      globalThis.makeOwner = rendererUrl => createMenuOwner(window, { rendererUrl, ipc:ipcMain, registry,
        directory:${JSON.stringify(temporary)},preload:${JSON.stringify(join(temporary, 'menu.js'))},target:()=>target,
        createSession:()=>session.fromPartition('menu-probe',{cache:false}),createView:webPreferences=>new WebContentsView({webPreferences}) })
      const server = createServer((_request, response) => { response.writeHead(200, {'Content-Type':'text/html'}); response.end('<!doctype html><title>HTTP product</title>') })
      await new Promise(resolve => server.listen(0,'127.0.0.1',resolve))
      globalThis.httpUrl = 'http://127.0.0.1:' + server.address().port + '/'
      globalThis.fileUrl = pathToFileURL(${JSON.stringify(join(temporary, 'product.html'))}).href
      const [width,height]=window.getContentSize()
      return owner.publish({ sessionId:'probe',revision:1,surface:'browser-menu',anchor:{x:10,y:10,width:20,height:20},viewport:{width,height},
        theme:'light',language:'en',target,items:[{kind:'action',id:'devtools',actionId:'browser.devtools',label:'Developer tools',disabled:false,checked:false,value:{kind:'boolean',value:true}}] })
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
    const application = await _electron.launch({ args: [entry], env: environment })
    try {
      const result = await application.evaluate(async () => {
        const state = globalThis as unknown as {
          ready: Promise<unknown>
          window: Electron.BrowserWindow
          page: Electron.WebContentsView
          owner: { dismiss(reason: string): void }
        }
        const reply = await state.ready
        const view = state.window.contentView.children.find(
          (child) => child !== state.page && 'webContents' in child
        ) as Electron.WebContentsView
        const projection = await view.webContents.executeJavaScript(
          `({ keys:Object.keys(window.menu),product:typeof window.scholarseed,node:typeof process,text:document.getElementById('content').textContent })`
        )
        const visible = view.getVisible()
        const focused = view.webContents.isFocused()
        const contents = view.webContents
        const destroyed = new Promise<void>((resolve) => contents.once('destroyed', resolve))
        state.window.webContents.focus()
        await destroyed
        return {
          reply,
          projection,
          visible,
          focused,
          closed: contents.isDestroyed(),
          removed: !state.window.contentView.children.includes(view),
          pageBounds: state.page.getBounds(),
          pageVisible: state.page.getVisible(),
          pageAlive: !state.page.webContents.isDestroyed(),
        }
      })
      assert.deepEqual(result, {
        reply: { ok: true, ack: { sessionId: 'probe', revision: 1 } },
        projection: {
          keys: ['subscribeFind', 'subscribeRefocus', 'seed', 'subscribe', 'send', 'paintReady'],
          product: 'undefined',
          node: 'undefined',
          text: 'Developer tools',
        },
        visible: true,
        focused: true,
        closed: true,
        removed: true,
        pageBounds: { x: 100, y: 100, width: 200, height: 100 },
        pageVisible: true,
        pageAlive: true,
      })
      const reloads = await application.evaluate(async () => {
        const state = globalThis as unknown as {
          window: Electron.BrowserWindow
          page: Electron.WebContentsView
          owner: { dispose(): void }
          makeOwner(url: string): { publish(model: unknown): Promise<unknown>; dispose(): void }
          httpUrl: string
          fileUrl: string
        }
        state.owner.dispose()
        const pageContents = state.page.webContents
        const pageId = pageContents.id
        const outcomes: unknown[] = []
        for (const canonical of [state.httpUrl, state.fileUrl]) {
          await state.window.loadURL(canonical)
          const owner = state.makeOwner(canonical)
          const contents = state.window.webContents
          const codes: number[] = []
          const commit = (_event: Electron.Event, _url: string, code: number) => {
            codes.push(code)
          }
          contents.on('did-navigate', commit)
          const gone = new Promise<void>((resolve) =>
            contents.once('render-process-gone', () => resolve())
          )
          contents.forcefullyCrashRenderer()
          await gone
          await state.window.loadURL(canonical)
          state.window.focus()
          if (!state.window.isFocused())
            await new Promise<void>((resolve) => state.window.once('focus', () => resolve()))
          const [width, height] = state.window.getContentSize()
          const reply = await owner.publish({
            sessionId: 'reloaded',
            revision: 1,
            surface: 'browser-menu',
            anchor: { x: 10, y: 10, width: 20, height: 20 },
            viewport: { width, height },
            theme: 'light',
            language: 'en',
            target: { kind: 'browser', tabId: 'tab', instanceId: 'instance', navigationId: 1 },
            items: [
              {
                kind: 'action',
                id: 'devtools',
                actionId: 'browser.devtools',
                label: 'Developer tools',
                disabled: false,
                checked: false,
                value: { kind: 'boolean', value: true },
              },
            ],
          })
          outcomes.push({
            protocol: new URL(canonical).protocol,
            codes,
            reply,
            pageBounds: state.page.getBounds(),
            pageVisible: state.page.getVisible(),
            pageAlive: !state.page.webContents.isDestroyed(),
            pageIdentity:
              state.page.webContents === pageContents && state.page.webContents.id === pageId,
          })
          contents.removeListener('did-navigate', commit)
          owner.dispose()
        }
        return outcomes
      })
      assert.deepEqual(
        reloads,
        ['http:', 'file:'].map((protocol) => ({
          protocol,
          codes: [200],
          reply: { ok: true, ack: { sessionId: 'reloaded', revision: 1 } },
          pageBounds: { x: 100, y: 100, width: 200, height: 100 },
          pageVisible: true,
          pageAlive: true,
          pageIdentity: true,
        }))
      )
    } finally {
      await application.close()
      rmSync(temporary, { recursive: true, force: true })
    }
  }
)
