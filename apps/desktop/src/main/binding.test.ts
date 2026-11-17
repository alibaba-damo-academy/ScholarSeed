import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { _electron } from '@playwright/test'
import { REFERENCE, HOST_HEADERS } from './binding.fixture.ts'

const DESKTOP = fileURLToPath(new URL('../../', import.meta.url))

const electronEnvironment = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
)
delete electronEnvironment.ELECTRON_RUN_AS_NODE

test(
  'binding validation leaves Chromium connections available after repeated large snapshots',
  { timeout: 30_000 },
  async () => {
    const cache = resolve(DESKTOP, 'node_modules/.cache/plugin-binding')
    await mkdir(cache, { recursive: true })
    const directory = await mkdtemp(join(cache, 'network-'))
    const fixture = join(directory, 'main.cjs')
    await build({
      stdin: {
        contents: `
        import { app, BrowserWindow } from 'electron';
        import { createServer } from 'node:http';
        import { validatePluginBinding } from ${JSON.stringify(resolve(DESKTOP, 'src/main/skills.ts'))};
        app.setPath('userData', ${JSON.stringify(join(directory, 'profile'))});
        app.whenReady().then(async () => {
          const bytes = Buffer.alloc(8 * 1024 * 1024, 'x');
          let snapshots = 0;
          const server = createServer((request, response) => {
            request.resume();
            const snapshot = request.url.endsWith('/binding');
            if (snapshot) snapshots += 1;
            const body = snapshot ? bytes : Buffer.from('<html><body>network probe</body></html>');
            response.writeHead(snapshot && snapshots % 2 === 0 ? 403 : 200, {
              'Content-Length': body.length, 'Content-Type': 'text/html', 'Cache-Control': 'no-store'
            });
            response.end(body);
          });
          await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
          const base = 'http://127.0.0.1:' + server.address().port;
          const window = new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
          await window.loadURL(base + '/page');
          const statuses = [];
          for (let index = 0; index < 12; index += 1) {
            statuses.push(await validatePluginBinding(window.webContents.session, base, ${JSON.stringify(REFERENCE)}, ${JSON.stringify(HOST_HEADERS)}));
          }
          const main = await window.webContents.session.fetch(base + '/main', {signal:AbortSignal.timeout(2000)});
          await main.text();
          const renderer = await window.webContents.executeJavaScript(
            "fetch('/renderer', {signal:AbortSignal.timeout(2000)}).then(async response => { await response.text(); return response.status; })"
          );
          globalThis.bindingResult = {snapshots,statuses,main:main.status,renderer,electron:process.versions.electron};
          app.on('before-quit', () => { server.closeAllConnections(); server.close(); });
        });`,
        resolveDir: DESKTOP,
        sourcefile: 'binding-network.ts',
      },
      outfile: fixture,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: ['electron'],
    })
    const application = await _electron.launch({
      args: [fixture],
      env: electronEnvironment,
    })
    try {
      const page = await application.firstWindow()
      await page.waitForLoadState('load')
      const result = await application.evaluate(async () => {
        const deadline = Date.now() + 15_000
        while (!(globalThis as unknown as { bindingResult?: unknown }).bindingResult) {
          if (Date.now() >= deadline) throw new Error('binding_probe_incomplete')
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
        return (
          globalThis as unknown as {
            bindingResult: {
              snapshots: number
              statuses: number[]
              main: number
              renderer: number
              electron: string
            }
          }
        ).bindingResult
      })
      assert.equal(result.snapshots, 12)
      assert.deepEqual(
        result.statuses,
        Array.from({ length: 12 }, (_value, index) => (index % 2 === 0 ? 200 : 403))
      )
      assert.equal(result.main, 200)
      assert.equal(result.renderer, 200)
      assert.ok(result.electron)
    } finally {
      await application.close()
      await rm(directory, { recursive: true, force: true })
    }
  }
)
