import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import test, { type TestContext } from 'node:test'
import { chromium, type Browser } from '@playwright/test'
import { createServer, type ViteDevServer } from 'vite'

import { RenderFailure, renderFixture, renderServers } from './render.ts'

const CACHE_ROOT = path.resolve(import.meta.dirname, '../../node_modules/.cache')

async function root(
  context: Pick<TestContext, 'after'>,
  releases: () => Promise<unknown>[] = () => []
) {
  await mkdir(CACHE_ROOT, { recursive: true })
  const directory = await mkdtemp(path.join(CACHE_ROOT, 'render-lifecycle-'))
  context.after(async () => {
    const results = await Promise.allSettled(releases())
    const failures = results.filter((result) => result.status === 'rejected')
    if (failures.length)
      throw new RenderFailure(
        failures.map((result) => result.reason),
        'test root cleanup failed'
      )
    await rm(directory, { recursive: true, force: true })
  })
  await writeFile(path.join(directory, 'index.html'), '<!doctype html><title>Fixture</title>')
  return directory
}

test('shared renderer resources keep each case isolated and close before process exit', async (context) => {
  let fixture: Awaited<ReturnType<typeof renderFixture>> | undefined
  const directory = await root(context, () => [fixture?.close() ?? Promise.resolve()])
  fixture = await renderFixture(directory)
  const active = fixture
  for (const iteration of ['first', 'second']) {
    await context.test(iteration, async (child) => {
      const page = await active.page(child)
      await page.goto(active.url)
      assert.equal(await page.evaluate('localStorage.getItem("case")'), null)
      assert.deepEqual(await page.context().cookies(), [])
      assert.equal(await page.evaluate('"caseValue" in window'), false)
      await page.evaluate(
        `localStorage.setItem("case", ${JSON.stringify(iteration)}); window.caseValue = ${JSON.stringify(iteration)}`
      )
      await page.context().addCookies([{ name: 'case', value: iteration, url: active.url }])
    })
    assert.equal(fixture.browser.contexts().length, 0)
  }
  await fixture.close()
  assert.equal(fixture.browser.isConnected(), false)
  assert.equal(fixture.server.httpServer?.listening, false)
  assert.equal(fixture.server.httpServer?.address(), null)
  assert.equal(existsSync(fixture.server.config.cacheDir), false)
  await fixture.close()
})

test('page initialization failure retains its error and releases the real context through its registered hook', async (context) => {
  let fixture: Awaited<ReturnType<typeof renderFixture>> | undefined
  const directory = await root(context, () => [fixture?.close() ?? Promise.resolve()])
  fixture = await renderFixture(directory)
  const browser = fixture.browser
  const createContext = browser.newContext.bind(browser)
  const hooks: (() => void | Promise<void>)[] = []
  const failure = new Error('injected page initialization failure')
  browser.newContext = async () => {
    const isolated = await createContext()
    isolated.newPage = async () => {
      throw failure
    }
    return isolated
  }
  try {
    await assert.rejects(
      fixture.page({
        after: (callback) => {
          if (callback)
            hooks.push(() =>
              callback(context, (error) => {
                if (error) throw error
              })
            )
        },
      }),
      (error) => error === failure
    )
    assert.equal(hooks.length, 1)
    assert.equal(browser.contexts().length, 1)
  } finally {
    browser.newContext = createContext
    for (const release of hooks) await release()
  }
  assert.equal(browser.contexts().length, 0)
})

test('browser startup failure closes the actual listening server and its isolated cache', async (context) => {
  let server: ViteDevServer | undefined
  const directory = await root(context, () => [server?.close() ?? Promise.resolve()])
  const failure = new Error('injected browser startup failure')
  await assert.rejects(
    renderFixture(directory, {
      create: async (config) => {
        server = await createServer(config)
        return server
      },
      launch: async () => {
        assert.equal(server?.httpServer?.listening, true)
        throw failure
      },
    }),
    (error) => error === failure
  )
  assert.ok(server)
  assert.equal(server.httpServer?.listening, false)
  assert.equal(existsSync(server.config.cacheDir), false)
  assert.equal(existsSync(path.join(directory, 'node_modules')), false)
})

test('server construction failure removes its owned cache and keeps the original error', async (context) => {
  const directory = await root(context)
  let cache: string | undefined
  const failure = new Error('injected server construction failure')
  await assert.rejects(
    renderFixture(directory, {
      create: async (config) => {
        cache = config?.cacheDir
        throw failure
      },
    }),
    (error) => error === failure
  )
  assert.ok(cache)
  assert.equal(existsSync(cache), false)
})

test('browser cleanup failure does not prevent listener cleanup or hide the surviving browser', async (context) => {
  let browser: Browser | undefined
  let recover: (() => Promise<void>) | undefined
  const directory = await root(context, () => [recover?.() ?? Promise.resolve()])
  const failure = new Error('injected browser close failure')
  const fixture = await renderFixture(directory, {
    launch: async () => {
      browser = await chromium.launch({ headless: true })
      recover = browser.close.bind(browser)
      browser.close = async () => {
        throw failure
      }
      return browser
    },
  })
  try {
    await assert.rejects(fixture.close(), (error) => {
      assert.ok(error instanceof RenderFailure)
      assert.ok(error.errors.includes(failure))
      return true
    })
    assert.equal(browser?.isConnected(), true)
    assert.equal(fixture.server.httpServer?.address(), null)
    assert.equal(existsSync(fixture.server.config.cacheDir), false)
  } finally {
    await recover?.()
  }
  assert.equal(browser?.isConnected(), false)
})

test('two fixtures with the same source root never share an optimizer cache or lifecycle', async (context) => {
  let first: Awaited<ReturnType<typeof renderFixture>> | undefined
  let second: Awaited<ReturnType<typeof renderFixture>> | undefined
  const directory = await root(context, () => [
    first?.close() ?? Promise.resolve(),
    second?.close() ?? Promise.resolve(),
  ])
  first = await renderFixture(directory)
  second = await renderFixture(directory)
  assert.notEqual(first.server.config.cacheDir, second.server.config.cacheDir)
  await first.close()
  assert.equal(second.server.httpServer?.listening, true)
  assert.equal(second.browser.isConnected(), true)
  assert.equal(existsSync(second.server.config.cacheDir), true)
  await second.close()
  assert.equal(second.server.httpServer?.listening, false)
})

test('startup and actual server cleanup failures remain visible until explicit recovery', async (context) => {
  let server: ViteDevServer | undefined
  let recover: (() => Promise<void>) | undefined
  const directory = await root(context, () => [recover?.() ?? Promise.resolve()])
  const startup = new Error('injected startup failure')
  const cleanup = new Error('injected listening server close failure')
  try {
    await assert.rejects(
      renderFixture(directory, {
        create: async (config) => {
          server = await createServer(config)
          recover = server.close.bind(server)
          server.close = async () => {
            throw cleanup
          }
          return server
        },
        launch: async () => {
          throw startup
        },
      }),
      (error) => {
        assert.ok(error instanceof RenderFailure)
        assert.ok(error.errors.includes(startup))
        assert.ok(
          error.errors.some(
            (item) => item instanceof RenderFailure && item.errors.includes(cleanup)
          )
        )
        return true
      }
    )
    assert.ok(server)
    assert.equal(server.httpServer?.listening, true)
    assert.equal(existsSync(server.config.cacheDir), true)
  } finally {
    await recover?.()
  }
  assert.equal(server?.httpServer?.listening, false)
})

test('file-scoped optimizer caches stay outside source, reuse only compilation and release before exit', async (context) => {
  const scopes: ReturnType<typeof renderServers>[] = []
  const directory = await root(context, () => scopes.map((scope) => scope.close()))
  const scope = renderServers(context)
  scopes.push(scope)
  const config = {
    configFile: false as const,
    root: directory,
    cacheKey: 'same-fixture',
    optimizeDeps: { noDiscovery: true },
    server: { host: '127.0.0.1', port: 0 },
  }
  const first = await scope.create(config)
  await first.listen()
  const cache = first.config.cacheDir
  assert.equal(existsSync(path.join(directory, 'node_modules')), false)
  assert.ok(
    path.relative(path.resolve(import.meta.dirname, '..'), cache).startsWith(`..${path.sep}`)
  )
  await writeFile(path.join(cache, 'compiler-marker'), 'compiled data, not browser state')
  await first.close()
  const second = await scope.create(config)
  await second.listen()
  assert.equal(second.config.cacheDir, cache)
  assert.equal(
    await readFile(path.join(cache, 'compiler-marker'), 'utf8'),
    'compiled data, not browser state'
  )
  const distinct = await scope.create({ ...config, cacheKey: 'other-fixture' })
  assert.notEqual(distinct.config.cacheDir, cache)
  const independent = renderServers(context)
  scopes.push(independent)
  const foreign = await independent.create(config)
  await foreign.listen()
  assert.notEqual(foreign.config.cacheDir, cache)
  await scope.close()
  for (const server of [first, second, distinct]) {
    assert.notEqual(server.httpServer?.listening, true)
    assert.equal(existsSync(server.config.cacheDir), false)
  }
  assert.equal(foreign.httpServer?.listening, true)
  assert.equal(existsSync(foreign.config.cacheDir), true)
  await independent.close()
  assert.equal(foreign.httpServer?.address(), null)
  assert.equal(existsSync(foreign.config.cacheDir), false)
  await assert.rejects(scope.create(config), /scope is closed/)
})

test('scope hook cleans a real server after failed startup without relying on case finally', async (context) => {
  const lifecycle: { scope?: ReturnType<typeof renderServers> } = {}
  const directory = await root(context, () => [lifecycle.scope?.close() ?? Promise.resolve()])
  const releases: (() => Promise<void>)[] = []
  const scope = renderServers({
    after: (callback) => {
      assert.ok(callback)
      releases.push(callback)
    },
  })
  lifecycle.scope = scope
  context.after(scope.close)
  const server = await scope.create({
    configFile: false,
    root: directory,
    cacheKey: 'startup',
    optimizeDeps: { noDiscovery: true },
    server: { host: '127.0.0.1', port: 0 },
  })
  const listen = server.listen.bind(server)
  const failure = new Error('injected failure after actual listener initialization')
  server.listen = async () => {
    await listen()
    throw failure
  }
  await assert.rejects(server.listen(), (error) => error === failure)
  assert.equal(server.httpServer?.listening, true)
  assert.equal(releases.length, 1)
  await releases[0]()
  assert.equal(server.httpServer?.address(), null)
  assert.equal(existsSync(server.config.cacheDir), false)
})

test('scope preserves real cleanup failures and still closes its other listeners', async (context) => {
  const lifecycle: { recover?: () => Promise<void>; cache?: string; second?: ViteDevServer } = {}
  const directory = await root(context, () => [
    (async () => {
      await lifecycle.recover?.()
      if (lifecycle.cache) await rm(lifecycle.cache, { recursive: true, force: true })
    })(),
    (async () => {
      await lifecycle.second?.close()
      if (lifecycle.second)
        await rm(lifecycle.second.config.cacheDir, { recursive: true, force: true })
    })(),
  ])
  let release: (() => Promise<unknown>) | undefined
  const scope = renderServers({
    after: (callback) => {
      assert.ok(callback)
      release = callback
    },
  })
  const config = {
    configFile: false as const,
    root: directory,
    cacheKey: 'failed',
    optimizeDeps: { noDiscovery: true },
    server: { host: '127.0.0.1', port: 0 },
  }
  const first = await scope.create(config)
  await first.listen()
  const cache = first.config.cacheDir
  const recover = first.close.bind(first)
  Object.assign(lifecycle, { cache, recover })
  const failure = new Error('injected live listener close failure')
  first.close = async () => {
    throw failure
  }
  const second = await scope.create({ ...config, cacheKey: 'healthy' })
  lifecycle.second = second
  await second.listen()
  assert.ok(release)
  await assert.rejects(
    release(),
    (error) => error instanceof RenderFailure && error.errors.includes(failure)
  )
  assert.equal(first.httpServer?.listening, true)
  assert.equal(existsSync(cache), true)
  assert.equal(second.httpServer?.address(), null)
  first.close = recover
  await recover()
  await rm(second.config.cacheDir, { recursive: true, force: true })
  await assert.rejects(scope.close(), RenderFailure)
})

test('scope removes the allocated cache when server construction rejects', async (context) => {
  const directory = await root(context)
  let cache: string | undefined
  const failure = new Error('injected scoped server construction failure')
  const scope = renderServers(context, {
    create: async (config) => {
      cache = config?.cacheDir
      throw failure
    },
  })
  await assert.rejects(
    scope.create({ root: directory, configFile: false, cacheKey: 'construction' }),
    (error) => error === failure
  )
  assert.ok(cache)
  assert.equal(existsSync(cache), true)
  await scope.close()
  assert.equal(existsSync(cache), false)
})
