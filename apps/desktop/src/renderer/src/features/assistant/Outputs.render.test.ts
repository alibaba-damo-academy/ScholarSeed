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
const PREFIX = '\0outputs-probe:'
const ENTRY = 'outputs-entry'
type ProbeWindow = Window & {
  probe: {
    loads: number
    pending: ((response: unknown) => void)[]
    invalidate: () => void
    mutate: () => void
    blockDirectories: boolean
    directoryPending: (() => void)[]
    switchProject: () => void
  }
}
const modules: Record<string, string> = {
  'react-i18next': `export const useTranslation = () => ({t: key => key, i18n: {language: 'en'}})`,
  '../../api': `
    export function getTaskFiles() {
      window.probe.loads++
      return new Promise(resolve => window.probe.pending.push(resolve))
    }
    export async function getSessionFiles(session, path, timeout, offset) {
      if (session !== 'first') return null
      if (window.probe.blockDirectories) await new Promise(resolve => window.probe.directoryPending.push(resolve))
      const names = path === 'results' ? ['nested/'] : path === 'results/nested' ? ['pool.csv'] : []
      return {root: '/task', path, crumbs: [], items: names.map(name => ({name: name.endsWith('/') ? name.slice(0, -1) : name, dir: name.endsWith('/'), size: 0}))}
    }
  `,
  '../../store': `
    import {useSyncExternalStore} from 'react'
    let revision = 0
    let tree = []
    const subscribers = new Set()
    let project = {id: 'project', path: '/project'}
    export const selectedProject = () => project
    export const activeThread = () => ({})
    export function useApp() {
      const value = useSyncExternalStore(callback => {subscribers.add(callback); return () => subscribers.delete(callback)}, () => revision)
      window.probe.invalidate = () => {revision++; subscribers.forEach(callback => callback())}
      window.probe.mutate = () => {tree = []; subscribers.forEach(callback => callback())}
      window.probe.switchProject = () => {project = {id: 'other', path: '/other'}; revision++; subscribers.forEach(callback => callback())}
      useSyncExternalStore(callback => {subscribers.add(callback); return () => subscribers.delete(callback)}, () => tree)
      return {state: {sessionCatalogRevision: value, resource: {tree}}, act: {}}
    }
  `,
  '../../components/ui': `
    import React from 'react'
    export const Button = ({children, ...props}) => <button {...props}>{children}</button>
    export const Spinner = () => <div role="status">Loading</div>
    export const EllipsisText = ({children}) => <span>{children}</span>
    export const EmptyState = ({title, image}) => <div><img src={image.src} alt={image.alt}/>{title}</div>
    export const IconButton = ({label, icon, ...props}) => <Button aria-label={label} {...props}>{icon}</Button>
    export const Table = ({children}) => <table>{children}</table>
    export const TableHeader = ({children}) => <thead>{children}</thead>
    export const TableBody = ({children}) => <tbody>{children}</tbody>
    export const TableRow = ({children, ...props}) => <tr {...props}>{children}</tr>
    export const TableHead = ({children}) => <th>{children}</th>
    export const TableCell = ({children, colSpan}) => <td colSpan={colSpan}>{children}</td>
  `,
  '../../components/business/Library': `
    import React from 'react'
    export const LIBRARY_PAGE_CLASS = ''
    export const LIBRARY_HEADER_ACTION_CLASS = ''
    export const LIBRARY_TABLE_HEADER_CLASS = ''
    export const LibraryFilter = ({label, value, options, onChange}) => <select aria-label={label} value={value} onChange={event => onChange(event.target.value)}><option value="">All</option>{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
    export const LibraryToolbar = ({onRefresh, refreshing, query, onQuery}) => <><input aria-label="Search outputs" value={query} onChange={event => onQuery(event.target.value)}/><button aria-busy={refreshing} onClick={onRefresh}>Refresh</button></>
  `,
  '../../components/business/utils': `export const libraryFileType = name => name.split('.').at(-1).toUpperCase(); export const libraryUpdatedAt = () => ''`,
  '../../components/primitive': `export const FileFormatIcon = () => null`,
  '../../components/markdown/links': `export const absoluteSessionFilePath = (root, path) => root + '/' + path`,
  '../project/events': `export const subscribeFileEvents = () => () => {}`,
  './Files': `export const OutputFileLink = ({children, mode, path}) => mode === 'actions' ? <button aria-label={'More ' + path}/> : children`,
  '../../model': `export const artifactIsDeliverable = artifact => artifact.deliverable !== false`,
  '../../drag': `export const writeProjectEntryDrag = () => {}`,
  './Artifacts': `export const ArtifactEntry = () => <button aria-label="Published artifact actions"/>`,
  './catalog': `export const visibleOutputs = rows => rows; export const outputCategory = () => 'final'`,
}
const names = [ENTRY, ...Object.keys(modules)]
const plugin: Plugin = {
  name: 'outputs-probe',
  enforce: 'pre',
  resolveId(source, importer) {
    if (source.startsWith(PREFIX)) return source
    if (source === ENTRY || (importer?.endsWith('/assistant/Outputs.tsx') && source in modules))
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
      import {Outputs} from '/features/assistant/Outputs.tsx'
      window.probe = {loads: 0, pending: [], blockDirectories: false, directoryPending: []}
      createRoot(document.getElementById('root')).render(<Outputs />)
    `
        : modules[name]
    return (
      await transformWithEsbuild(source, 'outputs-probe.tsx', {
        loader: 'tsx',
        jsx: 'automatic',
        tsconfigRaw: {},
      })
    ).code
  },
  configureServer(server) {
    server.middlewares.use('/__outputs', (_request, response, next) => {
      server
        .transformIndexHtml(
          '/__outputs',
          '<div id="root"></div><script type="module" src="/@id/__x00__outputs-probe:0.tsx"></script>'
        )
        .then((html) => {
          response.setHeader('Content-Type', 'text/html')
          response.end(html)
        })
        .catch(next)
    })
  },
}

test('filters without a search query remove empty groups and restore nested files when cleared', async () => {
  const server = await servers.create({
    configFile: false,
    root: ROOT,
    plugins: [plugin, react()],
    cacheKey: 'outputs',
    optimizeDeps: { noDiscovery: true, include: ['react', 'react-dom/client', 'lucide-react'] },
    server: { host: '127.0.0.1', port: 0 },
  })
  await server.listen()
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.goto(`${server.resolvedUrls!.local[0]}__outputs`)
    await expect
      .poll(() => page.evaluate(() => (window as unknown as ProbeWindow).probe.pending.length))
      .toBe(1)
    await page.evaluate(() =>
      (window as unknown as ProbeWindow).probe.pending.shift()!({
        entries: [
          {
            session: { session_id: 'first', title: 'Working task' },
            files: { root: '/task', path: '', items: [{ name: 'results', dir: true }] },
          },
          {
            session: { session_id: 'second', title: 'Empty task' },
            files: { root: '/other', path: '', items: [] },
          },
        ],
      })
    )
    await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toHaveAttribute(
      'aria-busy',
      'false'
    )
    await expect(page.getByText('Empty task', { exact: true })).toHaveCount(0)
    await page.getByLabel('outputStage').selectOption('final')
    await expect(page.getByText('noMatchingOutputs', { exact: true })).toBeVisible()
    await expect(page.locator('[data-testid^="output-group-"]')).toHaveCount(0)
    await expect(page.getByText('results', { exact: true })).toHaveCount(0)
    await page.getByLabel('outputStage').selectOption('')
    await page.getByRole('button', { name: 'Working task', exact: true }).first().click()
    await page.getByRole('button', { name: 'results', exact: true }).click()
    await page.getByRole('button', { name: 'nested', exact: true }).click()
    await expect(page.getByText('pool.csv', { exact: true })).toBeVisible()
    await page.getByLabel('fileType').selectOption('CSV')
    await expect(page.getByText('pool.csv', { exact: true })).toBeVisible()
    await page.getByRole('textbox', { name: 'Search outputs' }).fill('Working task')
    await page.getByLabel('outputStage').selectOption('final')
    await expect(page.getByText('noMatchingOutputs', { exact: true })).toBeVisible()
    await expect(page.locator('[data-testid^="output-group-"]')).toHaveCount(0)
  } finally {
    await browser.close()
    await server.close()
  }
})

test('output search finishes in-flight traversal and retains matches across repeated refreshes', async () => {
  const server = await servers.create({
    configFile: false,
    root: ROOT,
    plugins: [plugin, react()],
    cacheKey: 'outputs',
    optimizeDeps: { noDiscovery: true, include: ['react', 'react-dom/client', 'lucide-react'] },
    server: { host: '127.0.0.1', port: 0 },
  })
  await server.listen()
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.goto(`${server.resolvedUrls!.local[0]}__outputs`)
    const catalog = (filename: string) => ({
      entries: [
        {
          session: { session_id: 'first', title: 'Working task' },
          files: {
            root: '/task',
            path: '',
            items: [
              { name: filename, dir: false, size: 1 },
              { name: 'slow', dir: true, size: 0 },
            ],
          },
        },
      ],
    })
    await expect
      .poll(() => page.evaluate(() => (window as unknown as ProbeWindow).probe.pending.length))
      .toBe(1)
    await page.evaluate((response) => {
      const probe = (window as unknown as ProbeWindow).probe
      probe.blockDirectories = true
      probe.pending.shift()!(response)
    }, catalog('original.md'))
    await page.getByRole('textbox', { name: 'Search outputs' }).fill('md')
    await expect
      .poll(() =>
        page.evaluate(() => (window as unknown as ProbeWindow).probe.directoryPending.length)
      )
      .toBe(1)
    await expect(page.getByText('original.md', { exact: true })).toBeVisible()
    for (const filename of ['intermediate.md', 'latest.md']) {
      await page.evaluate(() => (window as unknown as ProbeWindow).probe.invalidate())
      await expect
        .poll(() => page.evaluate(() => (window as unknown as ProbeWindow).probe.pending.length))
        .toBe(1)
      await page.evaluate(
        (response) => (window as unknown as ProbeWindow).probe.pending.shift()!(response),
        catalog(filename)
      )
      await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toHaveAttribute(
        'aria-busy',
        'true'
      )
      await expect(page.getByText('original.md', { exact: true })).toBeVisible()
    }
    await page.evaluate(() => (window as unknown as ProbeWindow).probe.directoryPending.shift()!())
    await expect(page.getByText('latest.md', { exact: true })).toBeVisible()
    await expect
      .poll(() =>
        page.evaluate(() => (window as unknown as ProbeWindow).probe.directoryPending.length)
      )
      .toBe(1)
    await page.getByRole('textbox', { name: 'Search outputs' }).fill('latest')
    await expect(page.getByText('latest.md', { exact: true })).toBeVisible()
    await page.getByRole('textbox', { name: 'Search outputs' }).fill('not-present')
    await expect(page.getByRole('status')).toBeVisible()
    await expect(page.getByText('noMatchingOutputs')).toHaveCount(0)
    await page.getByRole('textbox', { name: 'Search outputs' }).fill('md')
    await page.evaluate(() => (window as unknown as ProbeWindow).probe.directoryPending.shift()!())
    await expect(page.getByText('latest.md', { exact: true })).toBeVisible()
    await expect(page.getByText('original.md', { exact: true })).toHaveCount(0)
    await expect(page.getByText('intermediate.md', { exact: true })).toHaveCount(0)
    await expect(page.getByRole('status')).toHaveCount(0)
    await page.evaluate(() => (window as unknown as ProbeWindow).probe.invalidate())
    await expect
      .poll(() => page.evaluate(() => (window as unknown as ProbeWindow).probe.pending.length))
      .toBe(1)
    await page.evaluate(
      (response) => (window as unknown as ProbeWindow).probe.pending.shift()!(response),
      catalog('stale.md')
    )
    await expect
      .poll(() =>
        page.evaluate(() => (window as unknown as ProbeWindow).probe.directoryPending.length)
      )
      .toBe(1)
    await page.evaluate(() => (window as unknown as ProbeWindow).probe.invalidate())
    await expect
      .poll(() => page.evaluate(() => (window as unknown as ProbeWindow).probe.pending.length))
      .toBe(1)
    await page.evaluate(() => (window as unknown as ProbeWindow).probe.switchProject())
    await expect(page.getByRole('textbox', { name: 'Search outputs' })).toHaveValue('')
    await expect
      .poll(() => page.evaluate(() => (window as unknown as ProbeWindow).probe.pending.length))
      .toBe(2)
    await page.evaluate(() => {
      const probe = (window as unknown as ProbeWindow).probe
      probe.directoryPending.shift()!()
      probe.pending.shift()!({
        entries: [
          {
            session: { session_id: 'first', title: 'Stale catalog' },
            files: { root: '/task', path: '', items: [{ name: 'ghost.md', dir: false, size: 1 }] },
          },
        ],
      })
      probe.pending.shift()!({
        entries: [
          {
            session: { session_id: 'second', title: 'Other project' },
            files: { root: '/other', path: '', items: [{ name: 'other.md', dir: false, size: 1 }] },
          },
        ],
      })
    })
    await page.getByRole('textbox', { name: 'Search outputs' }).fill('md')
    await expect(page.getByText('other.md', { exact: true })).toBeVisible()
    await expect(page.getByText('stale.md', { exact: true })).toHaveCount(0)
    await expect(page.getByText('latest.md', { exact: true })).toHaveCount(0)
    await expect(page.getByText('ghost.md', { exact: true })).toHaveCount(0)
  } finally {
    await browser.close()
    await server.close()
  }
})

test('output catalog finishes its first request during invalidation and retains rows during refresh', async () => {
  const server = await servers.create({
    configFile: false,
    root: ROOT,
    plugins: [plugin, react()],
    cacheKey: 'outputs',
    optimizeDeps: { noDiscovery: true, include: ['react', 'react-dom/client', 'lucide-react'] },
    server: { host: '127.0.0.1', port: 0 },
  })
  await server.listen()
  const browser = await chromium.launch({ headless: true })
  try {
    const address = server.httpServer!.address()
    assert.ok(address && typeof address === 'object')
    const page = await browser.newPage()
    await page.goto(`http://127.0.0.1:${address.port}/__outputs`)
    await expect(page.getByRole('status')).toBeVisible()
    await page.evaluate(() => {
      const probe = (window as unknown as ProbeWindow).probe
      probe.invalidate()
      probe.invalidate()
      probe.invalidate()
    })
    await expect
      .poll(() => page.evaluate(() => (window as unknown as ProbeWindow).probe.loads))
      .toBe(1)
    await expect(page.getByRole('status')).toBeVisible()
    await page.evaluate(() =>
      (window as unknown as ProbeWindow).probe.pending.shift()!({
        entries: [
          {
            session: { session_id: 'first', title: 'Working task' },
            files: {
              root: '/task',
              path: '',
              items: [
                { name: 'started.txt', dir: false, size: 7 },
                {
                  name: 'published.bin',
                  dir: false,
                  size: 1,
                  artifact: { artifact_id: 'published' },
                },
                {
                  name: 'candidate.bin',
                  dir: false,
                  size: 1,
                  artifact: { artifact_id: 'candidate', deliverable: false },
                },
                { name: 'results', dir: true, size: 0 },
              ],
            },
          },
          {
            session: { session_id: 'second', title: 'Other task' },
            files: {
              root: '/other',
              path: '',
              items: [{ name: 'other.txt', dir: false, size: 1 }],
            },
          },
        ],
      })
    )
    await expect(page.getByText('Working task')).toBeVisible()
    const first = page.getByTestId('output-group-first')
    const second = page.getByTestId('output-group-second')
    const search = page.getByRole('textbox', { name: 'Search outputs' })
    await first.locator('button[aria-expanded]').click()
    await expect(page.getByRole('button', { name: 'More started.txt', exact: true })).toBeVisible()
    await expect(
      page.getByRole('button', { name: 'More candidate.bin', exact: true })
    ).toBeVisible()
    await expect(page.getByRole('button', { name: 'Published artifact actions' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'More published.bin', exact: true })).toHaveCount(
      0
    )
    await expect(page.getByRole('button', { name: 'More results', exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: 'results', exact: true }).click()
    await expect(page.getByRole('button', { name: 'nested', exact: true })).toHaveAttribute(
      'aria-expanded',
      'false'
    )
    await search.fill('POOL')
    await expect(page.getByText('pool.csv', { exact: true })).toBeVisible()
    await expect(first).toBeVisible()
    await expect(second).toHaveCount(0)
    await expect(page.getByText('started.txt', { exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'nested', exact: true })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
    await search.fill('Other task')
    await expect(first).toHaveCount(0)
    await expect(page.getByText('other.txt', { exact: true })).toBeVisible()
    await search.fill('no match')
    await expect(page.getByText('noMatchingOutputs')).toBeVisible()
    await search.fill('')
    await expect(first).toBeVisible()
    await expect(second.locator('button[aria-expanded]')).toHaveAttribute('aria-expanded', 'false')
    await expect(page.getByRole('button', { name: 'results', exact: true })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
    await expect(page.getByRole('button', { name: 'nested', exact: true })).toHaveAttribute(
      'aria-expanded',
      'false'
    )
    await expect(page.getByText('pool.csv', { exact: true })).toHaveCount(0)
    await page.evaluate(() => (window as unknown as ProbeWindow).probe.mutate())
    await expect(page.getByText('Working task')).toBeVisible()
    await expect
      .poll(() => page.evaluate(() => (window as unknown as ProbeWindow).probe.pending.length))
      .toBe(1)
    await page.evaluate(() =>
      (window as unknown as ProbeWindow).probe.pending.shift()!({ entries: [] })
    )
    await expect(page.getByText('emptyOutputs')).toBeVisible()
    await page.evaluate(() => (window as unknown as ProbeWindow).probe.invalidate())
    await expect
      .poll(() => page.evaluate(() => (window as unknown as ProbeWindow).probe.pending.length))
      .toBe(1)
    await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toHaveAttribute(
      'aria-busy',
      'false'
    )
    await expect(page.getByRole('status')).toHaveCount(0)
    await expect(page.getByText('emptyOutputs')).toBeVisible()
    await page.evaluate(() =>
      (window as unknown as ProbeWindow).probe.pending.shift()!({ entries: [] })
    )
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toHaveAttribute(
      'aria-busy',
      'true'
    )
    await expect(page.getByRole('status')).toBeVisible()
  } finally {
    await browser.close()
    await server.close()
  }
})
