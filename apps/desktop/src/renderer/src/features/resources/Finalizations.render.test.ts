import assert from 'node:assert/strict'
import path from 'node:path'
import test, { after } from 'node:test'
import { chromium, expect } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { transformWithEsbuild, type Plugin } from 'vite'
import { renderServers } from '../../../../test-helpers/render.ts'

const servers = renderServers({ after })
const ROOT = path.resolve(import.meta.dirname, '../..')
const PREFIX = '\0finalization-layout:'
const ENTRY = 'finalization-layout-entry'
const PATHS = [
  'resources/ideas.md',
  `sessions/session/agentic-search-results/${'nested-directory/'.repeat(12)}report.md`,
  `resources/${'LongUnbrokenFilename'.repeat(16)}.md`,
  `resources/${'长文件名称'.repeat(40)}.md`,
]
const WIDTHS = [758, 360, 240]
const modules: Record<string, string> = {
  '../../store': `const act = {invalidateResources() {}}; export const useApp = () => ({act})`,
  '../workbench/workspace': `
    export const useWorkspaceController = () => ({
      open: async (target, mode) => {window.opened = {target, mode}}
    })
  `,
}
const names = [ENTRY, ...Object.keys(modules)]
const plugin: Plugin = {
  name: 'finalization-layout',
  enforce: 'pre',
  resolveId(source, importer) {
    if (source.startsWith(PREFIX)) return source
    if (
      source === ENTRY ||
      (importer?.endsWith('/resources/Finalizations.tsx') && source in modules)
    )
      return PREFIX + names.indexOf(source) + '.tsx'
    return null
  },
  async load(id) {
    if (!id.startsWith(PREFIX)) return null
    const name = names[Number(id.slice(PREFIX.length, -4))]
    const source =
      name === ENTRY
        ? `
      import React from 'react'
      import {createRoot} from 'react-dom/client'
      import {I18nextProvider} from 'react-i18next'
      import '/browser.ts'
      import '/styles.css'
      import {createLocalization} from '/../../localization/engine.ts'
      import {resources} from '/../../localization/resources.ts'
      import {Finalizations} from '/features/resources/Finalizations.tsx'
      const localization = createLocalization('zh', resources, {report() {}})
      createRoot(document.getElementById('root')).render(
        <I18nextProvider i18n={localization}>
          <Finalizations project="project" sessionId="session" running={false} revision={0} />
        </I18nextProvider>
      )
    `
        : modules[name]
    return (
      await transformWithEsbuild(source, 'finalization-layout.tsx', {
        loader: 'tsx',
        jsx: 'automatic',
        tsconfigRaw: {},
      })
    ).code
  },
  configureServer(server) {
    server.middlewares.use('/__finalizations', (_request, response, next) => {
      server
        .transformIndexHtml(
          '/__finalizations',
          '<div id="root"></div><script type="module" src="/@id/__x00__finalization-layout:0.tsx"></script>'
        )
        .then((html) => {
          response.setHeader('Content-Type', 'text/html')
          response.end(html)
        })
        .catch(next)
    })
  },
}

test('finalization paths wrap within the warning and preserve keyboard file opening', async () => {
  const server = await servers.create({
    configFile: false,
    root: ROOT,
    plugins: [plugin, react()],
    cacheKey: 'finalizations',
    server: { host: '127.0.0.1', port: 0 },
  })
  await server.listen()
  const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL })
  try {
    const page = await browser.newPage()
    await page.route('**/api/resource/finalizations?*', (route) =>
      route.fulfill({
        json: {
          entries: [
            {
              session_id: 'session',
              turn_id: 'turn',
              terminal_outcome: 'completed',
              error: 'unknown_error',
              paths: PATHS,
              created_at_ms: 1,
              snapshot_available: true,
              retryable: true,
            },
          ],
          next_cursor: null,
        },
      })
    )
    await page.goto(new URL('/__finalizations', server.resolvedUrls!.local[0]).href)
    const warning = page.getByTestId('resource-finalization-warning')
    await expect(warning).toBeVisible()
    await expect(warning.getByRole('button', { name: PATHS[1], exact: true })).toHaveCSS(
      'white-space',
      'normal'
    )
    for (const width of WIDTHS) {
      await page.locator('#root').evaluate((element, value) => {
        element.style.width = `${value}px`
      }, width)
      await expect
        .poll(() => warning.evaluate((element) => element.scrollWidth - element.clientWidth))
        .toBe(0)
      const bounds = (await warning.boundingBox())!
      for (const file of PATHS) {
        const button = warning.getByRole('button', { name: file, exact: true })
        await expect(button).toHaveText(file)
        const buttonBounds = (await button.boundingBox())!
        assert.ok(buttonBounds.x >= bounds.x)
        assert.ok(buttonBounds.x + buttonBounds.width <= bounds.x + bounds.width)
        assert.equal(
          await button.evaluate((element) => element.scrollWidth <= element.clientWidth),
          true
        )
        assert.equal(
          await button.evaluate((element) => element.scrollHeight <= element.clientHeight),
          true
        )
        await button.focus()
        await page.keyboard.press('Enter')
        await expect
          .poll(() =>
            page.evaluate(
              () =>
                (
                  window as unknown as {
                    opened: unknown
                  }
                ).opened
            )
          )
          .toEqual({ target: { kind: 'project', project: 'project', path: file }, mode: 'preview' })
      }
    }
  } finally {
    await browser.close()
  }
})
