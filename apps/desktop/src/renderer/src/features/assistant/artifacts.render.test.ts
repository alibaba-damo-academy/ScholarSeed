import assert from 'node:assert/strict'
import path from 'node:path'
import test, { after } from 'node:test'
import { chromium, expect } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { transformWithEsbuild, type Plugin } from 'vite'
import { renderServers } from '../../../../test-helpers/render.ts'
import assistantZh from '../../../../localization/locales/zh/assistant.json' with { type: 'json' }

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
      export const getSessionFiles = async () => ({root: '/session', items: [], artifacts: new URLSearchParams(location.search).get('mode') === 'directory' ? [{
        artifact_id: 'directory', publication_id: 'publication', kind: 'directory', role: 'final', status: 'available', name: 'Snapshot', path: 'source', absolute_path: '/session/source'
      }] : [], literature: [
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
      import {Artifact, ArtifactGroup} from '/components/business/Artifact.tsx'
      import * as Actions from '/features/assistant/Artifacts.tsx'
      import {SessionArtifacts} from '/components/business/SessionArtifacts.tsx'
      const query = new URLSearchParams(location.search)
      const title = query.get('title')
      window.probe = {title, calls: []}
      const mode = query.get('mode') || 'card'
      const primary = {artifact_id: 'artifact', name: title + '.pdf', path: query.get('path') || title + '.pdf', role: 'final', media_type: 'application/pdf', status: 'present', size: 100}
      if (mode === 'directory-card') {
        Object.assign(primary, {kind: 'directory', name: 'Snapshot', path: 'source', absolute_path: '/session/source'})
        window.scholarseed.platform = 'darwin'
        window.scholarseed.writeClipboard = async path => {window.probe.calls.push(['copy', path]); return {ok: true}}
        window.scholarseed.revealPath = async path => {window.probe.calls.push(['reveal', path]); return {ok: true}}
        window.scholarseed.openPath = async path => {window.probe.calls.push(['open', path]); return {ok: true}}
      }
      const localization = createLocalization('zh', resources, {report: () => {}})
      const record = action => window.probe.calls.push(action)
      createRoot(document.getElementById('root')).render(
        <I18nextProvider i18n={localization}><ToastProvider>
          <div data-testid="entry" style={{width: ['card', 'layout', 'directory-card'].includes(mode) ? '100%' : 40}}>
            {mode === 'layout'
              ? <ArtifactGroup>{Array.from({length: Number(query.get('count'))}, (_, i) => {
                  const name = i === 1 ? 'custom.noicon' : 'report-' + i + '.md'
                  const artifact = {...primary, artifact_id: 'file-' + i, title: '', name, path: name, media_type: 'text/plain'}
                  return <ArtifactEntry key={artifact.artifact_id} primary={artifact} versions={[artifact]} />
                })}</ArtifactGroup>
              : mode === 'directory'
              ? <SessionArtifacts onOpenDirectory={artifact => {window.probe.directory = artifact.artifact_id}} />
              : mode === 'menus'
              ? <Artifact primary={primary} versions={[primary]} primaryMeta="" canImport={query.get('importable') === 'true'}
                  preview={() => record('preview')} previewVersion={() => record('version')} openImport={() => record('import')}
                  menuProps={{apps: query.get('apps') === 'none' ? [] : [{name: 'Editor', path: '/sample/editor'}], appsLoading: false,
                    canSaveAs: true, canUsePath: true, downloading: false, loadApps: () => {},
                    onCopyPath: () => record('copy'), onSaveAs: () => record('save'), onReveal: () => record('reveal'),
                    onOpenWith: app => record('app:' + app.path), revealLabel: '显示位置'}} />
              : mode === 'document'
              ? <SessionArtifacts renderLiteratureActions={document => React.createElement(Actions.OverviewLiteratureActions, {document})} />
              : <ArtifactEntry primary={primary} versions={[primary]} mode={mode === 'directory-card' ? 'card' : mode} />}
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

test('image preview artifact menu exposes workbench, applications, import, save as and reveal', async () => {
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
    const page = await browser.newPage()
    await page.goto(`${server.resolvedUrls!.local[0]}__artifacts?mode=preview&title=Image`)
    await page.getByTestId('output-actions-artifact').click()
    const menu = page.getByRole('menu').first()
    await expect(menu).toHaveClass(/vds-z-modal-nested-flyout/)
    for (const label of ['在书深工作台中打开', '打开方式', '导入资料库', '另存为…']) {
      await expect(menu.getByRole('menuitem', { name: label, exact: true })).toBeVisible()
    }
    await expect(menu.getByTestId('artifact-dropdown-save-as')).toBeEnabled()
    await expect(menu.getByTestId('artifact-dropdown-reveal')).toBeVisible()
    await expect(menu.getByTestId('artifact-dropdown-copy-path')).toHaveCount(0)
    await menu.getByRole('menuitem', { name: '在书深工作台中打开', exact: true }).click()
    assert.equal(
      await page.evaluate(
        () =>
          (window as unknown as { probe: { preview: { artifactId: string } } }).probe.preview
            .artifactId
      ),
      'artifact'
    )
  } finally {
    await browser.close()
  }
})

test('artifact cards keep equal column widths and let a single-card group fill its row', async () => {
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
    const page = await browser.newPage()
    for (const count of [1, 2, 3, 5]) {
      await page.goto(`${server.resolvedUrls!.local[0]}__artifacts?mode=layout&count=${count}`)
      const group = page.getByTestId('artifact-group')
      const cards = group.locator('[data-artifact-card]')
      await expect(cards).toHaveCount(count)
      const { width, rows } = await group.evaluate((element) => ({
        width: element.clientWidth,
        rows: [...element.querySelectorAll('[data-artifact-card]')].map((card) => {
          const { x, y, width } = card.getBoundingClientRect()
          return { x, y, width }
        }),
      }))
      assert.equal(new Set(rows.map(({ y }) => y)).size, Math.ceil(count / 2))
      for (let i = 1; i < rows.length; i += 2) {
        assert.equal(rows[i].y, rows[i - 1].y)
        assert.equal(rows[i].width, rows[i - 1].width)
      }
      if (count % 2) {
        assert.equal(rows.at(-1)?.x, rows[0].x)
        const expectedWidth = count === 1 ? width : rows[0].width
        assert.ok(Math.abs(rows.at(-1)!.width - expectedWidth) < 1)
      }
      const first = cards.first().getByTestId('artifact-open')
      await expect(first.locator('img')).toHaveCSS('width', '40px')
      await expect(first.locator('[data-slot=ellipsis-text]').last()).toHaveCSS('font-size', '12px')
      if (count > 1) {
        const outline = cards
          .nth(1)
          .getByTestId('artifact-open')
          .locator('span[aria-hidden]')
          .first()
        await expect(outline).toHaveCSS('width', '40px')
        await expect(outline.locator('svg')).toHaveCSS('width', '20px')
      }
      await page.getByTestId('entry').evaluate((element, width) => {
        element.style.width = `${width}px`
      }, WIDTHS[1])
      const stacked = await cards.evaluateAll((elements) =>
        elements.map((element) => {
          const { width, y } = element.getBoundingClientRect()
          return { width, y }
        })
      )
      assert.equal(new Set(stacked.map(({ y }) => y)).size, count)
      assert.ok(stacked.every(({ width }) => Math.abs(width - WIDTHS[1]) < 1))
      for (const containerWidth of [649, 650, 651]) {
        await page.getByTestId('entry').evaluate((element, width) => {
          element.style.width = `${width}px`
        }, containerWidth)
        const positions = await cards.evaluateAll((elements) =>
          elements.map((element) => element.getBoundingClientRect().y)
        )
        assert.equal(
          new Set(positions).size,
          containerWidth < 650 ? count : Math.ceil(count / 2),
          `Card rows at ${containerWidth}px`
        )
      }
    }
  } finally {
    await browser.close()
  }
})

test('artifact cards constrain imported titles and keep both open actions reachable', async () => {
  const server = await servers.create({
    configFile: false,
    root: ROOT,
    plugins: [plugin, react()],
    cacheKey: 'artifacts',
    server: { host: '127.0.0.1', port: 0 },
  })
  await server.listen()
  const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL })
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
      const receipt = card.locator('[data-artifact-receipt]')
      const background = await receipt.evaluate(
        (element) => getComputedStyle(element).backgroundColor
      )
      await literature.hover()
      await expect(receipt).not.toHaveCSS('box-shadow', 'none')
      await expect(receipt).toHaveCSS('background-color', background)
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

test('file cards expose the full filename and permission-bound import actions', async () => {
  const server = await servers.create({
    configFile: false,
    root: ROOT,
    plugins: [plugin, react()],
    cacheKey: 'artifacts',
    server: { host: '127.0.0.1', port: 0 },
  })
  await server.listen()
  const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL })
  try {
    const page = await browser.newPage()
    const filename = `${TITLE}.pdf`
    for (const importable of [false, true]) {
      await page.goto(
        `${server.resolvedUrls!.local[0]}__artifacts?mode=menus&title=${encodeURIComponent(TITLE)}&path=folder/report.pdf&importable=${importable}`
      )
      await page.getByTestId('entry').evaluate((element, width) => {
        element.style.width = `${width}px`
      }, WIDTHS[1])
      const card = page.getByTestId('turn-artifact-artifact')
      await expect(card.getByTestId('artifact-more-actions')).toHaveCount(0)
      await expect(card.getByTestId('artifact-open-default')).toHaveCount(0)
      await expect(card.getByTestId('artifact-open-options')).toHaveCount(0)
      const open = page.getByTestId('artifact-open')
      const importAction = card.getByTestId('artifact-import-resources')
      if (importable) {
        await page.mouse.move(0, 0)
        await expect(importAction).toBeVisible()
        await open.focus()
        await page.keyboard.press('Tab')
        await expect(importAction).toBeFocused()
      }
      await expect(open).toHaveText(filename)
      await expect(open).toHaveAccessibleName(filename)
      await expect(open).not.toContainText('folder/')
      await open.focus()
      await expect(open).toBeFocused()
      const title = open.locator('[data-slot=ellipsis-text]').first()
      await expect(title).toHaveCSS('font-weight', '500')
      await expect(title).toHaveCSS('font-size', '14px')
      await expect(title).toHaveAttribute('data-overflowing', 'true')
      await expect(open.locator('img')).toHaveCSS('width', '40px')
      const titleBounds = (await title.boundingBox())!
      if (importable) {
        const importBounds = (await importAction.boundingBox())!
        assert.ok(titleBounds.x + titleBounds.width <= importBounds.x)
      }
      if (importable) await expect(importAction).toBeVisible()
      else await expect(importAction).toHaveCount(0)
      const actions: string[] = []
      await open.click()
      actions.push('preview')
      if (importable) {
        await importAction.click()
        actions.push('import')
      }
      await open.click({ button: 'right' })
      const context = page.getByTestId('artifact-context-menu')
      const contextImport = context.getByRole('menuitem', {
        name: assistantZh.artifactEntry.import,
        exact: true,
      })
      await expect(contextImport).toHaveCount(importable ? 1 : 0)
      if (importable) {
        await contextImport.click()
        actions.push('import')
      } else await page.keyboard.press('Escape')
      await expect(context).toBeHidden()
      assert.deepEqual(
        await page.evaluate(
          () => (window as unknown as { probe: { calls: string[] } }).probe.calls
        ),
        actions
      )
    }
    await page.goto(
      `${server.resolvedUrls!.local[0]}__artifacts?mode=menus&title=report&apps=none&importable=true`
    )
    await page.getByTestId('entry').evaluate((element, width) => {
      element.style.width = `${width}px`
    }, WIDTHS[1])
    await expect(page.getByTestId('artifact-open-default')).toHaveCount(0)
    await page.getByTestId('artifact-open').click({ button: 'right' })
    await page.getByTestId('artifact-context-menu').getByRole('menuitem').first().click()
    assert.deepEqual(
      await page.evaluate(() => (window as unknown as { probe: { calls: string[] } }).probe.calls),
      ['preview']
    )
  } finally {
    await browser.close()
  }
})

test('artifact right-click and overflow menus dispatch each selected action once and close', async () => {
  const server = await servers.create({
    configFile: false,
    root: ROOT,
    plugins: [plugin, react()],
    cacheKey: 'artifacts',
    server: { host: '127.0.0.1', port: 0 },
  })
  await server.listen()
  const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL })
  try {
    const address = server.httpServer!.address()
    assert.ok(address && typeof address === 'object')
    const page = await browser.newPage()
    await page.goto(`http://127.0.0.1:${address.port}/__artifacts?mode=menus&title=report`)
    const actions: string[] = []
    {
      const kind = 'context'
      const entries = ['copy-path', 'save-as', 'reveal']
      entries.push('open-with')
      for (const action of entries) {
        await page.getByTestId('artifact-open').click({ button: 'right' })
        const menu = page.getByTestId(`artifact-${kind}-menu`)
        await expect(menu).toBeVisible()
        for (const entry of entries)
          await expect(page.getByTestId(`artifact-${kind}-${entry}`)).toBeEnabled()
        if (action === 'open-with') {
          await page.getByTestId(`artifact-${kind}-open-with`).focus()
          await page.keyboard.press('ArrowRight')
          await page.getByRole('menuitem', { name: 'Editor', exact: true }).click()
          actions.push('app:/sample/editor')
        } else {
          await page.getByTestId(`artifact-${kind}-${action}`).click()
          actions.push(action === 'copy-path' ? 'copy' : action === 'save-as' ? 'save' : action)
        }
        await expect(menu).toBeHidden()
        assert.deepEqual(
          await page.evaluate(
            () => (window as unknown as { probe: { calls: string[] } }).probe.calls
          ),
          actions
        )
      }
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
  const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL })
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

test('directory cards locate the live source only while it is available', async () => {
  const server = await servers.create({
    configFile: false,
    root: ROOT,
    plugins: [plugin, react()],
    cacheKey: 'artifacts-directory-actions',
    server: { host: '127.0.0.1', port: 0 },
  })
  await server.listen()
  const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL })
  try {
    const page = await browser.newPage()
    let sourceExists = true
    await page.route('**/api/serve/sessions/session/files?*', async (route) => {
      assert.equal(new URL(route.request().url()).searchParams.get('path'), '/session/source')
      await route.fulfill({
        status: sourceExists ? 200 : 404,
        json: sourceExists ? { root: '/session', path: 'source', items: [] } : {},
      })
    })
    await page.route('**/api/serve/sessions/session/artifacts/artifact/entries', (route) =>
      route.fulfill({
        json: {
          artifact_id: 'artifact',
          kind: 'directory',
          sha256: 'revision',
          entries: [
            { path: 'nested', kind: 'directory' },
            { path: 'nested/report.md', kind: 'file', sha256: 'report', size: 12 },
            { path: 'empty', kind: 'directory' },
          ],
        },
      })
    )
    await page.goto(`${server.resolvedUrls!.local[0]}__artifacts?mode=directory-card`)
    const openContext = () => page.getByTestId('artifact-open').click({ button: 'right' })
    await openContext()
    await page.getByRole('menuitem', { name: '复制路径' }).click({ timeout: 5000 })
    await openContext()
    await page.getByRole('menuitem', { name: '在访达中打开' }).click()
    assert.deepEqual(
      await page.evaluate(() => (window as unknown as { probe: { calls: unknown[] } }).probe.calls),
      [
        ['copy', '/session/source'],
        ['reveal', '/session/source'],
      ]
    )

    await openContext()
    await page.getByRole('menuitem', { name: '打开', exact: true }).click()
    const dialog = page.getByRole('dialog')
    const openSource = dialog.getByRole('button', { name: '在访达中打开源文件夹' })
    await openSource.click()
    await expect
      .poll(() =>
        page.evaluate(() =>
          (window as unknown as { probe: { calls: unknown[] } }).probe.calls.at(-1)
        )
      )
      .toEqual(['open', '/session/source'])
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)

    sourceExists = false
    const missing = page.waitForResponse(
      (response) => response.status() === 404 && response.url().includes('/session/files?')
    )
    await openContext()
    await missing
    await expect(page.getByRole('menuitem')).toHaveText(['打开'])
    await page.getByRole('menuitem', { name: '打开', exact: true }).click()
    await expect(dialog).toContainText('只读快照')
    await expect(openSource).toHaveCount(0)
    await expect(dialog.getByText('report.md')).toHaveCount(0)
    await dialog.getByRole('button', { name: 'nested' }).click()
    await expect(dialog.getByRole('button', { name: 'report.md' })).toBeVisible()
    await dialog.getByRole('button', { name: 'Snapshot' }).click()
    await dialog.getByRole('button', { name: 'empty' }).click()
    await expect(dialog).toContainText(assistantZh.artifactEntry.directoryEmpty)
    await dialog.getByRole('button', { name: 'Snapshot' }).click()
    await dialog.getByRole('button', { name: 'nested' }).click()
    await dialog.getByRole('button', { name: 'report.md' }).click()
    await expect(dialog).toHaveCount(0)
    assert.equal(
      await page.evaluate(
        () =>
          (window as unknown as { probe: { preview?: { memberPath: string } } }).probe.preview
            ?.memberPath
      ),
      'nested/report.md'
    )
  } finally {
    await browser.close()
  }
})

test('published directory overview rows delegate snapshot opening instead of parent raw preview', async () => {
  const server = await servers.create({
    configFile: false,
    root: ROOT,
    plugins: [plugin, react()],
    cacheKey: 'artifacts-directory',
    server: { host: '127.0.0.1', port: 0 },
  })
  await server.listen()
  const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL })
  try {
    const page = await browser.newPage()
    await page.goto(`${server.resolvedUrls!.local[0]}__artifacts?mode=directory`)
    const row = page.getByTestId('session-artifact-directory')
    await expect(row).toBeVisible()
    await row.focus()
    await row.press('Enter')
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as unknown as { probe: { directory?: string } }).probe.directory
        )
      )
      .toBe('directory')
    assert.equal(
      await page.evaluate(
        () => (window as unknown as { probe: { preview?: unknown } }).probe.preview
      ),
      undefined
    )
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
  const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL })
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
