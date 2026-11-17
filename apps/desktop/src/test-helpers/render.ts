import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import type { TestContext } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium, type Browser } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer, type InlineConfig, type ViteDevServer } from 'vite'
import { RENDERER_SHARED_DEPENDENCIES, RENDERER_OPTIMIZE_DEPS } from '../../renderer.ts'

const CACHE_SEGMENTS = ['node_modules', '.vite-tests']
const CACHE_ROOT = path.resolve(import.meta.dirname, '../..', ...CACHE_SEGMENTS)
const CACHE_PREFIX = 'render-'
const DESKTOP_ROOT = path.resolve(import.meta.dirname, '../..')
const SOURCE_ROOTS = [DESKTOP_ROOT, path.resolve(DESKTOP_ROOT, '../../packages/ui')]
const LOOPBACK_HOST = '127.0.0.1'
const AUTOMATIC_PORT = 0
const OPTIMIZER_DRAIN_TIMEOUT_MS = 15_000

export function renderConfig(config: InlineConfig): InlineConfig {
  assert.ok(config.root, 'render server requires an explicit source root')
  return {
    ...config,
    optimizeDeps: config.optimizeDeps ?? RENDERER_OPTIMIZE_DEPS,
    resolve: {
      ...config.resolve,
      dedupe: [...new Set([...RENDERER_SHARED_DEPENDENCIES, ...(config.resolve?.dedupe ?? [])])],
    },
    server: {
      ...config.server,
      fs: {
        ...config.server?.fs,
        allow: [
          ...new Set([
            path.resolve(config.root),
            ...SOURCE_ROOTS,
            ...(config.server?.fs?.allow ?? []),
          ]),
        ],
      },
    },
  }
}

interface RenderDependencies {
  create?: (config: InlineConfig) => Promise<ViteDevServer>
  launch?: () => Promise<Browser>
  optimizerDrainTimeoutMs?: number
}

export class RenderFailure extends Error {
  readonly errors: readonly unknown[]

  constructor(errors: readonly unknown[], message: string) {
    super(message)
    this.name = RenderFailure.name
    this.errors = errors
  }
}

export async function renderFixture(root: string, dependencies: RenderDependencies = {}) {
  const parent = CACHE_ROOT
  await mkdir(parent, { recursive: true })
  const cache = await mkdtemp(path.join(parent, CACHE_PREFIX))
  let server: ViteDevServer | undefined
  let browser: Browser | undefined
  let closing: Promise<void> | undefined

  async function release() {
    const errors: unknown[] = []
    let cacheIdle = true
    if (browser) {
      try {
        await browser.close()
        assert.equal(browser.isConnected(), false, 'render browser survived close')
      } catch (error) {
        errors.push(error)
      }
    }
    if (server) {
      try {
        const optimizer = server.environments.client.depsOptimizer
        if (optimizer) {
          const deadline = new AbortController()
          try {
            await Promise.race([
              (async () => {
                await optimizer.scanProcessing
                await Promise.all(
                  Object.values(optimizer.metadata.discovered).map(
                    (dependency) => dependency.processing
                  )
                )
              })(),
              delay(dependencies.optimizerDrainTimeoutMs ?? OPTIMIZER_DRAIN_TIMEOUT_MS, undefined, {
                signal: deadline.signal,
              }).then(() => {
                throw new Error(`render optimizer did not drain; retained cache: ${cache}`)
              }),
            ])
          } finally {
            deadline.abort()
          }
        }
      } catch (error) {
        cacheIdle = false
        errors.push(error)
      }
      try {
        await server.close()
        assert.equal(server.httpServer?.listening, false, 'render listener survived close')
      } catch (error) {
        errors.push(error)
      }
    }
    if (cacheIdle && !server?.httpServer?.listening) {
      try {
        await rm(cache, { recursive: true, force: true })
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length) throw new RenderFailure(errors, 'render fixture cleanup failed')
  }

  function close() {
    closing ??= release()
    return closing
  }

  try {
    server = await (dependencies.create ?? createServer)(
      renderConfig({
        configFile: false,
        root,
        cacheDir: cache,
        plugins: [react()],
        resolve: { dedupe: RENDERER_SHARED_DEPENDENCIES },
        server: {
          host: LOOPBACK_HOST,
          port: AUTOMATIC_PORT,
          fs: { allow: [root, ...SOURCE_ROOTS] },
        },
      })
    )
    await server.listen()
    const url = server.resolvedUrls?.local[0]
    assert.ok(url, 'render fixture has no local URL')
    browser = await (
      dependencies.launch ??
      (() => chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL }))
    )()
    const activeBrowser = browser
    return {
      server,
      browser,
      url,
      close,
      async page(context: Pick<TestContext, 'after'>) {
        const isolated = await activeBrowser.newContext()
        context.after(async () => {
          await isolated.close()
          assert.equal(activeBrowser.contexts().includes(isolated), false)
        })
        return isolated.newPage()
      },
    }
  } catch (error) {
    try {
      await close()
    } catch (cleanup) {
      throw new RenderFailure([error, cleanup], 'render fixture startup and cleanup failed')
    }
    throw error
  }
}

export function renderServers(
  context: { after: (callback: () => Promise<void>) => void },
  dependencies: Pick<RenderDependencies, 'create'> = {}
) {
  const caches = new Map<string, Promise<string>>()
  const servers = new Set<ViteDevServer>()
  const pending = new Set<Promise<ViteDevServer>>()
  let closing: Promise<void> | undefined

  async function release() {
    await Promise.allSettled([...pending])
    const errors: unknown[] = []
    for (const server of servers) {
      try {
        await server.close()
        assert.notEqual(server.httpServer?.listening, true, 'render listener survived close')
      } catch (error) {
        errors.push(error)
      }
    }
    if (!errors.length) {
      for (const allocated of caches.values()) {
        try {
          await rm(await allocated, { recursive: true, force: true })
        } catch (error) {
          errors.push(error)
        }
      }
    }
    if (errors.length) throw new RenderFailure(errors, 'render server scope cleanup failed')
  }

  function close() {
    closing ??= release()
    return closing
  }

  context.after(close)

  return {
    close,
    async create({ cacheKey, ...config }: InlineConfig & { cacheKey: string }) {
      assert.equal(closing, undefined, 'render server scope is closed')
      assert.ok(config.root, 'render server scope requires an explicit source root')
      assert.ok(cacheKey, 'render server scope requires a cache identity')
      const identity = JSON.stringify([path.resolve(config.root), cacheKey])
      let allocated = caches.get(identity)
      if (!allocated) {
        allocated = mkdir(CACHE_ROOT, { recursive: true }).then(() =>
          mkdtemp(path.join(CACHE_ROOT, CACHE_PREFIX))
        )
        caches.set(identity, allocated)
      }
      const creating = allocated.then(async (cacheDir) => {
        const server = await (dependencies.create ?? createServer)(
          renderConfig({ ...config, cacheDir })
        )
        servers.add(server)
        return server
      })
      pending.add(creating)
      try {
        return await creating
      } finally {
        pending.delete(creating)
      }
    },
  }
}
