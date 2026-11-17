import assert from 'node:assert/strict'
import path from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'

import { chromium, expect, type Browser } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { transformWithEsbuild, type Plugin } from 'vite'
import { renderServers } from '../../../../test-helpers/render.ts'
import layoutEn from '../../../../localization/locales/en/layout.json' with { type: 'json' }

const servers = renderServers({ after })

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const PREFIX = '\0navigation-probe:'
const ENTRY = 'navigation-entry'
const HOST = '/features/project/Navigation.tsx'
const TIMEOUT = 10000
const PROJECT_PANEL_WIDTH = 264
const CATALOG_PAGE_SIZE = 500
const DRAG_VIEWPORT = { width: 1040, height: 660 }
const modules: Record<string, string> = {
  'react-i18next': `export const useTranslation = () => ({ t: key => key === 'sessionOrderFailed' ? window.probe.failureLabel ?? key : key })`,
  '../../api': `
    let rows = window.groupRows ?? [{ session_id: 'task-a', title: 'Task A', pinned: false }]
    let archives = [{ session_id: 'archive-a', title: 'Archived A', project_path: '/a' }]
    export async function listAllSessions({projectPath, archived}, active, behavior) {
      if (!archived) {
        const catalog = await listSessionCatalog({projectPath, complete:true})
        return active && !active() ? null : catalog.sessions
      }
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
    export async function listSessionCatalog({ projectPath, complete }) {
      window.probe.setRows = items => { rows = items; window.probe.refreshCatalog() }
      window.probe.loads++
      if (window.probe.deferLoads) await new Promise(resolve => { window.probe.releaseLoad = resolve })
      return { sessions: projectPath === '/a' ? rows.map(row => ({...row})).slice(0, complete ? undefined : ${CATALOG_PAGE_SIZE}) : [{ session_id: 'task-b', title: 'Task B', pinned: false }] }
    }
    export function setSessionPinned(id, pinned) {
      window.probe.calls.push({ id, pinned })
      return new Promise(resolve => { window.probe.finish = ok => {
        if (ok) rows = rows.map(row => row.session_id === id ? {...row, pinned} : row)
        resolve({ ok, status: ok ? 200 : 500, pinned })
      } })
    }
    export function detachSession(id) {
      window.probe.detachCalls.push(id)
      return new Promise(resolve => { window.probe.finishDetach = ok => {
        if (ok) rows = rows.map(row => row.session_id === id ? {...row, detached_parent_session_id:row.display_parent_session_id, display_parent_session_id:null} : row)
        resolve({ok, status:ok ? 200 : 500})
      } })
    }
    export function restoreSessionParent(id, parent) {
      (window.probe.restoreParentCalls ??= []).push({id, parent})
      return new Promise(resolve => { window.probe.finishRestoreParent = () => {
        rows = rows.map(row => row.session_id === id ? {...row, display_parent_session_id:parent, detached_parent_session_id:null} : row)
        resolve({ok:true, status:200})
      } })
    }
    export const SESSION_ORDER_PLACEMENTS = {before:'before',after:'after'}
    export function reorderSession(id, target, placement) {
      window.probe.orderCalls.push({id,target,placement})
      return new Promise(resolve => { window.probe.finishOrder = ok => {
        if (ok) {
          const source = rows.find(row => row.session_id === id)
          rows = rows.filter(row => row.session_id !== id)
          const targetIndex = rows.findIndex(row => row.session_id === target)
          rows.splice(targetIndex + (placement === 'after' ? 1 : 0), 0, source)
        }
        resolve({ok, status:ok ? 200 : 500})
      } })
    }
  `,
  '../../store': `
    import { useSyncExternalStore } from 'react'
    let project = { path: '/a', name: 'Project A' }
    let revision = 0
    let state = { homeSelectedProjectId: 'project-alpha', globalSearchOpen: false, globalSearchMode: 'files', sessions: [], threads: {}, activeSession: null, archivedSession: null, aiPanel: {}, sessionActivitySeen: {}, collapsedSessionIds: {}, sessionCatalogRevision: 0, workbenchLayout: {} }
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
      return { state, set, act: { openWorkbenchView() {}, startPanelDraft() {}, toggleSessionChildren(id) { set({collapsedSessionIds:{...state.collapsedSessionIds,[id]:!state.collapsedSessionIds[id]}}) }, openSession(id, focus, intent) { window.probe.opened.push(id); window.probe.openIntent = intent; set({activeSession:id, archivedSession:null}) } } }
    }
  `,
  '../../session': `export const sessionDisplayTitle = row => row.title`,
  '../../tree': `export const findSessionNode = () => null; export const serveSessionNode = row => ({...row,id:row.session_id,displayParentSessionId:row.display_parent_session_id}); export { projectSessionNodes } from '/tree.ts'`,
  '../assistant/attention': `export const useAttention = () => ({ by_session: {} })`,
  '../../components/business/SessionTitle': `export const SessionTitleEditor = () => null`,
  '../../components/business/TaskStatus': `import React from 'react'; export const TaskStatus = () => React.createElement('span', {'data-testid': 'task-status'})`,
  '../../shell/ProjectMenu': `export const ProjectMenu = () => null`,
  '../home/catalog': `export const HOME_TASK_LIMIT = 1000`,
  '../../components/ui': `
    import React from 'react'
    export { ResizablePanelGroup, ResizablePanel, ResizableHandle } from '/components/ui/Resizable.tsx'
    export { ScrollArea } from '/components/ui/ScrollArea.tsx'
    export {Button} from '/components/ui/Button.tsx'
    export {Divider} from '/components/ui/Divider.tsx'
    export {useToast} from '/components/ui/Toast.tsx'
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
    export {Alert,AlertDescription} from '/components/ui/Alert.tsx'
  `,
}
const MODULE_NAMES = [ENTRY, ...Object.keys(modules)]

for (const parentPinned of [true, false]) {
  test(`display group stays whole with mixed pin flags: parent pinned=${parentPinned}`, async () => {
    const server = await servers.create({
      configFile: false,
      root: ROOT,
      plugins: [probePlugin(), react()],
      cacheKey: 'navigation',
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
      await page.addInitScript((pinned) => {
        Reflect.set(window, 'groupRows', [
          { session_id: 'ordinary', title: 'Ordinary', pinned: false },
          { session_id: 'parent', title: 'Parent', pinned },
          {
            session_id: 'second',
            title: 'Second',
            pinned: false,
            display_parent_session_id: 'parent',
          },
          {
            session_id: 'child',
            title: 'Child',
            pinned: !pinned,
            display_parent_session_id: 'parent',
          },
        ])
      }, parentPinned)
      await page.goto(`http://127.0.0.1:${address.port}/__navigation`)
      const parent = page.getByTestId('project-task-parent')
      const child = page.getByTestId('project-task-child')
      await expect(parent).toHaveCount(1)
      await expect(child).toHaveCount(1)
      const sections = await page.evaluate(() =>
        ['parent', 'child'].map((sessionId) =>
          document
            .querySelector(`[data-testid="project-task-${sessionId}"]`)
            ?.closest('[data-testid="project-pinned-tasks"]')
            ? 'pinned'
            : 'ordinary'
        )
      )
      assert.equal(sections[0], sections[1], 'a display group cannot be split across pin sections')
      assert.equal(sections[0], 'pinned')
      const pinnedSection = page.getByTestId('project-pinned-tasks')
      const order = () =>
        pinnedSection
          .locator(':scope > div[data-testid^="project-task-"]')
          .evaluateAll((elements) => elements.map((element) => element.getAttribute('data-testid')))
      assert.deepEqual(await order(), [
        'project-task-parent',
        'project-task-second',
        'project-task-child',
      ])
      await expect(parent.getByRole('button', { name: 'collapseChildren' })).toHaveCount(1)
      await parent.getByRole('button', { name: 'collapseChildren' }).click()
      await expect(child).toHaveCount(0)
      await expect(page.getByTestId('project-task-second')).toHaveCount(0)
      await parent.getByRole('button', { name: 'expandChildren' }).click()
      await expect(child).toBeVisible()
      const second = page.getByTestId('project-task-second')
      await second.getByRole('button', { name: 'pin', exact: true }).click()
      await page.evaluate(() => Reflect.get(window, 'probe').finish(true))
      await expect(second.getByRole('button', { name: 'unpin', exact: true })).toBeEnabled()
      const initiallyPinned = parentPinned ? parent : child
      await initiallyPinned.getByRole('button', { name: 'unpin', exact: true }).click()
      await page.evaluate(() => Reflect.get(window, 'probe').finish(true))
      await expect(initiallyPinned.getByRole('button', { name: 'pin', exact: true })).toBeEnabled()
      assert.deepEqual(await order(), [
        'project-task-parent',
        'project-task-second',
        'project-task-child',
      ])
      await second.getByRole('button', { name: 'unpin', exact: true }).click()
      await page.evaluate(() => Reflect.get(window, 'probe').finish(true))
      await expect(pinnedSection).toHaveCount(0)
      await expect(parent).toHaveCount(1)
      await expect(child).toHaveCount(1)
      await expect(second).toHaveCount(1)
      await child.getByRole('button', { name: 'pin', exact: true }).click()
      await page.evaluate(() => Reflect.get(window, 'probe').finish(true))
      await expect(pinnedSection.getByTestId('project-task-parent')).toBeVisible()
      await expect(pinnedSection.getByTestId('project-task-child')).toBeVisible()
      await expect(parent.getByRole('button', { name: 'pin', exact: true })).toBeEnabled()
      assert.deepEqual(await page.evaluate(() => Reflect.get(window, 'probe').calls), [
        { id: 'second', pinned: true },
        { id: parentPinned ? 'parent' : 'child', pinned: false },
        { id: 'second', pinned: false },
        { id: 'child', pinned: true },
      ])
    } finally {
      await browser?.close()
      await server.close()
    }
  })
}

function probePlugin(): Plugin {
  return {
    name: 'navigation-probe',
    enforce: 'pre',
    resolveId(source, importer) {
      if (source.startsWith(PREFIX)) return source
      if (
        source === ENTRY ||
        (importer?.includes('/components/business/SessionContextMenu.tsx') &&
          (source === '../../store' || source === 'react-i18next')) ||
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
        import '/styles.css'
        import { createRoot } from 'react-dom/client'
        import { ProjectNavigation } from '/features/project/Navigation.tsx'
        import { ToastProvider, Toaster } from '/components/ui/Toast.tsx'
        window.probe = { calls: [], loads: 0, restoreCalls: [], opened: [], detachCalls: [], orderCalls: [] }
        createRoot(document.getElementById('root')).render(<ToastProvider><ProjectNavigation /><Toaster /></ToastProvider>)
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
    const search = page.getByTestId('project-search')
    await expect(search).toHaveCount(1)
    await expect(search).toHaveAttribute('aria-expanded', 'false')
    await search.click()
    await expect(search).toHaveAttribute('aria-expanded', 'true')
    assert.deepEqual(
      await page.evaluate(() => {
        const { homeSelectedProjectId, globalSearchOpen, globalSearchMode } = Reflect.get(
          window,
          'probe'
        ).state()
        return { homeSelectedProjectId, globalSearchOpen, globalSearchMode }
      }),
      { homeSelectedProjectId: 'project-alpha', globalSearchOpen: true, globalSearchMode: 'all' }
    )
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
    assert.deepEqual(await page.evaluate(() => Reflect.get(window, 'probe').opened), ['task-a'])
    assert.equal(await page.evaluate(() => Reflect.get(window, 'probe').openIntent), undefined)
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
    await archived.hover()
    await restore.click()
    await expect(restore).toBeDisabled()
    await page.evaluate(() => Reflect.get(window, 'probe').finishRestore(false))
    await expect(page.getByText('taskArchive.loadFailed', { exact: true })).toBeVisible()
    await expect(archived).toBeVisible()
    await archived.hover()
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
    await page.evaluate(() => {
      const probe = Reflect.get(window, 'probe')
      probe.switchProject('/a')
      probe.setRows([
        { session_id: 'task-a', title: 'Task A', project_path: '/a' },
        {
          session_id: 'child',
          title: 'Child',
          project_path: '/a',
          display_parent_session_id: 'task-a',
        },
        {
          session_id: 'foreign',
          title: 'Foreign',
          project_path: '/b',
          display_parent_session_id: 'other',
        },
      ])
    })
    const child = page.getByTestId('project-task-child')
    const parent = page.getByTestId('project-task-task-a')
    await parent.getByRole('button', { name: 'collapseChildren', exact: true }).click()
    await expect(child).toHaveCount(0)
    await parent.getByRole('button', { name: 'expandChildren', exact: true }).click()
    await expect(child).toHaveAttribute('draggable', 'true')
    await expect(page.getByTestId('project-task-task-a')).toHaveAttribute('draggable', 'true')
    await expect(page.getByTestId('project-task-foreign')).toHaveAttribute('draggable', 'false')
    const transfer = await page.evaluateHandle(() => new DataTransfer())
    const sourceBounds = await child.boundingBox()
    const buttonCount = await page.getByRole('button').count()
    await child.dispatchEvent('dragstart', { dataTransfer: transfer })
    assert.deepEqual(await child.boundingBox(), sourceBounds)
    assert.equal(await page.getByRole('button').count(), buttonCount)
    await child.dispatchEvent('dragend')
    assert.deepEqual(await page.evaluate(() => Reflect.get(window, 'probe').detachCalls), [])
    await child.dispatchEvent('dragstart', { dataTransfer: transfer })
    await page.getByTestId('project-task-foreign').dispatchEvent('drop', { dataTransfer: transfer })
    assert.deepEqual(await page.evaluate(() => Reflect.get(window, 'probe').detachCalls), [])
    await parent.dispatchEvent('drop', { dataTransfer: transfer })
    const detachCalls = await page.evaluate(() => Reflect.get(window, 'probe').detachCalls)
    assert.deepEqual(detachCalls, ['child'])
    await expect(page.getByRole('status')).toHaveText('detachingSession')
    await expect(child).toHaveAttribute('draggable', 'false')
    await page.evaluate(() => Reflect.get(window, 'probe').finishDetach(false))
    await expect(page.getByRole('alert')).toHaveText('detachFailed')
    await expect(child).toHaveAttribute('draggable', 'true')
    await child.dispatchEvent('dragstart', { dataTransfer: transfer })
    const outdentBounds = await child.boundingBox()
    assert.ok(outdentBounds)
    await child.dispatchEvent('drop', { dataTransfer: transfer, clientX: outdentBounds.x })
    await page.evaluate(() => Reflect.get(window, 'probe').finishDetach(true))
    await expect(page.getByRole('status')).toHaveText('sessionDetached')
    await expect(page.locator('section').getByRole('status')).toHaveCount(0)
    await expect(page.getByRole('status')).toHaveCount(0, { timeout: TIMEOUT })
    await expect(child).toHaveAttribute('draggable', 'true')
    await expect(parent.getByRole('button', { name: 'collapseChildren', exact: true })).toHaveCount(
      0
    )
    assert.deepEqual(await page.evaluate(() => Reflect.get(window, 'probe').opened), [
      'task-a',
      'archive-a',
    ])
    assert.deepEqual(await page.evaluate(() => Reflect.get(window, 'probe').detachCalls), [
      'child',
      'child',
    ])
    const parentBounds = await parent.boundingBox()
    assert.ok(parentBounds)
    await child.dispatchEvent('dragstart', { dataTransfer: transfer })
    await parent.dispatchEvent('dragover', {
      dataTransfer: transfer,
      clientY: parentBounds.y + parentBounds.height / 2,
    })
    await expect(parent).toHaveClass(/ring-inset/)
    await expect(page.getByTestId('session-drop-indicator')).toHaveCount(0)
    await parent.dispatchEvent('drop', {
      dataTransfer: transfer,
      clientY: parentBounds.y + parentBounds.height / 2,
    })
    assert.deepEqual(await page.evaluate(() => Reflect.get(window, 'probe').restoreParentCalls), [
      { id: 'child', parent: 'task-a' },
    ])
    await expect(child).toHaveAttribute('draggable', 'false')
    await expect(page.getByRole('status')).toHaveCount(0)
    await page.evaluate(() => Reflect.get(window, 'probe').finishRestoreParent())
    await expect(
      parent.getByRole('button', { name: 'collapseChildren', exact: true })
    ).toBeVisible()
    await expect(page.getByRole('status')).toHaveCount(0, { timeout: TIMEOUT })
    await page.evaluate(() =>
      Reflect.get(window, 'probe').setRows([
        {
          session_id: 'child',
          title: 'Child',
          project_path: '/a',
          display_parent_session_id: 'task-a',
        },
      ])
    )
    await expect(child).toHaveAttribute('draggable', 'true')
    await child.dispatchEvent('dragstart', { dataTransfer: transfer })
    const external = await page.evaluateHandle(() => new DataTransfer())
    await page.getByTestId('project-task-list').dispatchEvent('drop', {
      dataTransfer: external,
      clientY: outdentBounds.y + outdentBounds.height,
    })
    await child.dispatchEvent('dragend')
    assert.deepEqual(await page.evaluate(() => Reflect.get(window, 'probe').detachCalls), [
      'child',
      'child',
    ])
    await child.dispatchEvent('dragstart', { dataTransfer: transfer })
    await child.dispatchEvent('drop', { dataTransfer: transfer, clientX: outdentBounds.x })
    await page.evaluate(() => Reflect.get(window, 'probe').switchProject('/b'))
    await expect(page.getByTestId('project-task-task-b')).toBeVisible()
    await page.evaluate(() => Reflect.get(window, 'probe').finishDetach(false))
    await expect(page.getByRole('alert')).toHaveCount(0)
    await expect(page.getByRole('status')).toHaveCount(0)
    assert.deepEqual(await page.evaluate(() => Reflect.get(window, 'probe').detachCalls), [
      'child',
      'child',
      'child',
    ])
    await page.evaluate(() => {
      const probe = Reflect.get(window, 'probe')
      probe.switchProject('/a')
      probe.setRows([
        { session_id: 'root-a', title: 'Root A', project_path: '/a' },
        { session_id: 'root-b', title: 'Root B', project_path: '/a' },
        {
          session_id: 'child-a',
          title: 'Child A',
          project_path: '/a',
          display_parent_session_id: 'root-a',
        },
        {
          session_id: 'child-b',
          title: 'Child B',
          project_path: '/a',
          display_parent_session_id: 'root-a',
        },
      ])
    })
    const orderedChild = page.getByTestId('project-task-child-b')
    const orderedTarget = page.getByTestId('project-task-child-a')
    await orderedChild.dispatchEvent('dragstart', { dataTransfer: transfer })
    await orderedTarget.dispatchEvent('drop', { dataTransfer: transfer, clientY: 0 })
    await expect(page.getByRole('status')).toHaveText('orderingSession')
    await expect(orderedChild).toHaveAttribute('draggable', 'false')
    await page.evaluate(() => Reflect.get(window, 'probe').finishOrder(false))
    await expect(page.getByRole('alert')).toHaveText('sessionOrderFailed')
    await page.evaluate(
      ({ label, width }) => {
        document.getElementById('root')!.style.width = width + 'px'
        const probe = Reflect.get(window, 'probe')
        probe.failureLabel = label
        probe.refreshCatalog()
      },
      { label: layoutEn.sessionOrderFailed, width: PROJECT_PANEL_WIDTH }
    )
    await expect(page.getByRole('alert')).toHaveText(layoutEn.sessionOrderFailed)
    const feedbackMetrics = await page
      .getByRole('alert')
      .locator('.vds-alert__description')
      .evaluate((element) => ({
        height: element.clientHeight,
        contentHeight: element.scrollHeight,
      }))
    assert.ok(
      feedbackMetrics.contentHeight <= feedbackMetrics.height,
      JSON.stringify(feedbackMetrics)
    )
    await page.evaluate(() => {
      document.getElementById('root')!.style.width = ''
      Reflect.get(window, 'probe').failureLabel = null
    })
    await orderedChild.dispatchEvent('dragstart', { dataTransfer: transfer })
    await orderedTarget.dispatchEvent('dragover', { dataTransfer: transfer, clientY: 0 })
    await expect(orderedTarget.locator(':scope > div > hr')).toHaveCount(1)
    await orderedTarget.dispatchEvent('drop', { dataTransfer: transfer, clientY: 0 })
    await page.evaluate(() => Reflect.get(window, 'probe').finishOrder(true))
    await expect(page.getByRole('status')).toHaveText('sessionOrderSaved')
    await expect(page.locator('section').getByRole('status')).toHaveCount(0)
    await expect(page.getByRole('status')).toHaveCount(0, { timeout: TIMEOUT })
    assert.deepEqual(
      await page
        .locator('[data-testid^="project-task-"][draggable] button[aria-current]')
        .allTextContents(),
      ['Root A', 'Child B', 'Child A', 'Root B']
    )
    const orderedRoot = page.getByTestId('project-task-root-a')
    const rootTarget = page.getByTestId('project-task-root-b')
    await orderedRoot.dispatchEvent('dragstart', { dataTransfer: transfer })
    const rootBounds = await rootTarget.boundingBox()
    assert.ok(rootBounds)
    await rootTarget.dispatchEvent('drop', {
      dataTransfer: transfer,
      clientY: rootBounds.y + rootBounds.height,
    })
    await page.evaluate(() => Reflect.get(window, 'probe').finishOrder(true))
    assert.deepEqual(
      await page
        .locator('[data-testid^="project-task-"][draggable] button[aria-current]')
        .allTextContents(),
      ['Root B', 'Root A', 'Child B', 'Child A']
    )
    await rootTarget.dispatchEvent('dragstart', { dataTransfer: transfer })
    const expandedBounds = await orderedRoot.boundingBox()
    assert.ok(expandedBounds)
    await orderedRoot.dispatchEvent('dragover', {
      dataTransfer: transfer,
      clientY: expandedBounds.y + expandedBounds.height,
    })
    await expect(orderedRoot.locator(':scope > div > hr')).toHaveCount(0)
    await expect(orderedTarget.locator(':scope > div > hr')).toHaveCount(1)
    await orderedTarget.dispatchEvent('drop', { dataTransfer: transfer, clientY: 0 })
    await page.evaluate(() => Reflect.get(window, 'probe').finishOrder(true))
    assert.deepEqual(
      await page
        .locator('[data-testid^="project-task-"][draggable] button[aria-current]')
        .allTextContents(),
      ['Root A', 'Child B', 'Child A', 'Root B']
    )
    await orderedRoot.getByRole('button', { name: 'collapseChildren', exact: true }).click()
    await rootTarget.dispatchEvent('dragstart', { dataTransfer: transfer })
    const collapsedBounds = await orderedRoot.boundingBox()
    assert.ok(collapsedBounds)
    await orderedRoot.dispatchEvent('dragover', {
      dataTransfer: transfer,
      clientY: collapsedBounds.y + collapsedBounds.height,
    })
    await expect(orderedRoot.locator(':scope > div > hr')).toHaveCount(1)
    await rootTarget.dispatchEvent('dragend')
    await expect(orderedRoot.locator(':scope > div > hr')).toHaveCount(0)
    await orderedRoot.getByRole('button', { name: 'expandChildren', exact: true }).click()
    assert.deepEqual(await page.evaluate(() => Reflect.get(window, 'probe').orderCalls), [
      { id: 'child-b', target: 'child-a', placement: 'before' },
      { id: 'child-b', target: 'child-a', placement: 'before' },
      { id: 'root-a', target: 'root-b', placement: 'after' },
      { id: 'root-b', target: 'root-a', placement: 'after' },
    ])
    assert.deepEqual(await page.evaluate(() => Reflect.get(window, 'probe').opened), [
      'task-a',
      'archive-a',
    ])
    await orderedTarget.dispatchEvent('dragstart', { dataTransfer: transfer })
    await orderedChild.dispatchEvent('drop', { dataTransfer: transfer, clientY: 0 })
    await page.evaluate(() => Reflect.get(window, 'probe').switchProject('/b'))
    await expect(page.getByTestId('project-task-task-b')).toBeVisible()
    await page.evaluate(() => Reflect.get(window, 'probe').finishOrder(false))
    await expect(page.getByRole('alert')).toHaveCount(0)
    await expect(page.getByRole('status')).toHaveCount(0, { timeout: TIMEOUT })
    await page.evaluate((count) => {
      Reflect.get(window, 'probe').switchProject('/a')
      Reflect.get(window, 'probe').setRows([
        ...Array.from({ length: count }, (_entry, index) => ({
          session_id: 'page-' + index,
          title: 'Page ' + index,
          project_path: '/a',
        })),
        { session_id: 'last-parent', title: 'Last parent', project_path: '/a' },
        {
          session_id: 'last-child',
          title: 'Last child',
          project_path: '/a',
          display_parent_session_id: 'last-parent',
        },
      ])
    }, CATALOG_PAGE_SIZE)
    await expect(page.locator('[data-testid^="project-task-"][draggable]')).toHaveCount(
      CATALOG_PAGE_SIZE + 2
    )
    await expect(page.getByTestId('project-task-last-child')).toBeAttached()
    await expect(
      page
        .getByTestId('project-task-last-parent')
        .getByRole('button', { name: 'collapseChildren', exact: true })
    ).toHaveCount(1)
    await page.evaluate(() => {
      const probe = Reflect.get(window, 'probe')
      delete probe.releaseLoad
      probe.deferLoads = true
      probe.refreshCatalog()
    })
    await page.waitForFunction(() => typeof Reflect.get(window, 'probe').releaseLoad === 'function')
    await page.evaluate(() => {
      const probe = Reflect.get(window, 'probe')
      probe.staleLoad = probe.releaseLoad
      probe.deferLoads = false
      probe.switchProject('/b')
    })
    await expect(page.getByTestId('project-task-task-b')).toBeVisible()
    await page.evaluate(() => Reflect.get(window, 'probe').staleLoad())
    await expect(page.getByTestId('project-task-last-child')).toHaveCount(0)
    await expect(page.getByTestId('project-task-task-b')).toBeVisible()
    assert.deepEqual(errors, [])
  } finally {
    await browser?.close()
    await server.close()
  }
})

test('project list directly detaches children without shifting the drag source', async () => {
  const server = await servers.create({
    configFile: false,
    root: ROOT,
    plugins: [probePlugin(), react()],
    cacheKey: 'navigation',
    server: { host: '127.0.0.1', port: 0 },
  })
  let browser: Browser | undefined
  try {
    await server.listen()
    const address = server.httpServer!.address()
    assert.ok(address && typeof address === 'object')
    browser = await chromium.launch({ headless: true })
    const page = await browser.newPage({ viewport: DRAG_VIEWPORT })
    page.setDefaultTimeout(TIMEOUT)
    await page.addInitScript(() => {
      Reflect.set(window, 'groupRows', [
        { session_id: 'parent', title: 'Parent', project_path: '/a' },
        {
          session_id: 'child',
          title: 'Child',
          project_path: '/a',
          display_parent_session_id: 'parent',
        },
        {
          session_id: 'sibling',
          title: 'Sibling',
          project_path: '/a',
          display_parent_session_id: 'parent',
        },
      ])
    })
    await page.goto(`http://127.0.0.1:${address.port}/__navigation`)
    await page.addStyleTag({
      content: `#root { width: ${PROJECT_PANEL_WIDTH}px; height: ${DRAG_VIEWPORT.height}px; } #root [data-session-actions] + div { display: none; }`,
    })
    const child = page.getByTestId('project-task-child')
    await expect(child).toHaveAttribute('draggable', 'true')
    const source = await child.elementHandle()
    assert.ok(source)
    const before = await child.boundingBox()
    const buttonCount = await page.getByRole('button').count()
    const transfer = await page.evaluateHandle(() => new DataTransfer())
    await child.dispatchEvent('dragstart', { dataTransfer: transfer })
    assert.ok(await source.evaluate((element) => element.isConnected))
    assert.deepEqual(await child.boundingBox(), before)
    assert.equal(await page.getByRole('button').count(), buttonCount)
    await child.dispatchEvent('dragend')
    await child.dragTo(page.getByTestId('project-task-sibling'))
    assert.deepEqual(await page.evaluate(() => Reflect.get(window, 'probe').orderCalls), [
      { id: 'child', target: 'sibling', placement: 'after' },
    ])
    await page.evaluate(() => Reflect.get(window, 'probe').finishOrder(true))
    await expect(child).toHaveAttribute('draggable', 'true')
    await child.dragTo(page.getByTestId('project-task-parent'))
    assert.deepEqual(await page.evaluate(() => Reflect.get(window, 'probe').detachCalls), ['child'])
    await page.evaluate(() => Reflect.get(window, 'probe').finishDetach(false))
    await expect(child).toHaveAttribute('draggable', 'true')
    const list = page.getByTestId('project-task-list')
    const listBounds = await list.boundingBox()
    const lastBounds = await child.boundingBox()
    assert.ok(listBounds && lastBounds)
    await child.dispatchEvent('dragstart', { dataTransfer: transfer })
    await list.dispatchEvent('drop', { dataTransfer: transfer, clientY: listBounds.y })
    assert.deepEqual(await page.evaluate(() => Reflect.get(window, 'probe').detachCalls), ['child'])
    await list.dispatchEvent('drop', {
      dataTransfer: transfer,
      clientY: (lastBounds.y + lastBounds.height + listBounds.y + listBounds.height) / 2,
    })
    assert.deepEqual(await page.evaluate(() => Reflect.get(window, 'probe').detachCalls), [
      'child',
      'child',
    ])
  } finally {
    await browser?.close()
    await server.close()
  }
})
