import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { chromium, expect } from '@playwright/test'
import { build } from 'esbuild'
import tailwindcss from '@tailwindcss/postcss'
import postcss from 'postcss'
import ts from 'typescript'

const DESKTOP = fileURLToPath(new URL('../../../../../', import.meta.url))
const LABELS = JSON.parse(
  readFileSync(join(DESKTOP, 'src/localization/locales/zh/literature.json'), 'utf8')
)
const ENGLISH = JSON.parse(
  readFileSync(join(DESKTOP, 'src/localization/locales/en/literature.json'), 'utf8')
)

test('reader notes offer creation from the menu and editor while keeping export scoped', async () => {
  const source = readFileSync(
    join(DESKTOP, 'src/renderer/src/features/workbench/PdfDocument.tsx'),
    'utf8'
  )
  const tree = ts.createSourceFile(
    'PdfDocument.tsx',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  )
  const attribute = (tag: string, name: string): string => {
    const expressions: string[] = []
    const visit = (node: ts.Node): void => {
      if (ts.isJsxOpeningElement(node) && node.tagName.getText(tree) === tag) {
        for (const property of node.attributes.properties) {
          if (
            ts.isJsxAttribute(property) &&
            property.name.getText(tree) === name &&
            property.initializer &&
            ts.isJsxExpression(property.initializer) &&
            property.initializer.expression
          )
            expressions.push(property.initializer.expression.getText(tree))
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(tree)
    assert.equal(expressions.length, 1)
    return expressions[0]
  }
  const bundle = await build({
    stdin: {
      resolveDir: DESKTOP,
      loader: 'tsx',
      contents: `
        import React, { useState, useRef } from 'react'
        import { createRoot } from 'react-dom/client'
        import { LiteratureNotesPanel } from './src/renderer/src/features/literature/ReaderNotes'
        import { LiteratureNotes } from './src/renderer/src/features/literature/Notes'
        import { GenerateNoteAction } from './src/renderer/src/features/literature/Generate'
        import { generateNote } from './src/renderer/src/features/literature/generation'
        import { Toaster, ToastProvider, ResizablePanelGroup, ResizablePanel, ResizableHandle } from './src/renderer/src/components/ui'
        import { PdfPanel } from './src/renderer/src/features/workbench/pdf/Panel'
        window.exports = []
        window.language = 'zh'
        window.scholarseed = { saveFileCopy: async value => { window.exports.push(value); return { ok: true } } }
        window.notes = Array.from({ length: 12 }, (_, index) => ({ id: 'note-' + index, title: 'Note ' + index, text: 'Saved body ' + index, version: 1, position: index, created_at: index, updated_at: index }))
        function App() {
          const [itemId, setItemId] = useState('empty')
          const [visible, setVisible] = useState(true)
          const [headerHost, setHeaderHost] = useState(null)
          const [hasMarks, setHasMarks] = useState(true)
          const [language, setLanguage] = useState('zh')
          const [selectionDismissals, setSelectionDismissals] = useState(0)
          const [readingSplit, setReadingSplit] = useState([64, 36])
          const [expandedPanel, setExpandedPanel] = useState(null)
          const readingResized = useRef(false)
          const activeDocumentPanel = { id: 'notes', headerActions: 'content', resizable: true }
          const readingPanelOpen = visible
          const readingPanelExpanded = expandedPanel === activeDocumentPanel.id
          const preserveReadingPosition = () => {}
          const analysis = { panel: null, panelExpanded: false }
          const context = { recordTarget: { owner: 'literature_attachment', scope_id: itemId } }
          const snapshot = hasMarks ? { source_state: 'available', source_revision: 'source:1', record_revision: 'record:1', records: { marks: [{ id: 'mark', page: 1, style: 'highlight', text: 'Selected evidence', anchor_state: 'anchored' }], comments: [] } } : null
          return <ToastProvider>
            <Toaster />
            <button onClick={() => setItemId(itemId === 'empty' ? 'populated' : 'empty')}>Switch document</button>
            <button onClick={() => setVisible(!visible)}>Toggle reader</button>
            <button onClick={() => setHasMarks(!hasMarks)}>Toggle marks</button>
            <button onClick={() => void generateNote(itemId, { mark_ids: ['mark'] }, async () => true)}>Start pending generation</button>
            <button onClick={() => window.failGeneration()}>Simulate generation failure</button>
            <button onClick={() => window.previewGeneration()}>Stream note preview</button>
            <button onClick={() => { window.language = language === 'zh' ? 'en' : 'zh'; setLanguage(window.language) }}>Toggle language</button>
            <output data-testid="selection-dismissals">{selectionDismissals}</output>
            <GenerateNoteAction context={context} snapshot={snapshot} disabled={false} openPanel={() => setVisible(true)} dismissSelection={() => setSelectionDismissals(count => count + 1)} />
            <div id="reader" style={{ width: 1000, height: 600 }}>
              <ResizablePanelGroup sizes={${attribute('ResizablePanelGroup', 'sizes')}} onSizesChange={${attribute('ResizablePanelGroup', 'onSizesChange')}} className="h-full">
                <ResizablePanel minSize={readingPanelExpanded ? 0 : 20} maxSize={100}><div>PDF source</div></ResizablePanel>
                <ResizableHandle aria-label="Resize notes" className={readingPanelExpanded ? 'hidden' : ''} />
                <ResizablePanel minSize={readingPanelExpanded ? 0 : 20} maxSize={100} className="min-w-0 !p-0">
              {visible && <PdfPanel inline ariaLabel="Reader" title="Notes" closeLabel="Close" expanded={readingPanelExpanded} icon={null} testId="reader-panel" onClose={() => setVisible(false)} headerActionsRef={setHeaderHost} onToggleExpanded={${attribute('PdfPanel', 'onToggleExpanded')}} bodyClassName="min-h-0 flex-1 overflow-hidden">
                <LiteratureNotesPanel context={context} presentation={{ headerActionsHost: headerHost, annotationAction: onDirectWrite => <GenerateNoteAction context={context} snapshot={snapshot} disabled={false} openPanel={() => setVisible(true)} placement="panel" onDirectWrite={onDirectWrite} /> }} />
              </PdfPanel>}
                </ResizablePanel>
              </ResizablePanelGroup>
            </div>
            <section aria-label="Detail" style={{ width: 360, height: 300 }}><LiteratureNotes itemId="detail" notes={[]} onReload={async () => {}} /></section>
          </ToastProvider>
        }
        createRoot(document.getElementById('root')).render(<App />)
      `,
    },
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    jsx: 'automatic',
    define: { 'import.meta.env.DEV': 'false' },
    loader: { '.css': 'empty', '.png': 'dataurl', '.svg': 'dataurl', '.webp': 'dataurl' },
    plugins: [
      {
        name: 'reader-note-fixture',
        setup(builder) {
          builder.onResolve({ filter: /^\.\.\/\.\.\/store$/ }, (args) =>
            /\/literature\/(NoteSources|Generate)\.tsx$/.test(args.importer)
              ? { path: 'store', namespace: 'fixture' }
              : undefined
          )
          builder.onResolve({ filter: /^\.\.\/\.\.\/components\/business\/ModelMenu$/ }, () => ({
            path: 'model',
            namespace: 'fixture',
          }))
          builder.onResolve({ filter: /^\.\/api$/ }, (args) =>
            /\/literature\/(autosave.ts|generation.ts|ReaderNotes.tsx)$/.test(args.importer)
              ? { path: 'api', namespace: 'fixture' }
              : undefined
          )
          builder.onResolve({ filter: /^react-i18next$/ }, () => ({
            path: 'i18n',
            namespace: 'fixture',
          }))
          builder.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({
            loader: 'js',
            contents:
              args.path === 'store'
                ? 'export const useApp = () => ({ act: {}, state: { catalog: { models: [] }, model: "", activeSession: null, threads: {} } })'
                : args.path === 'model'
                  ? 'export const ModelMenu = () => null'
                  : args.path === 'i18n'
                    ? `const translations = { zh: ${JSON.stringify(LABELS)}, en: ${JSON.stringify(ENGLISH)} }; export const useTranslation = () => ({ t: (key, values = {}) => { const lookup = path => path.split('.').reduce((node, part) => node?.[part], translations[window.language]); const value = lookup(key) ?? (typeof values.count === 'number' ? lookup(key + '_' + new Intl.PluralRules(window.language).select(values.count)) : undefined); return typeof value === 'string' ? value.replace(/{{(.*?)}}/g, (_, name) => values[name] ?? '') : key } })`
                    : `
                export class LiteratureApiError extends Error {}
                export class NoteGenerationFailure extends Error {
                  invocationId = 'failed-invocation'
                  detail = 'Long diagnostic text. '.repeat(500)
                }
                export async function generateLiteratureNote(_item, _request, onPreview) {
                  return new Promise((_, reject) => {
                    window.failGeneration = () => reject(new NoteGenerationFailure('insight_result_invalid'))
                    window.previewGeneration = () => onPreview({ preview_id: 'writer', revision: 1, status: 'streaming', verified: false, blocks: [{ id: '/markdown', kind: 'paragraph', text: '## Live note\\n\\nFirst streamed paragraph.' }] })
                  })
                }
                export async function listLiteratureNotes(itemId) { return itemId === 'populated' ? window.notes : [] }
                export async function updateLiteratureNote(itemId, id, draft) {
                  window.savedNote = { ...window.savedNote, ...window.notes.find(note => note.id === id), ...draft, version: draft.version + 1 }
                  return window.savedNote
                }
                export async function addLiteratureNote(itemId, text, title) {
                  window.savedNote = { id: 'created', text, title, version: 1, position: 0, created_at: 1, updated_at: 1 }
                  return window.savedNote
                }
                export async function deleteLiteratureNote() { throw new Error('Unexpected deletion') }
              `,
          }))
        },
      },
    ],
  })
  const stylesheet = join(DESKTOP, 'src/renderer/src/styles.css')
  const compiled = await postcss([tailwindcss({ base: join(DESKTOP, 'src/renderer') })]).process(
    readFileSync(stylesheet, 'utf8'),
    { from: stylesheet }
  )
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined })
  try {
    const page = await browser.newPage()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.setContent('<div id="root"></div>')
    await page.addStyleTag({ content: compiled.css })
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    const reader = page.getByRole('complementary', { name: 'Reader' })
    const headerExport = reader.locator('header').getByTestId('reader-notes-export')
    await expect(headerExport).toBeVisible()
    await expect(headerExport).toBeDisabled()
    await expect(reader.getByTestId('reader-panel-toggle-size')).toBeVisible()
    await expect(reader.getByText(LABELS.notes.emptyTitle, { exact: true })).toBeVisible()
    await expect(reader.locator('.vds-empty-state__title')).toHaveCSS('font-weight', '500')
    await expect(reader.locator('.vds-empty-state__icon svg')).toHaveCount(1)
    await expect(reader.locator('.vds-empty-state__action').getByRole('button')).toHaveCount(1)
    await expect(
      reader.getByText(LABELS.readerNotes.emptyDescription, { exact: true })
    ).toBeVisible()
    await expect(reader.getByRole('button', { name: LABELS.relations.addNote })).toHaveCount(0)
    const addNote = reader.getByRole('button', { name: LABELS.list.rowMenu.addNote })
    const directWrite = page.getByRole('menuitem', { name: LABELS.readerNotes.directWrite })
    const generateFromMenu = page.getByRole('menuitem', { name: LABELS.generation.action })
    const generate = reader.getByTestId('reader-generate-note')
    assert.match((await addNote.getAttribute('class')) ?? '', /vds-button--primary/)
    await addNote.click()
    await generateFromMenu.click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByText('Selected evidence')).toBeVisible()
    await expect(dialog.getByRole('button', { name: LABELS.generation.submit })).toBeDisabled()
    await dialog.getByRole('button', { name: LABELS.notes.cancel, exact: true }).click()
    await expect(addNote).toBeFocused()
    await page.getByTestId('annotations-generate-note').click()
    await expect(page.getByRole('dialog')).toHaveCount(1)
    await expect(page.getByTestId('selection-dismissals')).toHaveText('1')
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('annotations-generate-note')).toBeFocused()
    await page.getByRole('button', { name: 'Toggle marks' }).click()
    await addNote.click()
    await expect(generateFromMenu).toBeDisabled()
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Toggle marks' }).click()
    await addNote.click()
    await directWrite.click()
    await expect(generate).toBeEnabled()
    assert.match((await generate.getAttribute('class')) ?? '', /vds-button--secondary/)
    const save = reader.getByRole('button', { name: LABELS.notes.save, exact: true })
    const tabs = reader.getByRole('tablist')
    const [generateBounds, saveBounds, tabsBounds] = await Promise.all([
      generate.boundingBox(),
      save.boundingBox(),
      tabs.boundingBox(),
    ])
    assert.ok(generateBounds && saveBounds && tabsBounds)
    assert.ok(Math.abs(generateBounds.width - saveBounds.width) <= 1)
    assert.equal(generateBounds.y, saveBounds.y)
    assert.ok(generateBounds.y > tabsBounds.y)
    await generate.click()
    await expect(dialog.getByText('Selected evidence')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(headerExport).toBeEnabled()
    await expect(reader.getByTestId('reader-notes-footer')).toHaveCount(0)
    await expect(save).toBeDisabled()
    await reader.getByRole('button', { name: LABELS.readerNotes.back, exact: true }).click()
    await expect(save).toHaveCount(0)
    assert.equal(
      await page.evaluate(() => (window as unknown as { savedNote?: unknown }).savedNote ?? null),
      null
    )
    await addNote.click()
    await directWrite.click()
    await expect(save).toBeDisabled()
    const title = reader.getByRole('textbox', { name: LABELS.notes.title, exact: true })
    await title.fill('Title-only note')
    const titleNode = await title.elementHandle()
    const initialBounds = await reader.boundingBox()
    const handle = page.getByRole('separator', { name: 'Resize notes' })
    const handleBounds = await handle.boundingBox()
    assert.ok(initialBounds && handleBounds && titleNode)
    await page.mouse.move(
      handleBounds.x + handleBounds.width / 2,
      handleBounds.y + handleBounds.height / 2
    )
    await page.mouse.down()
    await page.mouse.move(handleBounds.x - 100, handleBounds.y + handleBounds.height / 2, {
      steps: 10,
    })
    await page.mouse.up()
    const resizedBounds = await reader.boundingBox()
    assert.ok(resizedBounds && resizedBounds.width > initialBounds.width + 90)
    await handle.focus()
    await page.keyboard.press('ArrowLeft')
    const restoredWidth = (await reader.boundingBox())!.width
    await reader.getByTestId('reader-panel-toggle-size').click()
    await expect(handle).toBeHidden()
    assert.ok((await reader.boundingBox())!.width > restoredWidth + 200)
    await expect(title).toHaveValue('Title-only note')
    assert.equal(await titleNode.evaluate((node) => node.isConnected), true)
    await reader.getByTestId('reader-panel-toggle-size').click()
    await expect(handle).toBeVisible()
    assert.ok(Math.abs((await reader.boundingBox())!.width - restoredWidth) < 1)
    await expect(title).toHaveValue('Title-only note')
    assert.equal(await titleNode.evaluate((node) => node.isConnected), true)
    await expect(save).toBeEnabled()
    await save.click()
    await expect(save).toBeDisabled()
    assert.deepEqual(
      await page.evaluate(() => {
        const saved = (window as unknown as { savedNote: { title: string; text: string } })
          .savedNote
        return { title: saved.title, text: saved.text }
      }),
      { title: 'Title-only note', text: '' }
    )
    await title.fill('')
    await expect(save).toBeEnabled()
    await save.click()
    await expect(save).toBeDisabled()
    assert.deepEqual(
      await page.evaluate(() => {
        const saved = (window as unknown as { savedNote: { title: string; text: string } })
          .savedNote
        return { title: saved.title, text: saved.text }
      }),
      { title: '', text: '' }
    )
    await reader.getByRole('button', { name: LABELS.readerNotes.back, exact: true }).click()
    await expect(headerExport).toBeDisabled()
    await page.getByRole('button', { name: 'Switch document' }).click()
    await expect(reader.getByRole('button', { name: 'Note 11 Saved body 11' })).toBeVisible()
    await expect(
      reader.getByRole('button', { name: 'Note 11 Saved body 11' }).locator('svg')
    ).toHaveCount(0)
    await page.getByRole('button', { name: 'Start pending generation' }).click()
    const pending = reader.getByTestId('note-generation-pending')
    await expect(pending).toBeVisible()
    await expect(pending).toContainText(LABELS.generation.pendingTitle)
    await expect(pending).toContainText(LABELS.generation.pending_other.replace('{{count}}', '1'))
    const pendingHeight = await pending.evaluate(
      (element) => element.getBoundingClientRect().height
    )
    const savedHeight = await reader
      .getByRole('button', { name: 'Note 11 Saved body 11' })
      .evaluate((element) => element.parentElement!.getBoundingClientRect().height)
    assert.equal(pendingHeight, savedHeight)
    await addNote.click()
    await generateFromMenu.click()
    await expect(page.getByText(LABELS.generation.inProgress)).toBeVisible()
    await expect(dialog).toHaveCount(0)
    await addNote.click()
    await directWrite.click()
    await expect(reader.getByRole('textbox', { name: LABELS.notes.bodyPlaceholder })).toBeVisible()
    await reader.getByRole('button', { name: LABELS.readerNotes.back, exact: true }).click()
    await reader.getByRole('button', { name: 'Note 11 Saved body 11' }).click()
    await expect(headerExport).toBeEnabled()
    await generate.click()
    await expect(dialog).toHaveCount(0)
    await reader.getByRole('button', { name: LABELS.readerNotes.back, exact: true }).click()
    await page.getByRole('button', { name: 'Stream note preview' }).click()
    const preview = reader.getByTestId('note-generation-preview')
    await expect(preview.getByRole('heading', { name: 'Live note' })).toBeVisible()
    await expect(preview).toContainText('First streamed paragraph.')
    await expect(preview).toContainText(LABELS.generation.preview)
    await page.getByRole('button', { name: 'Toggle reader' }).click()
    await page.getByRole('button', { name: 'Toggle reader' }).click()
    await expect(preview).toContainText('First streamed paragraph.')
    await page.getByRole('button', { name: 'Simulate generation failure' }).click()
    await expect(reader.getByTestId('note-generation-pending')).toHaveCount(0)
    const failure = reader.getByRole('alert').filter({ hasText: LABELS.generation.failed })
    await expect(failure).toBeVisible()
    await expect(preview).toContainText('First streamed paragraph.')
    await expect(preview).toContainText(LABELS.generation.previewFailed)
    await expect(failure).not.toContainText('Long diagnostic text')
    await failure.getByRole('button', { name: LABELS.generation.diagnostics }).click()
    await expect(dialog).toContainText('Long diagnostic text')
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(addNote).toBeInViewport()
    await expect(reader.getByRole('button', { name: 'Note 11 Saved body 11' })).toBeInViewport()
    await expect(headerExport).toBeDisabled()
    const originalBounds = await addNote.boundingBox()
    await reader.getByRole('button', { name: 'Note 0 Saved body 0' }).scrollIntoViewIfNeeded()
    assert.deepEqual(await addNote.boundingBox(), originalBounds)
    await reader.getByRole('button', { name: 'Note 0 Saved body 0' }).click()
    await expect(headerExport).toBeEnabled()
    await reader
      .getByRole('textbox', { name: LABELS.notes.bodyPlaceholder })
      .fill('Latest draft for export')
    await headerExport.click()
    const exported = await page.evaluate(() => {
      const records = (window as unknown as { exports: { bytes: Uint8Array }[] }).exports
      return new TextDecoder().decode(records[0].bytes)
    })
    assert.equal(exported, '# Note 0\n\nLatest draft for export')
    await page.getByRole('button', { name: 'Switch document' }).click()
    await expect(headerExport).toBeDisabled()
    await expect(reader.getByText(LABELS.notes.emptyTitle, { exact: true })).toBeVisible()
    for (const theme of ['light', 'dark']) {
      await page.evaluate((value) => {
        document.documentElement.dataset.theme = value
      }, theme)
      assert.equal(
        await reader.evaluate((element) => element.scrollWidth <= element.clientWidth),
        true
      )
      await expect(addNote).toBeVisible()
    }
    await page.getByRole('button', { name: 'Toggle language' }).click()
    await reader.getByRole('button', { name: ENGLISH.list.rowMenu.addNote }).click()
    await page.getByRole('menuitem', { name: ENGLISH.readerNotes.directWrite }).click()
    await expect(generate).toHaveText(ENGLISH.generation.action)
    const generationGeometry = await generate.evaluate((element) => ({
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
      whiteSpace: getComputedStyle(element).whiteSpace,
      height: getComputedStyle(element).height,
    }))
    assert.ok(
      generationGeometry.scrollWidth <= generationGeometry.clientWidth,
      JSON.stringify(generationGeometry)
    )
    await page.getByRole('button', { name: 'Toggle language' }).click()
    await page.getByRole('button', { name: 'Toggle reader' }).click()
    await expect(page.getByTestId('reader-notes-export')).toHaveCount(0)
    const detail = page.getByRole('region', { name: 'Detail' })
    await expect(detail.getByRole('button', { name: LABELS.relations.addNote })).toBeVisible()
    await expect(detail.getByText(LABELS.notes.emptyDescription)).toBeVisible()
    await expect(detail.getByTestId('reader-notes-footer')).toHaveCount(0)
    await page.getByRole('button', { name: 'Toggle reader' }).click()
    await page.getByRole('button', { name: 'Start pending generation' }).click()
    await page.getByRole('button', { name: 'Stream note preview' }).click()
    await page.getByRole('button', { name: 'Simulate generation failure' }).click()
    await expect(reader.getByTestId('note-generation-preview')).toBeVisible()
    await expect(addNote).toBeVisible()
    await addNote.click()
    await directWrite.click()
    await expect(reader.getByRole('textbox', { name: LABELS.notes.bodyPlaceholder })).toBeVisible()
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
