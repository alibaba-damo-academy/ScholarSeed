import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { Session } from 'electron'
import { build } from 'esbuild'
import { _electron } from '@playwright/test'
import { validatePluginBinding } from './skills.ts'

const BASE = 'http://127.0.0.1:51823'
const REFERENCE = {
  plugin: 'fixture',
  component: 'selection',
  fingerprint: 'revision',
  binding: 'binding',
}
const HOST_HEADERS = { 'x-test-host-key': 'test-host' }

function sessionWith(fetcher: typeof fetch): Pick<Session, 'fetch'> {
  return { fetch: fetcher }
}

for (const status of [200, 403]) {
  test(`binding validation consumes the complete ${status} response`, async () => {
    let chunks = 0
    const response = new Response(
      new ReadableStream({
        pull(controller) {
          if (chunks === 3) controller.close()
          else {
            chunks += 1
            controller.enqueue(new Uint8Array(32))
          }
        },
      }),
      { status }
    )
    const session = sessionWith(async (input, init) => {
      assert.equal(input, `${BASE}/api/capabilities/skills/plugins/binding`)
      assert.equal(init?.method, 'POST')
      assert.equal(init?.redirect, 'error')
      assert.equal(new Headers(init?.headers).get('Content-Type'), 'application/json')
      assert.equal(new Headers(init?.headers).get('x-test-host-key'), 'test-host')
      assert.deepEqual(JSON.parse(String(init?.body)), { reference: REFERENCE })
      return response
    })
    assert.equal(await validatePluginBinding(session, BASE, REFERENCE, HOST_HEADERS), status)
    assert.equal(response.bodyUsed, true)
    assert.equal(response.body?.locked, false)
    assert.equal(chunks, 3)
  })
}

test('binding validation accepts an empty response', async () => {
  const session = sessionWith(async () => new Response(null, { status: 204 }))
  assert.equal(await validatePluginBinding(session, BASE, REFERENCE, HOST_HEADERS), 204)
})

test('binding validation aborts the original request when the body fails', async () => {
  const failure = new Error('response_disconnected')
  let signal: AbortSignal | null | undefined
  const session = sessionWith(async (_input, init) => {
    signal = init?.signal
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.error(failure)
        },
      })
    )
  })
  await assert.rejects(validatePluginBinding(session, BASE, REFERENCE, HOST_HEADERS), failure)
  assert.equal(signal?.aborted, true)
})

test('binding validation aborts both a stalled fetch and a stalled body', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  for (const phase of ['headers', 'body']) {
    let signal: AbortSignal | null | undefined
    const session = sessionWith(async (_input, init) => {
      signal = init?.signal
      if (phase === 'headers')
        return new Promise((_resolve, reject) => {
          signal!.addEventListener('abort', () => reject(signal!.reason), { once: true })
        })
      return new Response(
        new ReadableStream({
          start(controller) {
            signal!.addEventListener('abort', () => controller.error(signal!.reason), {
              once: true,
            })
          },
        })
      )
    })
    const pending = validatePluginBinding(session, BASE, REFERENCE, HOST_HEADERS)
    const rejected = assert.rejects(pending, /plugin_binding_timeout/)
    await Promise.resolve()
    context.mock.timers.tick(10_000)
    await rejected
    assert.equal(signal?.aborted, true)
  }
})

test('binding validation clears its deadline after completing', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  let signal: AbortSignal | null | undefined
  const session = sessionWith(async (_input, init) => {
    signal = init?.signal
    return new Response('{}')
  })
  await validatePluginBinding(session, BASE, REFERENCE, HOST_HEADERS)
  context.mock.timers.tick(10_000)
  assert.equal(signal?.aborted, false)
})

test(
  'binding validation leaves Chromium connections available after repeated large snapshots',
  { timeout: 30_000 },
  async () => {
    const cache = resolve('node_modules/.cache/plugin-binding')
    await mkdir(cache, { recursive: true })
    const directory = await mkdtemp(join(cache, 'network-'))
    const fixture = join(directory, 'main.cjs')
    await build({
      stdin: {
        contents: `
        import { app, BrowserWindow } from 'electron';
        import { createServer } from 'node:http';
        import { validatePluginBinding } from ${JSON.stringify(resolve('src/main/skills.ts'))};
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
        resolveDir: process.cwd(),
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
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
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
