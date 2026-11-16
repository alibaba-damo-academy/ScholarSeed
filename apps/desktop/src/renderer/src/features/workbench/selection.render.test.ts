import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'

import { chromium, expect, type Browser } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { transformWithEsbuild, type Plugin } from 'vite'
import postcss from 'postcss'
import tailwindcss from '@tailwindcss/postcss'
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
      const selected = mode === 'clear' ? null : mode.startsWith('pdf') ? { ...selection, locator: { kind: 'pdf', page: 1, quads: [[0, 0, 100, 0, 100, 20, 0, 20]] } } : selection
      const top = mode === 'pdf-clipped' ? -500 : mode === 'pdf-below' ? 1500 : 600
      const boundary = mode === 'pdf-narrow' ? {left:900,top:220,right:1180,bottom:620} : {left:620,top:160,right:1180,bottom:760}
      const source = mode.startsWith('pdf-artifact') ? { kind: 'session-artifact', sessionId: 'origin', artifactId: 'publication', path: 'report.pdf' } : mode === 'pdf-literature' ? { kind: 'literature', literatureId: 'paper' } : session.source
      const capabilities = { ...session.capabilities, can_select: mode !== 'pdf-artifact-denied' }
      state = { ...state, focusedTabId: mode === 'tab' ? 'other' : 'tab', sessions: { session: { ...session, source, capabilities, revision: mode === 'revision' ? 'changed' : 'revision', selection: selected } }, selectionPresentations: selected ? { tab: { fingerprint: mode === 'new' ? 'new' : 'original', point: { x: 100, y: 100 }, visible: mode !== 'pdf-hidden', ...(mode.startsWith('pdf') && mode !== 'pdf-literature' ? {boundary,rect:{left:700,right:1100,top,bottom:top+40,width:400,height:40}} : {}) } } : {} }
      if (mode === 'pdf-literature') state.selectionPresentations.tab.rect = { left: 100, right: 620, top: 80, bottom: 100 }
      for (const listener of listeners) listener()
    }
    export function useDocumentWorkspace() { return useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener) }, () => state) }
    export function useWorkspaceController() { return { getSnapshot: () => state } }
    export function focusedSelectionPresentation(value) { const tab = value.tabs[value.focusedTabId]; const session = tab && value.sessions[tab.sessionId]; return session?.selection ? { tab, session, selection: session.selection, presentation: value.selectionPresentations[tab.id] } : null }
  `,
  './actions': `
    import { useSyncExternalStore } from 'react'
    const listeners = new Set()
    const empty = []
    const disabled = [{ id: 'pdf', order: 1, expanded: false, toolbarEnabled: false, actions: null }]
    const explicit = [{ ...disabled[0], forceVisible: true, expanded: true, panel: 'Explicit comment' }]
    const expanded = [{ ...disabled[0], toolbarEnabled: true, expanded: true, panel: <div>{Array.from({length:80},(_,index)=><p key={index}>Result line {index}</p>)}</div> }]
    let current = empty
    export function setToolbarMode(mode) { current = mode === 'disabled' ? disabled : mode === 'comment' ? explicit : mode === 'expanded' ? expanded : empty; for (const listener of listeners) listener() }
    const registry = { get: () => [], dismiss: () => {} }
    export const useSelectionActionRegistry = () => registry
    export const useSelectionActions = () => useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener) }, () => current)
    export const selectionAnnotationFor = () => undefined
    export const selectionReplacementFor = () => undefined
    export const selectionToolbarVisible = items => items.every(item => item.toolbarEnabled !== false) || items.some(item => item.forceVisible)
  `,
  '../translation/context': `
    import { useSyncExternalStore } from 'react'
    const listeners = new Set()
    let settings = null
    export function setTranslationMode(mode) {
      settings = mode === 'absent' ? null : { toolbar: mode !== 'disabled', preferencesReady: mode !== 'loading' }
      for (const listener of listeners) listener()
    }
    export const useTranslationBackend = () => ({ settings: useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener) }, () => settings) })
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
    import { setToolbarMode } from 'selection-probe-actions'
    import { setTranslationMode } from 'selection-probe-translation'
    createRoot(document.getElementById('root')).render(<>
      <button onClick={() => updateSelection('clear')}>Blank</button>
      <button onClick={() => updateSelection('original')}>Reselect</button>
      <button onClick={() => updateSelection('new')}>New selection</button>
      <button onClick={() => updateSelection('tab')}>Switch tab</button>
      <button onClick={() => updateSelection('revision')}>Change revision</button>
      <button onClick={() => setToolbarMode('disabled')}>Disable toolbar</button>
      <button onClick={() => setToolbarMode('enabled')}>Enable toolbar</button>
      <button onClick={() => setToolbarMode('comment')}>Explicit comment</button>
      <button onClick={() => updateSelection('pdf')}>PDF selection</button>
      <button onClick={() => updateSelection('pdf-clipped')}>Clipped PDF selection</button>
      <button onClick={() => updateSelection('pdf-hidden')}>Hidden PDF reader</button>
      <button onClick={() => updateSelection('pdf-artifact')}>Artifact PDF selection</button>
      <button onClick={() => updateSelection('pdf-artifact-denied')}>Denied artifact selection</button>
      <button onClick={() => updateSelection('pdf-below')}>Selection below reader</button>
      <button onClick={() => updateSelection('pdf-narrow')}>Narrow reader</button>
      <button onClick={() => setToolbarMode('expanded')}>Expand PDF result</button>
      <button onClick={() => setTranslationMode('disabled')}>Disable backend toolbar</button>
      <button onClick={() => setTranslationMode('loading')}>Load backend preferences</button>
      <button onClick={() => setTranslationMode('enabled')}>Enable backend toolbar</button>
      <SelectionActionHost />
    </>)
  `,
}
const MODULE_KEYS = Object.keys(modules)

const LAYER_ENTRY = `
  import React, { useState } from 'react'
  import { createRoot } from 'react-dom/client'
  import { I18nextProvider } from 'react-i18next'
  import { createLocalization } from '/../../localization/engine'
  import { resources } from '/../../localization/resources'
  import { SelectionActionHost } from '/features/workbench/Selection.tsx'
  import { useSelectionActionContribution } from '/features/workbench/actions'
  import { Feedback } from '/components/business/Feedback'
  import { Button } from '/components/ui'
  import { updateSelection } from 'selection-probe-workspace'
  import '/styles.css'
  updateSelection('pdf-literature')
  function Fixture() {
    const [open, setOpen] = useState(false)
    const [annotated, setAnnotated] = useState(false)
    useSelectionActionContribution('tab', {
      id: 'pdf-ai', order: 5, expanded: true, ownsScroll: true, replacesDefaults: true,
      actions: <Button>Explain PDF selection</Button>,
      panel: <section style={{ width: 520, height: 300 }}>
        <p data-testid="pdf-explanation-result">Retained PDF explanation</p>
        <Button onClick={() => setAnnotated(true)}>{annotated ? 'Comment added' : 'Add explanation comment'}</Button>
      </section>,
    })
    return <>
      <Button onClick={() => setOpen(true)}>Open feedback</Button>
      <SelectionActionHost />
      {open && <Feedback phone="" sessionId={null} onClose={() => setOpen(false)} />}
    </>
  }
  const localization = createLocalization('en', resources, { report: () => undefined })
  createRoot(document.getElementById('root')).render(<I18nextProvider i18n={localization}><Fixture /></I18nextProvider>)
`

function moduleId(key: string): string {
  return VIRTUAL_PREFIX + MODULE_KEYS.indexOf(key) + VIRTUAL_SUFFIX
}

function probePlugin({ layers = false, realUi = false } = {}): Plugin {
  return {
    name: 'selection-lifecycle-probe',
    enforce: 'pre',
    resolveId(id, importer) {
      if (id.startsWith(VIRTUAL_PREFIX)) return id
      if (
        layers &&
        importer?.includes(HOST_SUFFIX) &&
        (id === './actions' || id === '../../components/ui')
      )
        return
      if (id === 'selection-probe-workspace') return moduleId('./workspace')
      if (id === 'selection-probe-actions') return moduleId('./actions')
      if (id === 'selection-probe-translation') return moduleId('../translation/context')
      if (id === ENTRY || (importer?.includes(HOST_SUFFIX) && id in modules)) return moduleId(id)
    },
    load(id) {
      if (layers && id === moduleId(ENTRY)) return LAYER_ENTRY
      if (realUi && id === moduleId('../../components/ui')) return "export * from '/components/ui'"
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

test('literature PDF selection contributions stay below feedback and retain their result', async () => {
  const server = await servers.create({
    configFile: false,
    root: ROOT_DIR,
    plugins: [probePlugin({ layers: true }), react()],
    cacheKey: 'selection-feedback',
    server: { host: '127.0.0.1', port: 0 },
  })
  let browser: Browser | undefined
  try {
    await server.listen()
    browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    const page = await browser.newPage()
    page.setDefaultTimeout(INTERACTION_TIMEOUT_MS)
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    for (const sample of [
      { width: 1280, height: 840, colorScheme: 'light' },
      { width: 1040, height: 660, colorScheme: 'dark' },
    ] as const) {
      await page.setViewportSize(sample)
      await page.emulateMedia({ colorScheme: sample.colorScheme })
      await page.goto(new URL(PROBE_PATH, server.resolvedUrls!.local[0]).href)
      const host = page.getByTestId('selection-action-host')
      const result = host.getByTestId('pdf-explanation-result')
      await expect(result).toHaveText('Retained PDF explanation')
      await expect(result).toBeVisible()
      await page.getByRole('button', { name: 'Open feedback', exact: true }).click()
      const feedback = page.getByTestId('feedback-dialog')
      await expect(feedback).toBeVisible()
      const layers = await page.evaluate(() => {
        const host = document.querySelector<HTMLElement>('[data-testid="selection-action-host"]')!
        const feedback = document.querySelector<HTMLElement>('[data-testid="feedback-dialog"]')!
        const scrim = document.querySelector<HTMLElement>('.feedback-scrim')!
        const hostRect = host.getBoundingClientRect()
        const feedbackRect = feedback.getBoundingClientRect()
        const left = Math.max(hostRect.left, feedbackRect.left)
        const right = Math.min(hostRect.right, feedbackRect.right)
        const top = Math.max(hostRect.top, feedbackRect.top)
        const bottom = Math.min(hostRect.bottom, feedbackRect.bottom)
        return {
          hostRect: hostRect.toJSON(),
          feedbackRect: feedbackRect.toJSON(),
          host: Number(getComputedStyle(host).zIndex),
          scrim: Number(getComputedStyle(scrim).zIndex),
          feedback: Number(getComputedStyle(feedback).zIndex),
          scrimColor: getComputedStyle(scrim).backgroundColor,
          overlapHit:
            left < right &&
            top < bottom &&
            feedback.contains(document.elementFromPoint((left + right) / 2, (top + bottom) / 2)),
          backgroundHit: scrim.contains(
            document.elementFromPoint(hostRect.left + 1, hostRect.top + 1)
          ),
        }
      })
      assert.ok(layers.host < layers.scrim, JSON.stringify(layers))
      assert.ok(layers.scrim < layers.feedback)
      assert.notEqual(layers.scrimColor, 'rgba(0, 0, 0, 0)')
      assert.equal(layers.overlapHit, true, JSON.stringify(layers))
      assert.equal(layers.backgroundHit, true)
      await page
        .getByTestId('feedback-description')
        .fill('PDF explanation must remain behind feedback')
      for (const key of ['Tab', 'Shift+Tab']) {
        await page.keyboard.press(key)
        assert.equal(await feedback.evaluate((node) => node.contains(document.activeElement)), true)
      }
      await page.keyboard.press('Escape')
      await expect(feedback).toHaveCount(0)
      await expect(result).toHaveText('Retained PDF explanation')
      await host.getByRole('button', { name: 'Add explanation comment', exact: true }).click()
      await expect(host.getByRole('button', { name: 'Comment added', exact: true })).toBeVisible()
    }
    assert.deepEqual(errors, [])
  } finally {
    await browser?.close()
    await server.close()
  }
})

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
    browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
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
    await page.getByRole('button', { name: 'Reselect', exact: true }).click()
    await page.getByRole('button', { name: `selection.${action}`, exact: true }).click()
    await suggestion.getByRole('button', { name: 'Pin', exact: true }).click()
    await page.getByRole('button', { name: 'Disable toolbar', exact: true }).click()
    await expect(suggestion).toHaveCount(0)
    await page.getByRole('button', { name: 'New selection', exact: true }).click()
    await expect(
      page.getByRole('button', { name: `selection.${action}`, exact: true })
    ).toHaveCount(0)
    await page.getByRole('button', { name: 'Explicit comment', exact: true }).click()
    await expect(page.getByText('Explicit comment', { exact: true }).last()).toBeVisible()
    await expect(
      page.getByRole('button', { name: `selection.${action}`, exact: true })
    ).toHaveCount(0)
    await page.getByRole('button', { name: 'Enable toolbar', exact: true }).click()
    await expect(
      page.getByRole('button', { name: `selection.${action}`, exact: true })
    ).toBeVisible()
    await expect(suggestion).toHaveCount(0)
    await page.getByRole('button', { name: 'PDF selection', exact: true }).click()
    const pdfActionLabel = action === 'explain' ? 'selectionExplain' : 'selectionTranslate'
    await expect(page.getByRole('button', { name: pdfActionLabel, exact: true })).toBeVisible()
    for (const state of ['Disable backend toolbar', 'Load backend preferences']) {
      await page.getByRole('button', { name: state, exact: true }).click()
      await expect(page.getByRole('button', { name: pdfActionLabel, exact: true })).toHaveCount(0)
      await page.getByRole('button', { name: 'Explicit comment', exact: true }).click()
      await expect(page.locator('[aria-label="selection.label"]')).toContainText('Explicit comment')
      await expect(page.getByRole('button', { name: pdfActionLabel, exact: true })).toHaveCount(0)
      await page.getByRole('button', { name: 'Enable toolbar', exact: true }).click()
      await expect(page.locator('[aria-label="selection.label"]')).toHaveCount(0)
    }
    await page.getByRole('button', { name: 'Enable backend toolbar', exact: true }).click()
    await expect(page.getByRole('button', { name: pdfActionLabel, exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Hidden PDF reader', exact: true }).click()
    await expect(page.getByRole('button', { name: pdfActionLabel, exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: 'Explicit comment', exact: true }).click()
    await expect(page.locator('[aria-label="selection.label"]')).toHaveCount(0)
    await page.getByRole('button', { name: 'PDF selection', exact: true }).click()
    await expect(page.locator('[aria-label="selection.label"]')).toContainText('Explicit comment')
    await page.getByRole('button', { name: 'Enable toolbar', exact: true }).click()
    await page.getByRole('button', { name: pdfActionLabel, exact: true }).click()
    await suggestion.getByRole('button', { name: 'Generate', exact: true }).click()
    await suggestion.getByRole('button', { name: 'Pin', exact: true }).click()
    const pdfInstance = await suggestion.getAttribute('data-instance')
    await page.getByRole('button', { name: 'Hidden PDF reader', exact: true }).click()
    await expect(suggestion).toHaveAttribute('data-instance', pdfInstance!)
    await expect(suggestion).toHaveAttribute('data-attached', 'false')
    await expect(suggestion.locator('output')).toHaveText('retained output')
    await page.getByRole('button', { name: 'PDF selection', exact: true }).click()
    await expect(suggestion).toHaveAttribute('data-instance', pdfInstance!)
    await suggestion.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(page.getByRole('button', { name: pdfActionLabel, exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Artifact PDF selection', exact: true }).click()
    const addArtifact = page.getByRole('button', { name: 'selectionAddConversation', exact: true })
    await expect(addArtifact).toBeVisible()
    await page.getByRole('button', { name: 'Disable backend toolbar', exact: true }).click()
    await expect(addArtifact).toHaveCount(0)
    await page.getByRole('button', { name: 'Enable backend toolbar', exact: true }).click()
    await expect(addArtifact).toBeVisible()
    await page.getByRole('button', { name: 'Denied artifact selection', exact: true }).click()
    await expect(addArtifact).toHaveCount(0)
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

test('PDF selection surfaces constrain scrolling, movement and resizing to their reader boundary', async () => {
  const server = await servers.create({
    configFile: false,
    root: ROOT_DIR,
    plugins: [probePlugin({ realUi: true }), react()],
    cacheKey: 'selection-boundary',
    server: { host: '127.0.0.1', port: 0 },
  })
  let browser: Browser | undefined
  try {
    await server.listen()
    browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
    const stylesheet = path.join(ROOT_DIR, 'styles.css')
    const compiled = await postcss([tailwindcss({ base: path.dirname(ROOT_DIR) })]).process(
      readFileSync(stylesheet, 'utf8'),
      { from: stylesheet }
    )
    await page.goto(new URL(PROBE_PATH, server.resolvedUrls!.local[0]).href)
    await page.addStyleTag({ content: compiled.css })
    await page.getByRole('button', { name: 'PDF selection', exact: true }).click()
    const surface = page.getByTestId('selection-action-host')
    const assertBoundary = async (
      boundary = { left: 620, top: 160, right: 1180, bottom: 760 }
    ): Promise<void> => {
      await expect
        .poll(async () => {
          const box = await surface.boundingBox()
          return Boolean(
            box &&
            box.x >= boundary.left &&
            box.y >= boundary.top &&
            box.x + box.width <= boundary.right &&
            box.y + box.height <= boundary.bottom
          )
        })
        .toBe(true)
    }
    await assertBoundary()
    await page.getByRole('button', { name: 'Expand PDF result', exact: true }).click()
    await assertBoundary()
    for (const name of ['Clipped PDF selection', 'Selection below reader']) {
      await page.getByRole('button', { name, exact: true }).click()
      await assertBoundary()
    }
    await page.getByRole('button', { name: 'Hidden PDF reader', exact: true }).click()
    await expect(surface).toHaveCount(0)
    await page.getByRole('button', { name: 'PDF selection', exact: true }).click()
    await assertBoundary()
    const toolbar = surface.getByRole('toolbar')
    for (const key of ['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown']) {
      await toolbar.focus()
      for (let count = 0; count < 50; count++) await page.keyboard.press(key)
      await assertBoundary()
    }
    for (const [edge, key] of [
      ['top', 'ArrowUp'],
      ['left', 'ArrowLeft'],
      ['right', 'ArrowRight'],
      ['bottom', 'ArrowDown'],
    ]) {
      await surface.locator(`[data-resize-edge="${edge}"]`).focus()
      for (let count = 0; count < 50; count++) await page.keyboard.press(key)
      await assertBoundary()
    }
    await expect(surface).toHaveAttribute('data-resized', 'true')
    await page.getByRole('button', { name: 'Narrow reader', exact: true }).click()
    await assertBoundary({ left: 900, top: 220, right: 1180, bottom: 620 })
    await expect(surface).toHaveCSS('width', '280px')
    const content = surface.locator(':scope > .overflow-auto')
    assert.ok(await content.evaluate((element) => element.scrollHeight > element.clientHeight))
    await content.evaluate((element) => {
      element.scrollTop = element.scrollHeight
    })
    await expect(content.getByText('Result line 79', { exact: true })).toBeInViewport()
    await page.locator('html').evaluate((root) => root.setAttribute('data-theme', 'dark'))
    await assertBoundary({ left: 900, top: 220, right: 1180, bottom: 620 })
  } finally {
    await browser?.close()
    await server.close()
  }
})
