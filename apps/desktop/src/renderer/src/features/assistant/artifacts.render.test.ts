import assert from 'node:assert/strict'
import path from 'node:path'
import test, { after } from 'node:test'
import { chromium, expect } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { transformWithEsbuild, type Plugin } from 'vite'
import { renderServers } from '../../../../test-helpers/render.ts'

const servers = renderServers({ after })
const ROOT = path.resolve(import.meta.dirname, '../..')
const PREFIX = '\0artifact-layout:'
const ENTRY = 'artifact-layout-entry'
const TITLE = 'AI智能体在科研工作流中的应用系统、协作机制与评估方法的研究进展及未来挑战文献综述'
const WIDTHS = [758, 326, 240]
type ProbeWindow = Window & {
  probe: { literature: unknown; attachment: unknown; retried?: boolean }
}
const modules: Record<string, string> = {
  '../../store': `
    export const activeThread = () => ({sessionId: 'session', projectPath: '/project', workdir: '/session'})
    export const useApp = () => ({
      state: {
        projects: [{id: 'project', path: '/project', name: 'Project'}],
        homeSelectedProjectId: 'project', resource: {tree: []},
        aiPanel: {sessionId: 'session', artifactLinksState: new URLSearchParams(location.search).get('links') || 'ready', artifactLinks: [{
          destination: 'literature', artifact_id: 'artifact', state: 'completed',
          project_id: 'project', items: [{id: 'paper', title: window.probe.title}], missing_ids: []
        }]}
      },
      act: {
        reloadArtifactLinks: () => {window.probe.retried = true},
        openLiteratureAttachment: (id, attachment) => {window.probe.attachment = {id, attachment}},
        openLiteratureItem: (id, project) => {window.probe.literature = {id, project}},
        openFilePreview: target => {window.probe.preview = target}
      },
      set: () => {}
    })
  `,
  '../../components/business/SessionArtifacts': `import {createContext} from 'react'; export const OverviewActionsContext = createContext(() => {})`,
  '../../components/primitive': `export const FileFormatIcon = () => null`,
  './Save': `export const ResourceSaveDialog = () => null`,
}
const names = [ENTRY, ...Object.keys(modules)]
const plugin: Plugin = {
  name: 'artifact-layout',
  enforce: 'pre',
  resolveId(source, importer) {
    if (source.startsWith(PREFIX)) return source
    if (importer?.endsWith('/business/SessionArtifacts.tsx') && source === '../../api')
      return '\0overview-api'
    if (
      source === ENTRY ||
      ((importer?.endsWith('/assistant/Artifacts.tsx') ||
        importer?.endsWith('/business/SessionArtifacts.tsx')) &&
        source in modules)
    )
      return PREFIX + names.indexOf(source) + '.tsx'
    return null
  },
  async load(id) {
    if (id === '\0overview-api')
      return `
      export const getSessionFiles = async () => ({root: '/session', items: [], literature: [
        {id: 'delivery', title: 'Paper', literature_id: 'paper', attachment_id: 'pdf'}
      ]})
      export const openSystemPath = async () => ({ok: true})
    `
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
      import {ToastProvider} from '/components/ui'
      import {ArtifactEntry} from '/features/assistant/Artifacts.tsx'
      import * as Actions from '/features/assistant/Artifacts.tsx'
      import {SessionArtifacts} from '/components/business/SessionArtifacts.tsx'
      const title = new URLSearchParams(location.search).get('title')
      window.probe = {title}
      const mode = new URLSearchParams(location.search).get('mode') || 'card'
      const primary = {artifact_id: 'artifact', name: title + '.pdf', path: title + '.pdf', role: 'final', media_type: 'application/pdf', status: 'present', size: 100}
      const localization = createLocalization('zh', resources, {report: () => {}})
      createRoot(document.getElementById('root')).render(
        <I18nextProvider i18n={localization}><ToastProvider>
          <div data-testid="entry" style={{width: mode === 'card' ? '100%' : 40}}>
            {mode === 'document'
              ? <SessionArtifacts renderLiteratureActions={document => React.createElement(Actions.OverviewLiteratureActions, {document})} />
              : <ArtifactEntry primary={primary} versions={[primary]} mode={mode} />}
          </div>
        </ToastProvider></I18nextProvider>
      )
    `
        : modules[name]
    return (
      await transformWithEsbuild(source, 'artifact-layout.tsx', {
        loader: 'tsx',
        jsx: 'automatic',
        tsconfigRaw: {},
      })
    ).code
  },
  configureServer(server) {
    server.middlewares.use('/__artifacts', (_request, response, next) => {
      server
        .transformIndexHtml(
          '/__artifacts',
          '<div id="root"></div><script type="module" src="/@id/__x00__artifact-layout:0.tsx"></script>'
        )
        .then((html) => {
          response.setHeader('Content-Type', 'text/html')
          response.end(html)
        })
        .catch(next)
    })
  },
}

test('artifact cards constrain imported titles and keep both open actions reachable', async () => {
  const server = await servers.create({
    configFile: false,
    root: ROOT,
    plugins: [plugin, react()],
    cacheKey: 'artifacts',
    server: { host: '127.0.0.1', port: 0 },
  })
  await server.listen()
  const browser = await chromium.launch({ headless: true })
  try {
    const address = server.httpServer!.address()
    assert.ok(address && typeof address === 'object')
    const page = await browser.newPage()
    for (const title of [TITLE, 'ResearchWorkflowCollaborationAndEvaluation'.repeat(5)]) {
      await page.goto(
        `http://127.0.0.1:${address.port}/__artifacts?title=${encodeURIComponent(title)}`
      )
      const card = page.locator('[data-artifact-role="final"]')
      const literature = card.getByRole('button', { name: `打开 ${title}`, exact: true })
      await expect(literature).toBeVisible()
      for (const width of WIDTHS) {
        await page.locator('#root').evaluate((element, value) => {
          element.style.width = `${value}px`
        }, width)
        await expect
          .poll(() => card.evaluate((element) => element.scrollWidth - element.clientWidth))
          .toBe(0)
        const bounds = (await card.boundingBox())!
        for (const button of await card.getByRole('button').all()) {
          const buttonBounds = (await button.boundingBox())!
          assert.ok(buttonBounds.x >= bounds.x)
          assert.ok(buttonBounds.x + buttonBounds.width <= bounds.x + bounds.width)
        }
      }
      await literature.hover()
      await expect(page.getByRole('tooltip')).toHaveText(`打开 ${title}`)
      await literature.click()
      assert.deepEqual(
        await page.evaluate(
          () => (window as unknown as { probe: { literature: unknown } }).probe.literature
        ),
        { id: 'paper', project: 'project' }
      )
      await page.getByTestId('artifact-open').click()
      assert.equal(
        await page.evaluate(
          () =>
            (window as unknown as { probe: { preview: { artifactId: string } } }).probe.preview
              .artifactId
        ),
        'artifact'
      )
    }
  } finally {
    await browser.close()
  }
})

test('action-only artifacts keep feedback in the menu instead of the narrow row', async () => {
  const server = await servers.create({
    configFile: false,
    root: ROOT,
    plugins: [plugin, react()],
    cacheKey: 'artifacts-actions',
    server: { host: '127.0.0.1', port: 0 },
  })
  await server.listen()
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    for (const mode of ['actions', 'overview']) {
      for (const links of ['idle', 'loading', 'error', 'ready']) {
        await page.goto(
          `${server.resolvedUrls!.local[0]}__artifacts?title=Paper&mode=${mode}&links=${links}`
        )
        const trigger = page.getByTestId('output-actions-artifact')
        await expect(trigger).toBeVisible()
        const row = page.getByTestId('entry')
        assert.ok((await row.boundingBox())!.height <= 40)
        await expect(row).not.toContainText('已导入')
        await trigger.focus()
        await trigger.press('Enter')
        const menu = page.getByRole('menu').first()
        await expect(menu).toContainText('已导入')
        assert.equal(await menu.evaluate((element) => element.scrollWidth - element.clientWidth), 0)
        if (links === 'idle' || links === 'loading') {
          await expect(menu.getByRole('status')).toContainText('正在查询入库关联')
        } else if (links === 'error') {
          await expect(menu.getByRole('alert')).toBeVisible()
          await menu.getByRole('button', { name: '重试', exact: true }).click()
          assert.equal(
            await page.evaluate(() => (window as unknown as ProbeWindow).probe.retried),
            true
          )
        } else {
          await expect(menu.getByRole('status')).toHaveCount(0)
        }
        await menu.getByRole('button', { name: '打开 Paper', exact: true }).click()
        assert.deepEqual(
          await page.evaluate(() => (window as unknown as ProbeWindow).probe.literature),
          {
            id: 'paper',
            project: 'project',
          }
        )
        await page.keyboard.press('Escape')
        await expect(trigger).toBeFocused()
      }
    }
  } finally {
    await browser.close()
  }
})

test('overview literature has a keyboard-accessible menu without fabricated file paths', async () => {
  const server = await servers.create({
    configFile: false,
    root: ROOT,
    plugins: [plugin, react()],
    cacheKey: 'artifacts-literature',
    server: { host: '127.0.0.1', port: 0 },
  })
  await server.listen()
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.goto(`${server.resolvedUrls!.local[0]}__artifacts?mode=document`)
    await page.getByRole('button', { name: 'Paper', exact: true }).click()
    assert.deepEqual(
      await page.evaluate(() => (window as unknown as ProbeWindow).probe.attachment),
      { id: 'paper', attachment: 'pdf' }
    )
    const trigger = page.getByRole('button', { name: /Paper.*更多|更多.*Paper/ })
    await expect(trigger).toHaveCount(1)
    await trigger.focus()
    await expect(trigger).toHaveCSS('opacity', '1')
    await trigger.press('Enter')
    const menu = page.getByRole('menu').first()
    await expect(menu.getByRole('menuitem')).toHaveCount(3)
    await expect(menu).not.toContainText('复制路径')
    await menu.getByRole('menuitem', { name: '查看基本信息' }).click()
    assert.deepEqual(
      await page.evaluate(() => (window as unknown as ProbeWindow).probe.literature),
      { id: 'paper', project: 'project' }
    )
    await trigger.press('Enter')
    await page.keyboard.press('Escape')
    await expect(trigger).toBeFocused()
  } finally {
    await browser.close()
  }
})
