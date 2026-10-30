import assert from 'node:assert/strict'
import path from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'

import { chromium, expect, type Browser } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { transformWithEsbuild, type Plugin } from 'vite'
import { renderServers } from '../../../../test-helpers/render.ts'

const servers = renderServers({ after })

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const PROBE_PATH = '/__selection_probe'
const VIRTUAL_PREFIX = '\0selection-probe:'
const VIRTUAL_SUFFIX = '.tsx'
const ENTRY = 'selection-probe-entry'
const HOST_SUFFIX = '/features/workbench/Selection.tsx'
const INTERACTION_TIMEOUT_MS = 10000
const modules: Record<string, string> = {
  './workspace': `
    import { useSyncExternalStore } from 'react'
    const listeners = new Set()
    const selection = { document_session_id: 'session', document_id: 'document', revision: 'revision', status: 'exact', text: 'selected text', locator: { kind: 'text', start: 0, end: 13 } }
    const session = { id: 'session', documentId: 'document', revision: 'revision', changeVersion: 0, title: 'document', selection, text: selection.text, source: { kind: 'project', project: 'project', path: 'resources/document.md' }, capabilities: { can_select: true, can_edit: false } }
    let state = { focusedTabId: 'tab', tabs: { tab: { id: 'tab', sessionId: 'session' } }, sessions: { session }, selectionPresentations: { tab: { fingerprint: 'original', point: { x: 100, y: 100 }, visible: true } } }
    export function updateSelection(mode) {
      const selected = mode === 'clear' ? null : selection
      state = { ...state, focusedTabId: mode === 'tab' ? 'other' : 'tab', sessions: { session: { ...session, revision: mode === 'revision' ? 'changed' : 'revision', selection: selected } }, selectionPresentations: selected ? { tab: { fingerprint: mode === 'new' ? 'new' : 'original', point: { x: 100, y: 100 }, visible: true } } : {} }
      for (const listener of listeners) listener()
    }
    export function useDocumentWorkspace() { return useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener) }, () => state) }
    export function useWorkspaceController() { return { getSnapshot: () => state } }
    export function focusedSelectionPresentation(value) { const tab = value.tabs[value.focusedTabId]; const session = tab && value.sessions[tab.sessionId]; return session?.selection ? { tab, session, selection: session.selection, presentation: value.selectionPresentations[tab.id] } : null }
  `,
  './actions': `
    const registry = { get: () => [], dismiss: () => {} }
    export const useSelectionActionRegistry = () => registry
    export const useSelectionActions = () => []
    export const selectionAnnotationFor = () => undefined
    export const selectionReplacementFor = () => undefined
  `,
  '../assistant/ingress': 'export const useAssistantIngress = () => ({})',
  '../../reference': 'export const focusComposer = () => {}',
  '../../icons': 'export const Icon = () => null',
  'react-i18next': 'export const useTranslation = () => ({ t: key => key })',
  '../../components/ui': `
    import React from 'react'
    export const Button = ({ children, onClick }) => <button onClick={onClick}>{children}</button>
    export const Badge = ({ children }) => <span>{children}</span>
    export const Divider = () => null
    export const FloatingToolbar = React.forwardRef(({ actions, children, label }, ref) => <div ref={ref} aria-label={label}>{actions}{children}</div>)
  `,
  '../resources/Suggestion': `
    import React, { useEffect, useState } from 'react'
    export const RESOURCE_AI_SUGGESTION_SELECTOR = '[data-resource-ai-suggestion]'
    let sequence = 0
    export function ResourceSuggestion({ pinned, onPinnedChange, onClose, snapshot, anchorPosition }) {
      const [instance] = useState(() => ++sequence)
      const [output, setOutput] = useState('')
      const [busy, setBusy] = useState(false)
      useEffect(() => { snapshot.then(() => {}); return () => { window.abortedSuggestions = (window.abortedSuggestions ?? 0) + 1 } }, [])
      return <div data-resource-ai-suggestion data-testid="suggestion" data-instance={instance} data-busy={busy} data-attached={Boolean(anchorPosition)}>
        <button onClick={() => { setOutput('retained output'); setBusy(true) }}>Generate</button>
        <button onClick={() => setBusy(false)}>Complete</button>
        <button aria-pressed={pinned} onClick={() => onPinnedChange(!pinned)}>Pin</button>
        <button onClick={onClose}>Close</button>
        <output>{output}</output>
      </div>
    }
  `,
  [ENTRY]: `
    import React from 'react'
    import { createRoot } from 'react-dom/client'
    import { SelectionActionHost } from '/features/workbench/Selection.tsx'
    import { updateSelection } from 'selection-probe-workspace'
    createRoot(document.getElementById('root')).render(<>
      <button onClick={() => updateSelection('clear')}>Blank</button>
      <button onClick={() => updateSelection('original')}>Reselect</button>
      <button onClick={() => updateSelection('new')}>New selection</button>
      <button onClick={() => updateSelection('tab')}>Switch tab</button>
      <button onClick={() => updateSelection('revision')}>Change revision</button>
      <SelectionActionHost />
    </>)
  `,
}
const MODULE_KEYS = Object.keys(modules)

function moduleId(key: string): string {
  return VIRTUAL_PREFIX + MODULE_KEYS.indexOf(key) + VIRTUAL_SUFFIX
}

function probePlugin(): Plugin {
  return {
    name: 'selection-lifecycle-probe',
    enforce: 'pre',
    resolveId(id, importer) {
      if (id.startsWith(VIRTUAL_PREFIX)) return id
      if (id === 'selection-probe-workspace') return moduleId('./workspace')
      if (id === ENTRY || (importer?.includes(HOST_SUFFIX) && id in modules)) return moduleId(id)
    },
    load(id) {
      if (id.startsWith(VIRTUAL_PREFIX))
        return modules[MODULE_KEYS[Number(id.slice(VIRTUAL_PREFIX.length, -VIRTUAL_SUFFIX.length))]]
    },
    transform(code, id) {
      if (id.startsWith(VIRTUAL_PREFIX))
        return transformWithEsbuild(code, 'selection-probe.tsx', {
          loader: 'tsx',
          jsx: 'automatic',
          tsconfigRaw: {},
        })
    },
    configureServer(server) {
      server.middlewares.use(PROBE_PATH, (_request, response, next) => {
        server
          .transformIndexHtml(
            PROBE_PATH,
            `<!doctype html><html><body><div id="root"></div><script type="module" src="/@id/__x00__selection-probe:${MODULE_KEYS.indexOf(ENTRY)}${VIRTUAL_SUFFIX}"></script></body></html>`
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

async function verifyPinnedSuggestion(action: string): Promise<void> {
  const server = await servers.create({
    configFile: false,
    root: ROOT_DIR,
    plugins: [probePlugin(), react()],
    cacheKey: 'selection',
    server: { host: '127.0.0.1', port: 0 },
  })
  let browser: Browser | undefined
  try {
    await server.listen()
    browser = await chromium.launch()
    const page = await browser.newPage()
    page.setDefaultTimeout(INTERACTION_TIMEOUT_MS)
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error') console.error(message.text())
    })
    await page.goto(new URL(PROBE_PATH, server.resolvedUrls!.local[0]).href)
    const suggestion = page.getByTestId('suggestion')
    await page
      .getByRole('button', { name: `selection.${action}`, exact: true })
      .click()
      .catch(async (error) => {
        console.error({ errors, body: await page.locator('body').innerText() })
        throw error
      })
    await suggestion.getByRole('button', { name: 'Generate', exact: true }).click()
    await suggestion.getByRole('button', { name: 'Pin', exact: true }).click()
    const instance = await suggestion.getAttribute('data-instance')
    for (const action of ['Blank', 'Reselect', 'New selection']) {
      await page.getByRole('button', { name: action, exact: true }).click()
      await expect(suggestion).toHaveAttribute('data-instance', instance!)
      await expect(suggestion).toHaveAttribute('data-busy', 'true')
      await expect(suggestion.locator('output')).toHaveText('retained output')
    }
    await suggestion.getByRole('button', { name: 'Complete', exact: true }).click()
    await page.getByRole('button', { name: 'Blank', exact: true }).click()
    await expect(suggestion).toHaveAttribute('data-instance', instance!)
    await expect(suggestion).toHaveAttribute('data-busy', 'false')
    await expect(suggestion.locator('output')).toHaveText('retained output')
    assert.equal(await page.evaluate(() => Reflect.get(window, 'abortedSuggestions') ?? 0), 0)
    await suggestion.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(suggestion).toHaveCount(0)
    await page.getByRole('button', { name: 'Reselect', exact: true }).click()
    await page.getByRole('button', { name: `selection.${action}`, exact: true }).click()
    await suggestion.getByRole('button', { name: 'Pin', exact: true }).click()
    await page.getByRole('button', { name: 'Blank', exact: true }).click()
    await suggestion.getByRole('button', { name: 'Pin', exact: true }).click()
    await page.getByRole('button', { name: 'Blank', exact: true }).click()
    await expect(suggestion).toHaveCount(0)
    for (const boundary of ['Blank', 'Switch tab', 'Change revision']) {
      await page.getByRole('button', { name: 'Reselect', exact: true }).click()
      await page.getByRole('button', { name: `selection.${action}`, exact: true }).click()
      if (boundary !== 'Blank')
        await suggestion.getByRole('button', { name: 'Pin', exact: true }).click()
      await page.getByRole('button', { name: boundary, exact: true }).click()
      await expect(suggestion).toHaveCount(0)
    }
    assert.deepEqual(errors, [])
  } finally {
    await browser?.close()
    await server.close()
  }
}

for (const action of ['explain', 'translate']) {
  test(`pinned ${action} preserves its mounted request and result across selection detach and reattach`, () =>
    verifyPinnedSuggestion(action))
}
