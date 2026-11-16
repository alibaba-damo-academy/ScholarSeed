import assert from 'node:assert/strict'
import path from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'
import { chromium, expect, type Page } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { transformWithEsbuild, type Plugin } from 'vite'
import { renderServers } from '../../../../test-helpers/render.ts'
import type { ResourceAgentOrigin } from './api'

const servers = renderServers({ after })
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const PREFIX = '\0resource-origin-probe:'
type ProbeWindow = Window & {
  probe: {
    pending: ((origin: ResourceAgentOrigin | null) => void)[]
    requests: { projectId: string; path: string }[]
    opened: unknown[][]
    refresh: () => void
    select: (document: { projectId: string; path: string }) => void
  }
}
const modules: Record<string, string> = {
  './api': `export function fetchResourceAgentOrigin(projectId, path) {
    window.probe.requests.push({projectId, path})
    return new Promise(resolve => window.probe.pending.push(resolve))
  }`,
  '../../store': `
    import {useSyncExternalStore} from 'react'
    let revision = 0
    const subscribers = new Set()
    const act = {openPanelSession: (...args) => window.probe.opened.push(args)}
    export function useApp() {
      const value = useSyncExternalStore(callback => {subscribers.add(callback); return () => subscribers.delete(callback)}, () => revision)
      window.probe.refresh = () => {revision++; subscribers.forEach(callback => callback())}
      return {state: {sessionCatalogRevision: value, sessions: []}, act}
    }
  `,
  'react-i18next': `export const useTranslation = () => ({t: key => key})`,
  '../../icons': `export const Icon = () => null`,
  '../../components/ui': `
    import React from 'react'
    export const Button = ({children, icon, loading, disabled, size, variant, ...props}) => <button disabled={loading || disabled} {...props}>{children}</button>
  `,
}
const names = ['origin-entry', ...Object.keys(modules)]
const entry = `
  import React, {useState} from 'react'
  import {createRoot} from 'react-dom/client'
  import {ResourceAgentOriginAction} from '/features/resources/Origin.tsx'
  window.probe = {pending: [], requests: [], opened: []}
  function Probe() {
    const [document, select] = useState({projectId: 'project', path: 'first.md'})
    window.probe.select = select
    return <ResourceAgentOriginAction {...document}/>
  }
  createRoot(document.getElementById('root')).render(<Probe/>)
`
const plugin: Plugin = {
  name: 'resource-origin-probe',
  enforce: 'pre',
  resolveId(source, importer) {
    if (source.startsWith(PREFIX)) return source
    if (
      source === 'origin-entry' ||
      (importer?.endsWith('/resources/Origin.tsx') && source in modules)
    )
      return PREFIX + names.indexOf(source) + '.tsx'
    return null
  },
  async load(id) {
    if (!id.startsWith(PREFIX)) return null
    return (
      await transformWithEsbuild(
        id === PREFIX + '0.tsx' ? entry : modules[names[Number(id.slice(PREFIX.length, -4))]],
        'resource-origin-probe.tsx',
        { loader: 'tsx', jsx: 'automatic', tsconfigRaw: {} }
      )
    ).code
  },
  configureServer(server) {
    server.middlewares.use('/__origin', (_request, response, next) => {
      server
        .transformIndexHtml(
          '/__origin',
          '<div id="root"></div><script type="module" src="/@id/__x00__resource-origin-probe:0.tsx"></script>'
        )
        .then((html) => {
          response.setHeader('Content-Type', 'text/html')
          response.end(html)
        })
        .catch(next)
    })
  },
}
const origin: ResourceAgentOrigin = {
  sourceKind: 'answer',
  sessionId: 'source',
  sessionDeleted: false,
  turnId: 'turn',
  itemId: 'answer',
  sourceRange: { unit: 'utf16', start: 0, end: 28 },
}

async function respond(page: Page, value: ResourceAgentOrigin | null): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => (window as unknown as ProbeWindow).probe.pending.length))
    .toBeGreaterThan(0)
  await page.evaluate(
    (value) => (window as unknown as ProbeWindow).probe.pending.shift()!(value),
    value
  )
}

test('resource origin follows document identity, not session catalogue changes', async (context) => {
  const server = await servers.create({
    configFile: false,
    root: ROOT,
    plugins: [plugin, react()],
    cacheKey: 'resource-origin',
    optimizeDeps: { noDiscovery: true, include: ['react', 'react-dom/client'] },
    server: { host: '127.0.0.1', port: 0 },
  })
  await server.listen()
  const browser = await chromium.launch({ headless: true })
  try {
    await context.test(
      'catalogue refresh does not request or remove the existing action',
      async () => {
        const page = await browser.newPage()
        await page.goto(`${server.resolvedUrls!.local[0]}__origin`)
        await respond(page, origin)
        const button = page.getByTestId('resource-agent-origin')
        await expect(button).toBeVisible()
        await page.evaluate(async () => {
          const probe = (window as unknown as ProbeWindow).probe
          for (let revision = 0; revision < 5; revision++) {
            probe.refresh()
            await new Promise(requestAnimationFrame)
          }
        })
        assert.equal(
          await page.evaluate(() => (window as unknown as ProbeWindow).probe.requests.length),
          1
        )
        await expect(button).toBeVisible()
        await page.close()
      }
    )
    await context.test(
      'click revalidates without hiding and preserves exact navigation focus',
      async () => {
        const page = await browser.newPage()
        await page.goto(`${server.resolvedUrls!.local[0]}__origin`)
        await respond(page, origin)
        const button = page.getByTestId('resource-agent-origin')
        await button.click()
        await expect(button).toBeVisible()
        assert.equal(
          await page.evaluate(() => (window as unknown as ProbeWindow).probe.opened.length),
          0
        )
        await respond(page, origin)
        await expect
          .poll(() => page.evaluate(() => (window as unknown as ProbeWindow).probe.opened.length))
          .toBe(1)
        assert.deepEqual(
          await page.evaluate(() => (window as unknown as ProbeWindow).probe.opened[0]),
          [
            { id: 'source', title: 'source', status: 'dormant', openable: true },
            { turnId: 'turn', itemId: 'answer', sourceRange: origin.sourceRange },
          ]
        )
        await button.click()
        await respond(page, { ...origin, sessionDeleted: true })
        await expect(page.getByTestId('resource-agent-origin-deleted')).toBeVisible()
        await expect(button).toHaveCount(0)
        assert.equal(
          await page.evaluate(() => (window as unknown as ProbeWindow).probe.opened.length),
          1
        )
        await page.close()
      }
    )
    await context.test(
      'switching document rejects a late click response and clears the old source',
      async () => {
        const page = await browser.newPage()
        await page.goto(`${server.resolvedUrls!.local[0]}__origin`)
        await respond(page, origin)
        await page.getByTestId('resource-agent-origin').click()
        await page.evaluate(() =>
          (window as unknown as ProbeWindow).probe.select({
            projectId: 'other-project',
            path: 'first.md',
          })
        )
        await expect(page.getByTestId('resource-agent-origin')).toHaveCount(0)
        await expect
          .poll(() => page.evaluate(() => (window as unknown as ProbeWindow).probe.requests.length))
          .toBe(3)
        await respond(page, origin)
        await respond(page, null)
        await expect(page.getByTestId('resource-agent-origin')).toHaveCount(0)
        assert.equal(
          await page.evaluate(() => (window as unknown as ProbeWindow).probe.opened.length),
          0
        )
        await page.evaluate(() =>
          (window as unknown as ProbeWindow).probe.select({
            projectId: 'other-project',
            path: 'second.md',
          })
        )
        await respond(page, { ...origin, sourceKind: 'artifact' })
        await expect(page.getByTestId('resource-agent-origin')).toHaveAttribute(
          'title',
          'origin.artifact'
        )
        await page.close()
      }
    )
  } finally {
    await browser.close()
  }
})
