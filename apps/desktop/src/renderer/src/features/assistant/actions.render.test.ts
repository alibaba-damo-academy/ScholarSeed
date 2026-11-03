import assert from 'node:assert/strict'
import path from 'node:path'
import test, { after } from 'node:test'
import { chromium, expect } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { transformWithEsbuild, type Plugin } from 'vite'
import { renderServers } from '../../../../test-helpers/render.ts'

const servers = renderServers({ after })
const ROOT = path.resolve(import.meta.dirname, '../..')
const ENTRY = '/actions-probe.tsx'
const PREFIX = '\0actions-probe:'
const modules: Record<string, string> = {
  'react-i18next': `export const useTranslation = () => ({t: key => key, i18n: {language: 'en'}})`,
  '../../api': `
    export async function appsForFile(path) {
      window.calls.push(['discover', path])
      return [{name: 'Compatible editor', path: '/Applications/Editor.app', isDefault: true}]
    }
    export async function openPathWith(...args) {window.calls.push(['open', ...args]); return {ok: true}}
    export async function revealSystemPath(path) {window.calls.push(['reveal', path]); return {ok: true}}
    export const downloadSessionArtifact = async () => null
    export const downloadSessionFile = async () => null
    export const getSessionFiles = async () => ({root: '/task', artifacts: [], literature: [],
      items: Array.from({length: 40}, (_, index) => ({name: 'report-' + index + '.json', dir: false}))})
    export const openSystemPath = async () => ({ok: true})
  `,
  '../../store': `
    const thread = {id: 'session', sessionId: 'session', workdir: '/task', projectPath: '/project'}
    const state = {projects: [{id: 'project', path: '/project'}], homeSelectedProjectId: 'project',
      aiPanel: {sessionId: 'session', artifactLinks: []}, resource: {tree: []}}
    export const activeThread = () => ({...thread, id: window.overviewSession ?? thread.id})
    export const useApp = () => ({state, act: {openFilePreview: (...args) => window.calls.push(['preview', ...args]), importResourceFiles: async (...args) => window.calls.push(['import', ...args])}, set: () => {}})
  `,
  '../../components/primitive/clipboard': `export const writeClipboard = async path => window.calls.push(['copy', path])`,
  '../../components/primitive': `export const FileFormatIcon = () => null`,
  '../primitive': `export const FileFormatIcon = () => null`,
  './Save': `export const ResourceSaveDialog = () => null`,
  './References': `import {Button} from '/components/ui'; export const OverviewReferences = ({onOpened}) => <Button data-testid="overview-reference" onClick={onOpened}>Reference</Button>`,
  './api': `export const fetchArtifactSha256 = async () => null; export const fetchResourceDirectoryTree = async () => []; export const importArtifactToLiterature = async () => ({}); export const importArtifactToResources = async () => ({})`,
}
const names = Object.keys(modules)
const plugin: Plugin = {
  name: 'actions-probe',
  enforce: 'pre',
  resolveId(source, importer) {
    if (source === ENTRY) return ENTRY
    if (source === 'react-i18next') return PREFIX + names.indexOf(source) + '.tsx'
    if (
      (importer?.endsWith('/assistant/Artifacts.tsx') ||
        importer?.endsWith('/assistant/Links.tsx') ||
        importer?.endsWith('/assistant/Overview.tsx') ||
        importer?.endsWith('/business/SessionArtifacts.tsx')) &&
      source in modules
    )
      return PREFIX + names.indexOf(source) + '.tsx'
    return null
  },
  async load(id) {
    const source =
      id === ENTRY
        ? `
      import React from 'react'
      import {createRoot} from 'react-dom/client'
      import {flushSync} from 'react-dom'
      import {OverviewFileActions} from '/features/assistant/Artifacts.tsx'
      import {SessionFileLink} from '/features/assistant/Links.tsx'
      import {TaskOverview, TaskOverviewLayout, TaskOverviewBody} from '/features/assistant/Overview.tsx'
      import {OverviewGroup} from '/components/business/SessionArtifacts.tsx'
      import {Button, ToastProvider} from '/components/ui'
      import '/styles.css'
      window.calls = []
      window.scholarseed = {platform: 'darwin'}
      const file = {name: 'report.json', path: 'report.json', absolutePath: '/task/report.json'}
      const row = <div className="group/overview-file flex"><Button>report.json</Button><OverviewFileActions file={file}/></div>
      const root = createRoot(document.getElementById('root'))
      const render = () => root.render(<ToastProvider>
        <SessionFileLink path="report-0.json" sessionId="session" onOpen={() => {}}>Task file</SessionFileLink>
        <SessionFileLink mode="actions" path="request.txt" sessionId="session" onOpen={() => {}}>Request file</SessionFileLink>
        <div data-testid="workspace-conversation" style={window.docked ? {width: 800, height: 600, display: 'flex', flexDirection: 'column'} : {marginLeft: 600, marginTop: 80, width: 240}}>
          <TaskOverviewLayout reserveSpace={Boolean(window.docked)}>
          <div className="vds-ai-head-actions" data-testid="overview-actions" style={{display: 'flex', width: window.docked ? 800 : 240}}><TaskOverview/></div>
          <TaskOverviewBody><span>Conversation content</span></TaskOverviewBody>
          </TaskOverviewLayout>
          <OverviewGroup title="Outputs" testId="outputs" items={Array.from({length: 6}, (_, index) => React.cloneElement(row, {key: index}))}/>
          <OverviewGroup title="Empty outputs" testId="empty-outputs" items={[]}/>
        </div>
      </ToastProvider>)
      window.refreshOverview = () => flushSync(render)
      render()
    `
        : id.startsWith(PREFIX)
          ? modules[names[Number(id.slice(PREFIX.length, -4))]]
          : null
    if (!source) return null
    return (
      await transformWithEsbuild(source, 'actions-probe.tsx', {
        loader: 'tsx',
        jsx: 'automatic',
        tsconfigRaw: {},
      })
    ).code
  },
  configureServer(server) {
    server.middlewares.use('/__actions', (_request, response, next) => {
      server
        .transformIndexHtml(
          '/__actions',
          `<div id="root"></div><script type="module" src="${ENTRY}"></script>`
        )
        .then((html) => {
          response.setHeader('Content-Type', 'text/html')
          response.end(html)
        })
        .catch(next)
    })
  },
}

test('overview file actions discover compatible apps and preserve the overflow menu', async () => {
  const server = await servers.create({
    configFile: false,
    root: ROOT,
    plugins: [plugin, react()],
    cacheKey: 'actions',
    optimizeDeps: { noDiscovery: true, include: ['react', 'react-dom/client', 'lucide-react'] },
    server: { host: '127.0.0.1', port: 0 },
  })
  await server.listen()
  const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL })
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 840 } })
    page.on('pageerror', (error) => process.stderr.write(error.stack + '\n'))
    await page.goto(`${server.resolvedUrls!.local[0]}__actions`)
    const fileActions = page.getByTestId('session-file-actions')
    await expect(fileActions.locator('svg.lucide-ellipsis-vertical')).toHaveCount(1)
    await fileActions.click()
    await expect(page.getByTestId('session-file-link-open')).toBeVisible()
    await expect(page.getByTestId('session-file-link-save-as')).toBeVisible()
    await expect(page.getByTestId('session-file-link-copy-path')).toBeVisible()
    await expect(page.getByTestId('session-file-link-reveal')).toBeVisible()
    await page.keyboard.press('Escape')
    await page.getByTestId('outputs-more').click()
    const overflow = page.getByTestId('outputs')
    await expect(overflow).toBeVisible()
    const actions = overflow
      .getByRole('button')
      .filter({ has: page.locator('svg.lucide-ellipsis-vertical') })
      .first()
    const fileSize = await fileActions.evaluate((element) => {
      const style = getComputedStyle(element)
      return [style.width, style.height]
    })
    const artifactSize = await actions.evaluate((element) => {
      const style = getComputedStyle(element)
      return [style.width, style.height]
    })
    assert.deepEqual(fileSize, artifactSize)
    await actions.focus()
    await actions.click()
    await page.getByTestId('artifact-dropdown-open-with').hover()
    await expect(page.getByRole('menuitem', { name: /Compatible editor/ })).toBeVisible()
    await page.getByRole('menuitem', { name: /Compatible editor/ }).click()
    const calls = await page.evaluate(() => (window as unknown as { calls: unknown[] }).calls)
    assert.deepEqual(calls, [
      ['discover', '/task/report.json'],
      ['open', '/task/report.json', '/Applications/Editor.app'],
    ])
  } finally {
    await browser.close()
    await server.close()
  }
})

test('fullscreen overview reserves room for its bubble, hides idle scrollbars and closes without losing the conversation', async () => {
  const server = await servers.create({
    configFile: false,
    root: ROOT,
    plugins: [plugin, react()],
    cacheKey: 'actions',
    optimizeDeps: { noDiscovery: true, include: ['react', 'react-dom/client', 'lucide-react'] },
    server: { host: '127.0.0.1', port: 0 },
  })
  await server.listen()
  const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL })
  try {
    const page = await browser.newPage({ viewport: { width: 1040, height: 660 } })
    await page.addInitScript(() => {
      ;(window as unknown as { docked: boolean }).docked = true
    })
    await page.goto(`${server.resolvedUrls!.local[0]}__actions`)
    const conversation = page.getByTestId('task-overview-conversation')
    const closedWidth = (await conversation.boundingBox())!.width
    const toggle = page.getByTestId('task-overview-toggle')
    await toggle.click()
    const overview = page.getByTestId('task-overview')
    await expect(overview).toHaveAttribute('data-presentation', 'reserved')
    await expect(overview).toBeVisible()
    assert.equal((await page.getByTestId('overview-actions').boundingBox())!.width, closedWidth)
    const reservedWidth = (await page.getByTestId('task-overview-dock').boundingBox())!.width
    await expect
      .poll(async () => (await conversation.boundingBox())!.width)
      .toBe(closedWidth - reservedWidth)
    assert.ok(
      (await conversation.boundingBox())!.x + (await conversation.boundingBox())!.width <=
        (await overview.boundingBox())!.x
    )
    await page.getByTestId('task-overview-process-more').click()
    const viewport = page.getByTestId('task-overview-scroll')
    const area = overview.locator('.vds-scroll-area')
    await expect(area).toHaveAttribute('data-fade-bottom', 'true')
    const scrollbar = () => viewport.evaluate((element) => getComputedStyle(element).scrollbarColor)
    await page.mouse.move(1020, 640)
    await expect.poll(scrollbar).toBe('rgba(0, 0, 0, 0) rgba(0, 0, 0, 0)')
    await overview.hover()
    await expect.poll(scrollbar).not.toBe('rgba(0, 0, 0, 0) rgba(0, 0, 0, 0)')
    await toggle.click()
    await expect(overview).toHaveCount(0)
    await expect(toggle).toBeFocused()
    await expect.poll(async () => (await conversation.boundingBox())!.width).toBe(closedWidth)
  } finally {
    await browser.close()
    await server.close()
  }
})

test('task file open-with expands on hover and supports keyboard selection', async () => {
  const server = await servers.create({
    configFile: false,
    root: ROOT,
    plugins: [plugin, react()],
    cacheKey: 'actions',
    optimizeDeps: { noDiscovery: true, include: ['react', 'react-dom/client', 'lucide-react'] },
    server: { host: '127.0.0.1', port: 0 },
  })
  await server.listen()
  const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL })
  try {
    const page = await browser.newPage()
    await page.goto(`${server.resolvedUrls!.local[0]}__actions`)
    const file = page.getByRole('button', { name: 'Task file', exact: true })
    const trigger = page.getByTestId('session-file-link-open-with')
    const editor = page.getByRole('menuitem', { name: /Compatible editor/ })
    await file.click({ button: 'right' })
    await trigger.hover()
    await expect(trigger).toHaveAttribute('aria-expanded', 'true')
    await expect(editor).toBeVisible()
    await editor.click()
    await expect(editor).toBeHidden()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menu')).toHaveCount(0)
    await file.click({ button: 'right' })
    await page.keyboard.press('ArrowDown')
    await expect(trigger).toBeFocused()
    await page.keyboard.press('ArrowRight')
    await expect(editor).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(editor).toBeHidden()
    const calls = await page.evaluate(() => (window as unknown as { calls: unknown[] }).calls)
    assert.deepEqual(calls, [
      ['discover', '/task/report-0.json'],
      ['open', '/task/report-0.json', '/Applications/Editor.app'],
      ['discover', '/task/report-0.json'],
    ])
  } finally {
    await browser.close()
    await server.close()
  }
})

test('overview keeps its expanded inline list and file actions stable while its parent rerenders', async () => {
  const server = await servers.create({
    configFile: false,
    root: ROOT,
    plugins: [plugin, react()],
    cacheKey: 'actions',
    optimizeDeps: { noDiscovery: true, include: ['react', 'react-dom/client', 'lucide-react'] },
    server: { host: '127.0.0.1', port: 0 },
  })
  await server.listen()
  const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL })
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 840 } })
    await page.goto(`${server.resolvedUrls!.local[0]}__actions`)
    const heading = page.getByTestId('outputs-trigger')
    const chevron = heading.locator('svg')
    await expect(chevron).toBeHidden()
    await heading.hover()
    await expect(chevron).toBeVisible()
    await heading.click()
    await expect(page.getByTestId('outputs')).toHaveAttribute('data-state', 'closed')
    await expect(chevron).toBeVisible()
    await page.getByTestId('empty-outputs').hover()
    await expect(chevron).toBeHidden()
    await expect(page.getByTestId('empty-outputs').locator('svg')).toHaveCount(0)
    const toggle = page.getByTestId('task-overview-toggle')
    const inactiveBackground = await toggle.evaluate(
      (element) => getComputedStyle(element).backgroundColor
    )
    await toggle.click()
    const overview = page.getByTestId('task-overview')
    const pane = page.getByTestId('workspace-conversation')
    const assertRightInset = async (): Promise<void> => {
      await expect
        .poll(async () => {
          const bubbleBounds = (await overview.boundingBox())!
          const paneBounds = (await pane.boundingBox())!
          return Math.abs(
            paneBounds.x + paneBounds.width - bubbleBounds.x - bubbleBounds.width - 16
          )
        })
        .toBeLessThan(1)
    }
    await pane.evaluate((element) => {
      element.style.width = '360px'
      element.style.marginLeft = '550px'
    })
    await assertRightInset()
    await pane.evaluate((element) => {
      element.style.width = '240px'
      element.style.marginLeft = `${window.innerWidth - 240}px`
    })
    await assertRightInset()
    await pane.evaluate((element) => {
      element.style.width = '240px'
      element.style.marginLeft = '600px'
    })
    await assertRightInset()
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')
    await page.mouse.click(20, 20)
    await expect(overview).toBeVisible()
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')
    await expect
      .poll(() => toggle.evaluate((element) => getComputedStyle(element).backgroundColor))
      .not.toBe(inactiveBackground)
    await overview.focus()
    await page.keyboard.press('Escape')
    await expect(overview).toBeVisible()
    await overview.getByRole('button', { name: 'report-0.json', exact: true }).click()
    await expect
      .poll(() =>
        page.evaluate(() =>
          (window as unknown as { calls: unknown[][] }).calls.some((call) => call[0] === 'preview')
        )
      )
      .toBe(true)
    await expect(overview).toBeVisible()
    await page.getByTestId('overview-reference').click()
    await expect(overview).toBeVisible()
    await toggle.click()
    await expect(overview).toBeHidden()
    await expect(toggle).toHaveAttribute('aria-pressed', 'false')
    await page.mouse.move(20, 20)
    await expect
      .poll(() => toggle.evaluate((element) => getComputedStyle(element).backgroundColor))
      .toBe(inactiveBackground)
    await toggle.click()
    await expect
      .poll(async () => {
        const menu = await page.getByTestId('task-overview').boundingBox()
        const actions = await page.getByTestId('overview-actions').boundingBox()
        return Math.abs(menu!.x + menu!.width + 16 - (actions!.x + actions!.width))
      })
      .toBeLessThan(1)
    await page.getByTestId('task-overview-process-more').click()
    await expect(page.getByTestId('task-overview-process-all')).toHaveCount(0)
    const list = page.getByTestId('task-overview-process')
    await expect(list).toBeVisible()
    await list
      .getByRole('button')
      .filter({ has: page.locator('svg.lucide-ellipsis-vertical') })
      .first()
      .click()
    await page.getByTestId('artifact-dropdown-open-with').hover()
    await expect(page.getByRole('menuitem', { name: /Compatible editor/ })).toBeVisible()
    await list.evaluate((element) =>
      Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished))
    )
    const before = await list.boundingBox()
    for (let refresh = 0; refresh < 3; refresh++) {
      const after = await page.evaluate(() => {
        ;(window as unknown as { refreshOverview: () => void }).refreshOverview()
        const element = document.querySelector<HTMLElement>(
          '[data-testid="task-overview-process"]'
        )!
        const bounds = element.getBoundingClientRect()
        return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
      })
      assert.deepEqual(after, before)
    }
    await expect(page.getByRole('menuitem', { name: /Compatible editor/ })).toBeVisible()
    const geometry = await overview.evaluate((element) => {
      const trigger = document.querySelector('[data-testid="task-overview-toggle"]')!
      return {
        trigger: trigger.getBoundingClientRect().toJSON(),
        bubble: element.getBoundingClientRect().toJSON(),
        maxHeight: getComputedStyle(element).maxHeight,
        scrollY,
      }
    })
    assert.ok(geometry.bubble.top >= geometry.trigger.bottom, JSON.stringify(geometry))
    await toggle.click()
    await expect(overview).toBeHidden()
    await toggle.click()
    await page.evaluate(() => {
      const fixture = window as unknown as { docked: boolean; refreshOverview: () => void }
      fixture.docked = true
      fixture.refreshOverview()
    })
    await expect(overview).toHaveAttribute('data-presentation', 'reserved')
    await page.evaluate(() => {
      const fixture = window as unknown as { docked: boolean; refreshOverview: () => void }
      fixture.docked = false
      fixture.refreshOverview()
    })
    await expect(overview).toBeVisible()
    await assertRightInset()
    await page.evaluate(() => {
      const fixture = window as unknown as {
        overviewSession: string
        refreshOverview: () => void
      }
      fixture.overviewSession = 'another-session'
      fixture.refreshOverview()
    })
    await expect(overview).toBeHidden()
    await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  } finally {
    await browser.close()
    await server.close()
  }
})
