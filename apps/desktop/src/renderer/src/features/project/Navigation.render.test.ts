import assert from 'node:assert/strict'
import path from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'

import { chromium, expect, type Browser } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { transformWithEsbuild, type Plugin } from 'vite'
import { renderServers } from '../../../../test-helpers/render.ts'

const servers = renderServers({ after })

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const PREFIX = '\0navigation-probe:'
const ENTRY = 'navigation-entry'
const HOST = '/features/project/Navigation.tsx'
const TIMEOUT = 10000
const modules: Record<string, string> = {
  'react-i18next': `export const useTranslation = () => ({ t: key => key })`,
  '../../api': `
    let rows = [{ session_id: 'task-a', title: 'Task A', pinned: false }]
    let archives = [{ session_id: 'archive-a', title: 'Archived A', project_path: '/a' }]
    export async function listAllSessions({projectPath, archived}, active, behavior) {
      if (!archived || behavior.synchronizeRoots !== false) throw new Error('archive queries must be read-only')
      window.probe.archiveLoads = (window.probe.archiveLoads ?? 0) + 1
      if (window.probe.deferArchiveLoads) await new Promise(resolve => { window.probe.releaseArchiveLoad = resolve })
      if (window.probe.failArchiveLoads) return null
      return projectPath === '/a' ? archives.map(row => ({...row})) : []
    }
    export function setSessionArchived(id, archived) {
      window.probe.restoreCalls.push({id, archived})
      return new Promise(resolve => { window.probe.finishRestore = ok => {
        if (ok) {
          rows = [...rows, ...archives.filter(row => row.session_id === id)]
          archives = archives.filter(row => row.session_id !== id)
        }
        resolve({ok})
      } })
    }
    export async function listSessionCatalog({ projectPath }) {
      window.probe.loads++
      if (window.probe.deferLoads) await new Promise(resolve => { window.probe.releaseLoad = resolve })
      return { sessions: projectPath === '/a' ? rows.map(row => ({...row})) : [{ session_id: 'task-b', title: 'Task B', pinned: false }] }
    }
    export function setSessionPinned(id, pinned) {
      window.probe.calls.push({ id, pinned })
      return new Promise(resolve => { window.probe.finish = ok => {
        if (ok) rows = rows.map(row => row.session_id === id ? {...row, pinned} : row)
        resolve({ ok, status: ok ? 200 : 500, pinned })
      } })
    }
  `,
  '../../store': `
    import { useSyncExternalStore } from 'react'
    let project = { path: '/a', name: 'Project A' }
    let revision = 0
    let state = { sessions: [], threads: {}, activeSession: null, archivedSession: null, aiPanel: {}, sessionActivitySeen: {}, sessionCatalogRevision: 0, workbenchLayout: {} }
    const subscribers = new Set()
    const subscribe = callback => { subscribers.add(callback); return () => subscribers.delete(callback) }
    const refresh = () => { revision++; subscribers.forEach(callback => callback()) }
    export const selectedProject = () => project
    export function useApp() {
      const sessionCatalogRevision = useSyncExternalStore(subscribe, () => revision)
      window.probe.refreshCatalog = () => { state.sessionCatalogRevision++; refresh() }
      window.probe.switchProject = path => { project = { path, name: path }; state = {...state, archivedSession:null}; window.probe.refreshCatalog() }
      window.probe.state = () => state
      const set = patch => { state = {...state, ...(typeof patch === 'function' ? patch(state) : patch)}; refresh() }
      return { state, set, act: { openWorkbenchView() {}, startPanelDraft() {}, openSession(id, focus, intent) { window.probe.opened.push(id); window.probe.openIntent = intent; set({activeSession:id, archivedSession:null}) } } }
    }
  `,
  '../../session': `export const sessionDisplayTitle = row => row.title`,
  '../../tree': `export const findSessionNode = () => null; export const serveSessionNode = row => row`,
  '../assistant/attention': `export const useAttention = () => ({ by_session: {} })`,
  '../../components/business/SessionTitle': `export const SessionTitleEditor = () => null`,
  '../../components/business/TaskStatus': `import React from 'react'; export const TaskStatus = () => React.createElement('span', {'data-testid': 'task-status'})`,
  '../../shell/ProjectMenu': `export const ProjectMenu = () => null`,
  '../home/catalog': `export const HOME_TASK_LIMIT = 1000`,
  '../../components/ui': `
    import React from 'react'
    export { ResizablePanelGroup, ResizablePanel, ResizableHandle } from '/components/ui/Resizable.tsx'
    export const Button = ({children, ...props}) => <button {...props}>{children}</button>
    export const Tooltip = ({children}) => <>{children}</>
    export const NavigationButton = React.forwardRef(({label, onBack, backLabel, icon, ...props}, ref) => <button ref={ref} {...props}>{label}</button>)
    const CollapseContext = React.createContext(false)
    export const Collapsible = ({children, open, onOpenChange, ...props}) => <CollapseContext.Provider value={{open, onOpenChange}}><div {...props}>{children}</div></CollapseContext.Provider>
    export const CollapsibleTrigger = ({children}) => { const state = React.useContext(CollapseContext); return React.cloneElement(children, {onClick: () => state.onOpenChange(!state.open), 'aria-expanded':state.open}) }
    export const CollapsibleContent = ({children, ...props}) => { const state = React.useContext(CollapseContext); return <div hidden={!state.open} {...props}>{children}</div> }
    export const IconButton = React.forwardRef(({label, icon, ...props}, ref) => <button ref={ref} aria-label={label} {...props}>{icon}</button>)
    export const DropdownMenuItem = ({children, onSelect, destructive, ...props}) => <button onClick={onSelect} {...props}>{children}</button>
    export const DropdownMenu = ({children}) => <div>{children}</div>
    export const DropdownMenuContent = DropdownMenu
    export const DropdownMenuSeparator = () => <hr />
    export const DropdownMenuTrigger = ({children}) => children
    export const Popover = ({children}) => <div>{children}</div>
    export const PopoverContent = Popover
    export const PopoverTrigger = ({children}) => children
    export const EllipsisText = ({children}) => <span>{children}</span>
    export const EmptyState = ({title}) => <div>{title}</div>
    export const Spinner = () => <div>loading</div>
    export const SearchBox = props => <input {...props} />
    export const Alert = ({description, tone, ...props}) => <div {...props}>{description}</div>
  `,
}
const MODULE_NAMES = [ENTRY, ...Object.keys(modules)]

function probePlugin(): Plugin {
  return {
    name: 'navigation-probe',
    enforce: 'pre',
    resolveId(source, importer) {
      if (source.startsWith(PREFIX)) return source
      if (
        source === ENTRY ||
        ((importer?.includes(HOST) || importer?.includes('/features/project/Tasks.tsx')) &&
          source in modules)
      )
        return PREFIX + MODULE_NAMES.indexOf(source) + '.tsx'
      return null
    },
    async load(id) {
      if (!id.startsWith(PREFIX)) return null
      const name = MODULE_NAMES[Number(id.slice(PREFIX.length, -'.tsx'.length))]
      const source =
        name === ENTRY
          ? `
        import React from 'react'
        import { createRoot } from 'react-dom/client'
        import { ProjectNavigation } from '/features/project/Navigation.tsx'
        window.probe = { calls: [], loads: 0, restoreCalls: [], opened: [] }
        createRoot(document.getElementById('root')).render(<ProjectNavigation />)
      `
          : modules[name]
      return (
        await transformWithEsbuild(source, 'navigation-probe.tsx', {
          loader: 'tsx',
          jsx: 'automatic',
          tsconfigRaw: {},
        })
      ).code
    },
    configureServer(server) {
      server.middlewares.use('/__navigation', (_request, response, next) => {
        server
          .transformIndexHtml(
            '/__navigation',
            `<div id="root"></div><script type="module" src="/@id/__x00__navigation-probe:0.tsx"></script>`
          )
          .then((html) => {
            response.setHeader('Content-Type', 'text/html')
            response.end(html)
          })
          .catch(next)
      })
    },
  }
}

test('project tasks preserve pinning and support isolated archived previews, restore and deletion', async () => {
  const server = await servers.create({
    configFile: false,
    root: ROOT,
    plugins: [probePlugin(), react()],
    cacheKey: 'navigation',
    optimizeDeps: {
      noDiscovery: true,
      include: ['react', 'react-dom/client', 'lucide-react', 'react-i18next'],
    },
    server: { host: '127.0.0.1', port: 0 },
  })
  let browser: Browser | undefined
  try {
    await server.listen()
    const address = server.httpServer!.address()
    assert.ok(address && typeof address === 'object')
    browser = await chromium.launch({ headless: true })
    const page = await browser.newPage()
    page.setDefaultTimeout(TIMEOUT)
    const errors: string[] = []
    page.on('pageerror', (error) => {
      errors.push(error.message)
      console.error(error.message)
    })
    await page.goto(`http://127.0.0.1:${address.port}/__navigation`)
    const task = page.getByTestId('project-task-task-a')
    await expect(task).toBeVisible()
    await expect(task.getByRole('button', { name: 'Task A', exact: true })).toBeEnabled()
    await expect(page.locator('[data-resize-disabled="true"]')).toHaveCount(1)
    await expect(page.locator('[role="separator"][aria-orientation="vertical"]')).toHaveAttribute(
      'aria-disabled',
      'true'
    )
    const taskPosition = await task.boundingBox()
    const initialLoads = await page.evaluate(() => Reflect.get(window, 'probe').loads)
    await page.evaluate(() => {
      Reflect.get(window, 'probe').deferLoads = true
    })
    await task.getByRole('button', { name: 'Task A', exact: true }).click()
    assert.equal(await page.evaluate(() => Reflect.get(window, 'probe').openIntent), 'task')
    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, 'probe').loads))
      .toBeGreaterThan(initialLoads)
    await expect(page.getByTestId('project-task-list')).toHaveAttribute('aria-busy', 'false')
    await expect(page.getByText('loading', { exact: true })).toHaveCount(0)
    assert.equal((await task.boundingBox())?.y, taskPosition?.y)
    await page.evaluate(() => {
      const probe = Reflect.get(window, 'probe')
      probe.deferLoads = false
      probe.releaseLoad()
    })
    await expect(page.getByTestId('project-task-list')).toHaveAttribute('aria-busy', 'false')
    const pin = task.getByRole('button', { name: 'pin', exact: true })
    await pin.click().catch(async (error) => {
      console.error({ errors, body: await page.locator('body').innerText() })
      throw error
    })
    await expect(
      task.getByRole('button', { name: 'panel.rename', exact: true }).locator('svg')
    ).toHaveCount(1)
    await expect(
      task.getByRole('button', { name: 'panel.delete', exact: true }).locator('.lucide-trash')
    ).toHaveCount(1)
    const archiveToggle = page.getByTestId('project-archive-toggle')
    const archivePanel = page.getByTestId('project-archives').locator('..')
    await expect(archiveToggle).toHaveAttribute('aria-expanded', 'false')
    await expect(archivePanel).not.toHaveClass(/shadow-\[var\(--vds-project-archive-shadow\)\]/)
    await archiveToggle.click()
    await expect(archiveToggle).toHaveAttribute('aria-expanded', 'true')
    await expect(page.locator('[data-resize-disabled="true"]')).toHaveCount(0)
    await expect(
      page.locator('[role="separator"][aria-orientation="vertical"]')
    ).not.toHaveAttribute('aria-disabled', 'true')
    await expect(archivePanel).toHaveClass(/shadow-\[var\(--vds-project-archive-shadow\)\]/)
    const archived = page.getByTestId('project-archived-task-archive-a')
    await expect(
      archived.getByRole('button', { name: 'taskArchive.restoreTask', exact: true }).locator('svg')
    ).toHaveCount(1)
    await expect(archiveToggle).toContainText('1')
    for (const expanded of [true, false]) {
      if (!expanded) await archiveToggle.click()
      const archiveLoads = await page.evaluate(() => {
        const probe = Reflect.get(window, 'probe')
        probe.deferArchiveLoads = true
        const loads = probe.archiveLoads
        probe.refreshCatalog()
        return loads
      })
      await expect
        .poll(() => page.evaluate(() => Reflect.get(window, 'probe').archiveLoads))
        .toBeGreaterThan(archiveLoads)
      await expect(archiveToggle).toContainText('1')
      await expect(page.getByText('loading', { exact: true })).toHaveCount(0)
      await expect(archived).toHaveCount(1)
      if (expanded) await expect(archived).toBeVisible()
      await page.evaluate(() => {
        const probe = Reflect.get(window, 'probe')
        probe.deferArchiveLoads = false
        probe.failArchiveLoads = true
        probe.releaseArchiveLoad()
      })
      await expect(
        page.getByTestId('project-archived-list').getByText('loadFailed', { exact: true })
      ).toHaveCount(1)
      await expect(archiveToggle).toContainText('1')
      await expect(archived).toHaveCount(1)
      await page.evaluate(() => {
        const probe = Reflect.get(window, 'probe')
        probe.failArchiveLoads = false
        probe.refreshCatalog()
      })
      await expect(
        page.getByTestId('project-archived-list').getByText('loadFailed', { exact: true })
      ).toHaveCount(0)
    }
    await archiveToggle.click()
    await archived.getByRole('button', { name: 'Archived A', exact: true }).click()
    assert.equal(
      await page.evaluate(() => Reflect.get(window, 'probe').state().archivedSession.session_id),
      'archive-a'
    )
    assert.deepEqual(await page.evaluate(() => Reflect.get(window, 'probe').opened), ['task-a'])
    await archived.getByRole('button', { name: 'panel.delete', exact: true }).click()
    assert.equal(
      await page.evaluate(() => Reflect.get(window, 'probe').state().confirmDelete.sessionId),
      'archive-a'
    )
    await archiveToggle.click()
    await expect(page.getByTestId('project-archived-list')).toBeHidden()
    await expect(archivePanel).not.toHaveClass(/shadow-\[var\(--vds-project-archive-shadow\)\]/)
    await expect(pin).toBeDisabled()
    await page.evaluate(() => Reflect.get(window, 'probe').finish(false))
    await expect(page.getByRole('alert')).toHaveText('saveFailed')
    await expect(pin).toBeEnabled()
    await expect(task.getByRole('img', { name: 'pinned' })).toHaveCount(0)
    await pin.click()
    await page.evaluate(() => {
      Reflect.get(window, 'probe').deferLoads = true
    })
    const pinLoads = await page.evaluate(() => Reflect.get(window, 'probe').loads)
    await page.evaluate(() => Reflect.get(window, 'probe').finish(true))
    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, 'probe').loads))
      .toBeGreaterThan(pinLoads)
    await expect(page.getByTestId('project-task-list')).toHaveAttribute('aria-busy', 'false')
    await expect(task).toBeVisible()
    await expect(task.getByRole('img', { name: 'pinned' })).toHaveCount(0)
    await expect(task.getByTestId('task-status')).toHaveCount(1)
    await expect(page.getByRole('heading', { name: 'pinnedTasks', exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'unpinnedTasks', exact: true })).toHaveCount(0)
    await expect(
      page.getByTestId('project-task-list').getByTestId('project-task-task-a')
    ).toHaveCount(1)
    await expect(
      page.getByTestId('project-pinned-tasks').getByTestId('project-task-task-a')
    ).toBeVisible()
    await page.evaluate(() => {
      const probe = Reflect.get(window, 'probe')
      probe.deferLoads = false
      probe.releaseLoad()
    })
    await expect(page.getByTestId('project-task-list')).toHaveAttribute('aria-busy', 'false')
    const loads = await page.evaluate(() => Reflect.get(window, 'probe').loads)
    await page.evaluate(() => Reflect.get(window, 'probe').refreshCatalog())
    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, 'probe').loads))
      .toBeGreaterThan(loads)
    await expect(
      page.getByTestId('project-pinned-tasks').getByTestId('project-task-task-a')
    ).toBeVisible()
    await task.getByRole('button', { name: 'unpin', exact: true }).click()
    await page.evaluate(() => Reflect.get(window, 'probe').switchProject('/b'))
    await expect(page.getByTestId('project-task-task-b')).toBeVisible()
    await page.evaluate(() => Reflect.get(window, 'probe').finish(false))
    await expect(page.getByRole('alert')).toHaveCount(0)
    await page.evaluate(() => Reflect.get(window, 'probe').switchProject('/a'))
    const unpin = task.getByRole('button', { name: 'unpin', exact: true })
    await expect(unpin).toBeEnabled()
    await unpin.click()
    await page.evaluate(() => Reflect.get(window, 'probe').switchProject('/b'))
    await expect(page.getByTestId('project-task-task-b')).toBeVisible()
    await page.evaluate(() => Reflect.get(window, 'probe').switchProject('/a'))
    await expect(task).toBeVisible()
    await page.evaluate(() => Reflect.get(window, 'probe').finish(true))
    await expect(pin).toBeEnabled()
    await expect(task.getByRole('img', { name: 'pinned' })).toHaveCount(0)
    await expect(page.getByTestId('project-pinned-tasks')).toHaveCount(0)
    assert.deepEqual(await page.evaluate(() => Reflect.get(window, 'probe').calls), [
      { id: 'task-a', pinned: true },
      { id: 'task-a', pinned: true },
      { id: 'task-a', pinned: false },
      { id: 'task-a', pinned: false },
    ])
    const archiveLoads = await page.evaluate(() => {
      const probe = Reflect.get(window, 'probe')
      probe.deferArchiveLoads = true
      const loads = probe.archiveLoads
      probe.refreshCatalog()
      return loads
    })
    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, 'probe').archiveLoads))
      .toBeGreaterThan(archiveLoads)
    await page.evaluate(() => {
      const probe = Reflect.get(window, 'probe')
      probe.releaseOldArchiveLoad = probe.releaseArchiveLoad
      probe.switchProject('/b')
    })
    await expect(archiveToggle).not.toContainText('1')
    await expect(archived).toHaveCount(0)
    await expect(archiveToggle.getByText('loading', { exact: true })).toHaveCount(1)
    await expect
      .poll(() =>
        page.evaluate(() => {
          const probe = Reflect.get(window, 'probe')
          return probe.releaseArchiveLoad !== probe.releaseOldArchiveLoad
        })
      )
      .toBe(true)
    await page.evaluate(() => Reflect.get(window, 'probe').releaseOldArchiveLoad())
    await expect(archived).toHaveCount(0)
    await page.evaluate(() => {
      const probe = Reflect.get(window, 'probe')
      probe.deferArchiveLoads = false
      probe.releaseArchiveLoad()
    })
    await expect(archiveToggle).toContainText('0')
    await page.evaluate(() => Reflect.get(window, 'probe').switchProject('/a'))
    await expect(archiveToggle).toContainText('1')
    await archiveToggle.click()
    await archived.getByRole('button', { name: 'Archived A', exact: true }).click()
    const restore = archived.getByRole('button', { name: 'taskArchive.restoreTask', exact: true })
    await restore.click()
    await expect(restore).toBeDisabled()
    await page.evaluate(() => Reflect.get(window, 'probe').finishRestore(false))
    await expect(page.getByText('taskArchive.loadFailed', { exact: true })).toBeVisible()
    await expect(archived).toBeVisible()
    await restore.click()
    await page.evaluate(() => Reflect.get(window, 'probe').finishRestore(true))
    await expect(archived).toHaveCount(0)
    await expect(page.getByTestId('project-task-archive-a')).toBeVisible()
    assert.deepEqual(await page.evaluate(() => Reflect.get(window, 'probe').opened), [
      'task-a',
      'archive-a',
    ])
    await page.evaluate(() => Reflect.get(window, 'probe').switchProject('/b'))
    await expect(archiveToggle).toHaveAttribute('aria-expanded', 'false')
    await expect(archiveToggle).toContainText('0')
    await archiveToggle.click()
    await expect(page.getByTestId('project-archived-list')).toHaveText('emptyArchivedTasks')
  } finally {
    await browser?.close()
    await server.close()
  }
})
