import assert from 'node:assert/strict'
import path from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'
import { chromium, expect } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { transformWithEsbuild, type Plugin } from 'vite'
import { renderServers } from '../../../../test-helpers/render.ts'

const servers = renderServers({ after })
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const PREFIX = '\0fork-probe:'
type ProbeWindow = Window & {
  probe: {
    pending: ((response: { ok: boolean; json: () => Promise<{ origin: unknown }> }) => void)[]
    opened: [{ id: string }, { itemId: string; turnId: string }][]
    refresh: () => void
  }
}
const modules: Record<string, string> = {
  '../../api': `export const apiFetch = () => new Promise(resolve => window.probe.pending.push(resolve))`,
  '../../store': `
    import {useSyncExternalStore} from 'react'
    let revision = 0
    const subscribers = new Set()
    export function useApp() {
      const value = useSyncExternalStore(callback => {subscribers.add(callback); return () => subscribers.delete(callback)}, () => revision)
      window.probe.refresh = () => {revision++; subscribers.forEach(callback => callback())}
      return {state: {sessionCatalogRevision: value}, act: {openPanelSession: (...args) => window.probe.opened.push(args)}}
    }
  `,
  'react-i18next': `export const useTranslation = () => ({t: (key, params) => params?.title ? 'Branched from ' + params.title : key})`,
  '../../components/ui': `
    import React from 'react'
    export const Button = ({children, loading, disabled, size, variant, ...props}) => <button disabled={loading || disabled} {...props}>{children}</button>
    export {EllipsisText} from '/components/ui/EllipsisText.tsx'
    export {Divider} from '/components/ui/Divider.tsx'
  `,
}
const names = ['fork-entry', ...Object.keys(modules)]
const entry = `
  import React from 'react'
  import '/styles.css'
  import {createRoot} from 'react-dom/client'
  import {ForkOriginDivider} from '/features/assistant/Branch.tsx'
  import {useForkOrigin} from '/features/assistant/origin.ts'
  window.probe = {pending: [], opened: []}
  function Probe() {
    const fork = useForkOrigin('branch')
    return fork.origin ? <ForkOriginDivider {...fork}/> : null
  }
  createRoot(document.getElementById('root')).render(<Probe/>)
`
const plugin: Plugin = {
  name: 'fork-probe',
  enforce: 'pre',
  resolveId(source, importer) {
    if (source.startsWith(PREFIX)) return source
    if (
      source === 'fork-entry' ||
      ((importer?.endsWith('/assistant/Branch.tsx') ||
        importer?.endsWith('/assistant/origin.ts')) &&
        source in modules)
    )
      return PREFIX + names.indexOf(source) + '.tsx'
    return null
  },
  async load(id) {
    if (!id.startsWith(PREFIX)) return null
    return (
      await transformWithEsbuild(
        id === PREFIX + '0.tsx' ? entry : modules[names[Number(id.slice(PREFIX.length, -4))]],
        'fork-probe.tsx',
        { loader: 'tsx', jsx: 'automatic', tsconfigRaw: {} }
      )
    ).code
  },
  configureServer(server) {
    server.middlewares.use('/__fork', (_request, response, next) => {
      server
        .transformIndexHtml(
          '/__fork',
          '<div id="root"></div><script type="module" src="/@id/__x00__fork-probe:0.tsx"></script>'
        )
        .then((html) => {
          response.setHeader('Content-Type', 'text/html')
          response.end(html)
        })
        .catch(next)
    })
  },
}

test('source click revalidates permission and uses exact source and message focus', async () => {
  const server = await servers.create({
    configFile: false,
    root: ROOT,
    plugins: [plugin, react()],
    cacheKey: 'fork',
    optimizeDeps: { noDiscovery: true, include: ['react', 'react-dom/client'] },
    server: { host: '127.0.0.1', port: 0 },
  })
  await server.listen()
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.goto(`${server.resolvedUrls!.local[0]}__fork`)
    const origin = {
      source_session_id: 'actual-child',
      source_product_seq: 7,
      source_turn_id: 'old-turn',
      anchor: { turn_id: 'old-turn', item_id: 'old-answer' },
      inherited_messages: [{ turn_id: 'old-turn', item_id: 'old-answer' }],
      title: 'Source',
      title_fallback: null,
      status: 'available',
      navigation: {
        session_id: 'actual-child',
        title: 'Source',
        title_fallback: null,
        runtime_workdir: '/work',
        project_path: '/project',
        runtime_id: 'codex',
        running: false,
      },
    }
    const respond = async (value: unknown) => {
      await expect
        .poll(() =>
          page.evaluate(() => (window as unknown as ProbeWindow).probe?.pending.length ?? 0)
        )
        .toBe(1)
      await page.evaluate(
        (value) =>
          (window as unknown as ProbeWindow).probe.pending.shift()!({
            ok: true,
            json: async () => ({ origin: value }),
          }),
        value
      )
    }
    await respond(origin)
    const button = page.getByTestId('fork-origin-return')
    await expect(button).toHaveText('Source')
    await expect(
      page.getByTestId('fork-origin-divider').getByText('fork.label', { exact: true })
    ).toBeVisible()
    await expect(page.getByTestId('fork-origin-divider').locator('svg')).toHaveCount(1)
    const title = button.locator('[data-slot="ellipsis-text"]')
    await expect(title).toHaveClass(/text-\[color:var\(--vds-brand-text-primary\)\]/)
    const colors = await title.evaluate((element) => {
      const style = getComputedStyle(element)
      const brand = style.getPropertyValue('--vds-brand-text-primary').trim().slice(1)
      return {
        actual: style.color,
        expected: `rgb(${[0, 2, 4].map((offset) => parseInt(brand.slice(offset, offset + 2), 16)).join(', ')})`,
      }
    })
    assert.equal(colors.actual, colors.expected)
    const dividerWidths = await page
      .getByTestId('fork-origin-divider')
      .locator('hr')
      .evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().width))
    assert.equal(dividerWidths.length, 2)
    assert.ok(
      dividerWidths.every((width) => width > 0),
      'both source divider lines must be visible'
    )
    await button.click()
    assert.equal(
      await page.evaluate(() => (window as unknown as ProbeWindow).probe.opened.length),
      0
    )
    await respond({ ...origin, status: 'forbidden', title: null, navigation: null })
    await expect(button).toBeDisabled()
    await expect(title).not.toHaveClass(/text-\[color:var\(--vds-brand-text-primary\)\]/)
    await expect(page.getByTestId('fork-origin-reason')).toHaveText('fork.reason.forbidden')
    assert.equal(
      await page.evaluate(() => (window as unknown as ProbeWindow).probe.opened.length),
      0
    )
    await page.evaluate(() => (window as unknown as ProbeWindow).probe.refresh())
    await respond({
      ...origin,
      title: 'Renamed',
      navigation: { ...origin.navigation, title: 'Renamed' },
    })
    await expect(button).toHaveText('Renamed')
    await button.focus()
    await page.keyboard.press('Enter')
    await respond({
      ...origin,
      title: 'Renamed',
      navigation: { ...origin.navigation, title: 'Renamed' },
    })
    await expect
      .poll(() => page.evaluate(() => (window as unknown as ProbeWindow).probe.opened.length))
      .toBe(1)
    const opened = await page.evaluate(() => (window as unknown as ProbeWindow).probe.opened[0])
    assert.equal(opened[0].id, 'actual-child')
    assert.deepEqual(opened[1], { itemId: 'old-answer', turnId: 'old-turn' })
  } finally {
    await browser.close()
  }
})
