import assert from 'node:assert/strict'
import path from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser } from '@playwright/test'
import type { Plugin } from 'vite'
import { renderServers } from '../../../../test-helpers/render.ts'

const servers = renderServers({ after })

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const PREFIX = '\0onboarding-adapter:'
const STUBS: Record<string, string> = {
  '../literature/api':
    'export const getLiterature = () => {}; export const listLiteratures = () => {}',
  '../workbench/workspace': 'export const documentWorkspaces = {}',
  '../workbench/tabs': 'export const OVERVIEW_TAB = {id: "overview"}',
  './sample': 'export const SAMPLE_SOURCE = {id: "sample"}',
}

test('project guide uses public file and category controls only on explicit steps', async () => {
  const plugin: Plugin = {
    name: 'onboarding-adapter-test',
    enforce: 'pre',
    resolveId(source, importer) {
      if (importer?.endsWith('/onboarding/adapter.ts') && source in STUBS) return PREFIX + source
      return null
    },
    load(id) {
      return id.startsWith(PREFIX) ? STUBS[id.slice(PREFIX.length)] : null
    },
    configureServer(server) {
      server.middlewares.use('/__onboarding', (_request, response, next) => {
        server
          .transformIndexHtml('/__onboarding', '<div id="root"></div>')
          .then((html) => {
            response.setHeader('Content-Type', 'text/html')
            response.end(html)
          })
          .catch(next)
      })
    },
  }
  const server = await servers.create({
    configFile: false,
    root: ROOT,
    plugins: [plugin],
    cacheKey: 'onboarding',
    optimizeDeps: { noDiscovery: true },
    server: { host: '127.0.0.1', port: 0 },
  })
  let browser: Browser | undefined
  try {
    await server.listen()
    const address = server.httpServer!.address()
    assert.ok(address && typeof address === 'object')
    browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL })
    const page = await browser.newPage()
    await page.goto(`http://127.0.0.1:${address.port}/__onboarding`)
    const result = await page.evaluate(async () => {
      const adapterPath = '/features/onboarding/adapter.ts'
      const contractPath = '/contracts/onboarding.ts'
      const { guideSteps } = await import(adapterPath)
      const { PROJECT_GUIDE_ANCHORS: anchors } = await import(contractPath)
      const calls: string[] = []
      const root = document.getElementById('root')!
      const button = (anchor: string, run: () => void): void => {
        const element = document.createElement('button')
        element.dataset.ob = anchor
        element.textContent = anchor
        element.addEventListener('click', run)
        root.append(element)
      }
      button(anchors.files, () => {
        calls.push('files')
      })
      button(anchors.materialsTab, () => {
        calls.push('materials')
      })
      button(anchors.literatureTab, () => {
        calls.push('literature')
      })
      button(anchors.task, () => {
        calls.push('task')
      })
      const steps = guideSteps(() => {
        throw new Error('project guide must use public controls')
      }, 'project')
      const signal = new AbortController().signal
      await steps[1].navigate!(signal)
      await steps[3].navigate!(signal)
      const aborted = new AbortController()
      aborted.abort()
      let rejected = false
      try {
        await steps[3].navigate!(aborted.signal)
      } catch {
        rejected = true
      }
      return {
        calls,
        rejected,
        targets: steps.map((step: { targets: string[] }) => step.targets),
        firstNavigates: Boolean(steps[0].navigate),
        librarySteps: guideSteps(() => {
          throw new Error('no store read needed')
        }, 'globalLib').map((step: { id: string }) => step.id),
      }
    })
    assert.deepEqual(result.calls, ['task', 'files', 'materials'])
    assert.equal(result.rejected, true)
    assert.equal(result.firstNavigates, false)
    assert.deepEqual(result.librarySteps, [
      'global-library',
      'global-import',
      'global-categories',
      'global-ai',
    ])
    assert.deepEqual(result.targets.flat(), [
      'project-guide-switcher',
      'project-guide-capabilities',
      'project-guide-composer',
      'project-guide-files-tab',
      'project-guide-workspace',
    ])
  } finally {
    await browser?.close()
    await server.close()
  }
})
