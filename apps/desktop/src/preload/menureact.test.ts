import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { build as bundle } from 'esbuild'
import { _electron, expect, type ElectronApplication } from '@playwright/test'
import type { BrowserWindow, WebContentsView } from 'electron'
import react from '@vitejs/plugin-react'
import { build as buildRenderer } from 'vite'
import { supportedFontSources } from '../../renderer.ts'
import { MENU_ERROR, type MenuReply } from '../menu.ts'

interface CompiledMenuFixture {
  started: Promise<void>
  loaded: Promise<void>
  painted: Promise<MenuReply>
  publish(revision: number): Promise<MenuReply>
  window: BrowserWindow
  page: WebContentsView
  menuView: WebContentsView
  errors: string[]
  menuEvents: Array<{ event: string; focused: boolean; visible: boolean }>
  menuDiagnostics: string[]
}

test(
  'actual compiled React Menu completes sandbox paint ACK with native focus and transparent document',
  { timeout: 30_000 },
  async (context) => {
    const directory = fileURLToPath(new URL('../../', import.meta.url))
    const temporary = mkdtempSync(join(tmpdir(), 'menu-react-'))
    const runtime: { application?: ElectronApplication; closing?: Promise<void> } = {}
    const closeFixture = (): Promise<void> =>
      runtime.application ? (runtime.closing ??= runtime.application.close()) : Promise.resolve()
    context.after(async () => {
      await closeFixture()
      rmSync(temporary, { recursive: true, force: true })
    })
    const entry = join(temporary, 'main.cjs')
    const renderer = join(temporary, 'renderer')
    const preload = join(temporary, 'menu.js')
    await buildRenderer({
      root: join(directory, 'src/renderer'),
      configFile: false,
      base: './',
      plugins: [react(), supportedFontSources()],
      build: {
        outDir: renderer,
        rollupOptions: { input: join(directory, 'src/renderer/menu.html') },
      },
    })
    await bundle({
      entryPoints: [join(directory, 'src/preload/menu.ts')],
      outfile: preload,
      platform: 'node',
      format: 'cjs',
      bundle: true,
      external: ['electron'],
    })
    await bundle({
      stdin: {
        contents: `
    import { app, BrowserWindow, WebContentsView, session, ipcMain } from 'electron'
    import { createServer } from 'node:http'
    import { createMenuOwner, MenuActionRegistry } from './src/main/menuhost.ts'
    app.setPath('userData', ${JSON.stringify(join(temporary, 'profile'))})
    app.setPath('sessionData', ${JSON.stringify(join(temporary, 'sessions'))})
    globalThis.errors = []
    globalThis.menuDiagnostics = []
    globalThis.menuEvents = []
    globalThis.started = app.whenReady().then(async () => {
      const server=createServer((_request,response)=>{response.writeHead(200,{'Content-Type':'text/html'});response.end('<!doctype html><title>HTTP product host</title>')})
      await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
      globalThis.server=server
      const rendererUrl='http://127.0.0.1:'+server.address().port+'/'
      const window = new BrowserWindow({ width:800,height:600,show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false} })
      const observe=event=>{const alive=!window.isDestroyed();globalThis.menuEvents.push({event,focused:alive&&window.isFocused(),visible:alive&&window.isVisible()})}
      for (const event of ['focus','blur','show','hide']) window.on(event,()=>observe(event))
      await window.loadURL(rendererUrl); window.show(); app.focus({steal:true}); window.focus()
      const page = new WebContentsView({webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}})
      await page.webContents.loadURL('about:blank'); page.setBounds({x:20,y:100,width:600,height:400}); page.setVisible(true); window.contentView.addChildView(page)
      const registry = new MenuActionRegistry()
      registry.register('browser.devtools',{surface:'browser-menu',close:'before',validateValue:value=>value.kind==='boolean',execute:()=>page.webContents.openDevTools({mode:'detach'})})
      const target = {kind:'browser',tabId:'tab',instanceId:String(page.webContents.id),navigationId:1}
      globalThis.page=page; globalThis.window=window
      const owner = createMenuOwner(window,{rendererUrl,ipc:ipcMain,registry,log:line=>globalThis.menuDiagnostics.push(line),directory:${JSON.stringify(renderer)},preload:${JSON.stringify(preload)},
        target:()=>target,createSession:()=>session.fromPartition('menu-react',{cache:false}),createView:webPreferences=>{
          const view=new WebContentsView({webPreferences});globalThis.menuView=view
          for (const event of ['focus','blur','did-finish-load','destroyed']) view.webContents.on(event,()=>observe('contents-'+event))
          globalThis.loaded=new Promise(resolve=>view.webContents.once('did-finish-load',resolve))
          view.webContents.on('console-message',event=>{if(event.level==='error')globalThis.errors.push(event.message)})
          return view
        }})
      globalThis.owner=owner
      globalThis.publish=revision=>{
        const [width,height]=window.getContentSize()
        return owner.publish({sessionId:'react',revision,surface:'browser-menu',anchor:{x:700,y:20,width:32,height:32},viewport:{width,height},theme:'light',language:'en',target,
          items:[{kind:'action',id:'devtools',actionId:'browser.devtools',label:'Developer tools',disabled:false,checked:false,value:{kind:'boolean',value:true}}]})
      }
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
    const environment: Record<string, string> = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined
      )
    )
    delete environment.ELECTRON_RUN_AS_NODE
    context.signal.throwIfAborted()
    runtime.application = await _electron.launch({ args: [entry], env: environment })
    const application = runtime.application
    try {
      context.signal.throwIfAborted()
      await application.evaluate(async () => {
        await (globalThis as unknown as CompiledMenuFixture).started
      })
      await expect
        .poll(() =>
          application.evaluate(() =>
            (globalThis as unknown as CompiledMenuFixture).window.isFocused()
          )
        )
        .toBe(true)
      const revoked = await application.evaluate(() => {
        const fixture = globalThis as unknown as CompiledMenuFixture
        const pending = fixture.publish(1)
        fixture.window.hide()
        return pending
      })
      assert.deepEqual(revoked, { ok: false, error: MENU_ERROR.revoked })
      await application.evaluate(({ app }) => {
        const { window } = globalThis as unknown as CompiledMenuFixture
        window.show()
        app.focus({ steal: true })
        window.focus()
      })
      await expect
        .poll(() =>
          application.evaluate(() =>
            (globalThis as unknown as CompiledMenuFixture).window.isFocused()
          )
        )
        .toBe(true)
      await application.evaluate(() => {
        const fixture = globalThis as unknown as CompiledMenuFixture
        fixture.painted = fixture.publish(2)
      })
      const beforePaint = await application.evaluate(async () => {
        const fixture = globalThis as unknown as CompiledMenuFixture
        await fixture.started
        await Promise.race([
          fixture.loaded,
          fixture.painted.then((reply) => {
            if (!reply.ok)
              throw new Error(
                JSON.stringify({
                  reply,
                  events: fixture.menuEvents,
                  diagnostics: fixture.menuDiagnostics,
                })
              )
          }),
        ])
        const { menuView, window } = fixture
        return {
          attached: window.contentView.children.includes(menuView),
          visible: menuView.getVisible(),
          document: await menuView.webContents.executeJavaScript(
            `new Promise(resolve=>{requestAnimationFrame(()=>resolve({raf:true,html:document.body.innerHTML}));setTimeout(()=>resolve({raf:false,html:document.body.innerHTML}),500)})`
          ),
        }
      })
      console.log('Actual compiled menu prepaint observation', JSON.stringify(beforePaint))
      const reply = await application.evaluate(async () => {
        const fixture = globalThis as unknown as CompiledMenuFixture
        await fixture.started
        return await fixture.painted
      })
      const diagnostics = await application.evaluate(() => {
        const fixture = globalThis as unknown as CompiledMenuFixture
        return {
          errors: fixture.errors,
          events: fixture.menuEvents,
          diagnostics: fixture.menuDiagnostics,
        }
      })
      console.log('Native menu lifecycle', JSON.stringify({ reply, ...diagnostics }))
      assert.equal(reply.ok, true, JSON.stringify(diagnostics))
      const state = await application.evaluate(async () => {
        const { menuView, page } = globalThis as unknown as CompiledMenuFixture
        return {
          focused: menuView.webContents.isFocused(),
          visible: menuView.getVisible(),
          pageVisible: page.getVisible(),
          pageBounds: page.getBounds(),
          document: await menuView.webContents.executeJavaScript(
            `({background:getComputedStyle(document.body).backgroundColor,menu:document.querySelector('[role="menu"]')?.textContent,focused:document.activeElement?.textContent,product:typeof window.scholarseed})`
          ),
        }
      })
      assert.equal(state.focused, true)
      assert.equal(state.visible, true)
      assert.equal(state.pageVisible, true)
      assert.deepEqual(state.pageBounds, { x: 20, y: 100, width: 600, height: 400 })
      assert.equal(state.document.background, 'rgba(0, 0, 0, 0)')
      assert.equal(state.document.product, 'undefined')
      assert.equal(state.document.menu, 'Developer tools')
    } finally {
      await closeFixture()
    }
  }
)
