import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { chromium, expect } from '@playwright/test'
import { build } from 'esbuild'
import postcss from 'postcss'
import tailwindcss from '@tailwindcss/postcss'

const DESKTOP = fileURLToPath(new URL('../../../../../', import.meta.url))

test('reader controller stays local and isolates late saves and project-scoped relations', async () => {
  const bundle = await build({
    stdin: {
      resolveDir: DESKTOP,
      loader: 'tsx',
      contents: `
        import React, { useState } from 'react'
        import { createRoot } from 'react-dom/client'
        import { LiteratureDetail } from './src/renderer/src/features/literature/LiteratureDetail'
        import { catalogue } from './src/renderer/src/features/literature/catalog'
        import { Sheet, ToastProvider } from './src/renderer/src/components/ui'
        window.project = 'project-A'
        window.calls = []
        window.accepted = []
        window.deferSave = true
        window.primary = null
        window.version = 1
        window.consumed = 0
        function App() {
          const [id, setId] = useState('A')
          const [headerHost, setHeaderHost] = useState(null)
          const [reader, setReader] = useState(true)
          const [intent, setIntent] = useState(null)
          const [, rerender] = useState(0)
          const changeAttachment = (availability, media_type) => {
            window.primary = { id: 'primary', availability, media_type, name: 'Primary file', kind: 'pdf', role: 'primary' }
            window.version += 1
            catalogue.reload()
          }
          return <ToastProvider>
            <div ref={setHeaderHost} />
            <button onClick={() => setId(id === 'A' ? 'B' : 'A')}>Switch item</button>
            <button onClick={() => { window.primary = null; setId(id === 'A' ? 'B' : 'A') }}>Switch without PDF</button>
            <button onClick={() => { window.project = 'project-B'; rerender(value => value + 1) }}>Switch project</button>
            <button onClick={() => setReader(false)}>List detail</button>
            <button onClick={() => changeAttachment('available', 'application/pdf')}>Set PDF</button>
            <button onClick={() => changeAttachment('missing', 'application/pdf')}>Lose PDF</button>
            <button onClick={() => changeAttachment('available', 'text/plain')}>Set non-PDF</button>
            <button onClick={() => setIntent({ action: 'reading', nonce: Date.now() })}>Request reading</button>
            <Sheet open modal={false}><LiteratureDetail headerActionsHost={headerHost} id={id} intent={intent} attachmentId={null} presentation={reader ? 'reader' : 'detail'} onClose={() => {}} onIntentConsumed={() => { window.consumed += 1; setIntent(null) }} onItemUpdated={item => window.accepted.push(item.id)} /></Sheet>
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
        name: 'information-controller-fixture',
        setup(builder) {
          builder.onResolve({ filter: /^react-i18next$/ }, () => ({
            path: 'i18n',
            namespace: 'fixture',
          }))
          builder.onResolve({ filter: /^\.\.\/\.\.\/components\/business\/Reading$/ }, () => ({
            path: 'reading',
            namespace: 'fixture',
          }))
          builder.onResolve({ filter: /^(\.\/api|\.\/tasks|\.\.\/\.\.\/store)$/ }, (args) =>
            args.importer.endsWith('/LiteratureDetail.tsx')
              ? { path: args.path, namespace: 'fixture' }
              : undefined
          )
          builder.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({
            loader: 'js',
            resolveDir: DESKTOP,
            contents:
              args.path === 'i18n'
                ? 'export const I18nextProvider = ({ children }) => children; export const useTranslation = () => ({ t: (key, values) => key === "detail.edit" ? "Edit " + values.label : key, i18n: { resolvedLanguage: "en" } })'
                : args.path === 'reading'
                  ? 'import React from "react"; export const Reading = () => React.createElement("div", { "data-testid": "reading-content" }, "Available PDF reading")'
                  : args.path.endsWith('store')
                    ? 'export const useApp = () => ({ state: { lang: "en", homeSelectedProjectId: window.project }, act: {} })'
                    : args.path.endsWith('tasks')
                      ? 'export const literatureTasks = { subscribe: () => () => {}, getSnapshot: () => 0, isRunning: () => false, run: (id, kind, request) => request(), attach: (id, kind) => { window.calls.push({ method: "attach", kind }); return null } }'
                      : `
              const item = id => ({ id, title: 'Title ' + id, version: window.version, abstract: '', bib_type: 'article', primary_attachment: window.primary, attachments: window.primary ? [window.primary] : [], notes: [], projects: [], project_collections: [], collections: [], tags: [] })
              export class LiteratureApiError extends Error {}
              export async function getLiterature(id, projectId) { window.calls.push({ method: 'get', id, projectId }); return item(id) }
              export async function getLiteratureFacets(query) { return { collections: [{ id: 'collection', name: 'Collection', count: 1 }], tags: [] } }
              export async function getLiteratureProjects() { return { projects: [] } }
              export async function updateLiterature(id, update, projectId) {
                window.calls.push({ method: 'save', id, update, projectId })
                if (window.deferSave) await new Promise(resolve => window.finishSave = resolve)
                return { ...item(id), ...update.fields, version: ++window.version }
              }
              const forbidden = () => { throw new Error('Unexpected external or attachment request') }
              export const fetchPaperMeta = async query => { window.calls.push({ method: 'metadata', query }); return { success: true, fields: { title: 'Matched title' } } }
              export const fetchArxivFulltext = forbidden
              export const uploadLiteratureAttachment = forbidden
              export const deleteLiteratureAttachment = forbidden
              export const createLiteratureTag = forbidden
            `,
          }))
        },
      },
    ],
  })
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
  try {
    const page = await browser.newPage()
    await page.setContent('<div id="root"></div>')
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    const title = page.getByRole('button', { name: 'Edit columns.title', exact: true })
    await expect(title).toHaveText('Title A')
    await expect(page.locator('[data-testid="literature-fulltext-row"]')).toHaveCount(0)
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await page.getByRole('button', { name: 'detail.sync.action', exact: true }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await expect(page.getByRole('dialog')).toContainText('Matched title')
    await page.getByRole('button', { name: 'cancel', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(title).toHaveText('Title A')
    await page.getByRole('button', { name: 'Switch project', exact: true }).click()
    await title.click()
    const editor = page.getByRole('textbox', { name: 'Edit columns.title', exact: true })
    await editor.fill('Late A')
    await editor.press('Enter')
    await expect(editor).toBeDisabled()
    await page.getByRole('button', { name: 'Switch item', exact: true }).click()
    await expect(title).toHaveText('Title B')
    await page.evaluate('window.finishSave(); window.deferSave = false')
    await expect(title).toHaveText('Title B')
    const readerState = (await page.evaluate(
      '({ calls: window.calls, accepted: window.accepted })'
    )) as {
      calls: Array<{ method: string; id?: string; projectId?: string; kind?: string }>
      accepted: string[]
    }
    assert.deepEqual(readerState.accepted, [])
    assert.ok(
      readerState.calls
        .filter((call) => call.method === 'attach')
        .every((call) => call.kind === 'metadata')
    )
    assert.deepEqual(
      readerState.calls.filter((call) => call.method === 'get').map((call) => call.projectId),
      [undefined, undefined]
    )
    assert.equal(readerState.calls.find((call) => call.method === 'save')?.id, 'A')
    assert.equal(readerState.calls.find((call) => call.method === 'save')?.projectId, undefined)
    await page.getByRole('button', { name: 'List detail', exact: true }).click()
    await expect(title).toHaveText('Title B')
    await page.getByRole('button', { name: 'information.organization', exact: true }).click()
    await page.getByRole('button', { name: 'detail.chooseCollection', exact: true }).click()
    await page.getByRole('checkbox', { name: 'Collection', exact: true }).check()
    await page.getByRole('button', { name: 'relations.save', exact: true }).click()
    const scopedSave = await page.evaluate<{ projectId: string; update: Record<string, string[]> }>(
      'window.calls.filter(call => call.method === "save").at(-1)'
    )
    assert.equal(scopedSave.projectId, 'project-B')
    assert.deepEqual(scopedSave.update, { project_collection_ids: ['collection'] })
    const readingTab = page.getByRole('tab', { name: 'reading.title', exact: true })
    const infoTab = page.getByRole('tab', { name: 'detail.tabs.info', exact: true })
    await expect(readingTab).toBeDisabled()
    await expect(readingTab).toHaveAttribute('aria-disabled', 'true')
    await infoTab.focus()
    await infoTab.press('ArrowLeft')
    await expect(page.getByRole('tab', { name: /detail.tabs.notes/ })).toBeFocused()
    await infoTab.click()
    await page.getByRole('button', { name: 'Request reading', exact: true }).click()
    await expect(infoTab).toHaveAttribute('aria-selected', 'true')
    await expect.poll(() => page.evaluate('window.consumed')).toBe(1)
    await page.getByRole('button', { name: 'Set PDF', exact: true }).click()
    await expect(readingTab).toBeEnabled()
    await expect(infoTab).toHaveAttribute('aria-selected', 'true')
    await page.getByRole('tab', { name: /detail.tabs.attachments/ }).click()
    await expect(readingTab).toBeEnabled()
    await expect(page.getByTestId('literature-detail-reading')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'reading.title', exact: true })).toHaveCount(0)
    await readingTab.click()
    await expect(page.getByTestId('reading-content')).toBeVisible()
    await page.getByRole('button', { name: 'Lose PDF', exact: true }).click()
    await expect(readingTab).toBeDisabled()
    await expect(infoTab).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByTestId('reading-content')).toHaveCount(0)
    await page.getByRole('button', { name: 'Set non-PDF', exact: true }).click()
    await expect(readingTab).toBeDisabled()
    await page.getByRole('button', { name: 'Set PDF', exact: true }).click()
    await expect(readingTab).toBeEnabled()
    await expect(infoTab).toHaveAttribute('aria-selected', 'true')
    await page.getByRole('button', { name: 'Request reading', exact: true }).click()
    await expect(page.getByTestId('reading-content')).toBeVisible()
    await expect.poll(() => page.evaluate('window.consumed')).toBe(2)
    await page.getByRole('button', { name: 'Switch without PDF', exact: true }).click()
    await expect(readingTab).toBeDisabled()
    await expect(infoTab).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByTestId('reading-content')).toHaveCount(0)
  } finally {
    await browser.close()
  }
})

test('information shares grouped fields, retains failed edits, and isolates document switches', async () => {
  const bundle = await build({
    stdin: {
      resolveDir: DESKTOP,
      loader: 'tsx',
      contents: `
        import React, { useState } from 'react'
        import { createRoot } from 'react-dom/client'
        import { Information } from './src/renderer/src/features/literature/Information'
        window.calls = []
        window.fail = true
        const initial = id => ({ id, title: 'Title ' + id, abstract: 'Abstract ' + id, projects: [], project_collections: [], collections: [], tags: [], bib_type: 'article' })
        function App() {
          const [item, setItem] = useState(initial('A'))
          const [projectId, setProjectId] = useState(undefined)
          return <>
            <button onClick={() => setItem(initial(item.id === 'A' ? 'B' : 'A'))}>Switch</button>
            <button onClick={() => { window.fail = false }}>Recover</button>
            <button onClick={() => setProjectId('project-A')}>Project</button>
            <Information key={item.id + projectId} item={item} projectId={projectId} tags={[]} onRelation={kind => window.relation = kind} onCreateTag={async () => {}} onSave={async update => {
              window.calls.push({ id: item.id, update, projectId })
              if (window.fail) return false
              setItem(current => ({ ...current, ...update.fields }))
              return true
            }} />
          </>
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
        name: 'information-translations',
        setup(builder) {
          builder.onResolve({ filter: /^react-i18next$/ }, () => ({
            path: 'i18n',
            namespace: 'fixture',
          }))
          builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
            contents:
              'export const useTranslation = () => ({ t: (key, values) => key === "detail.edit" ? "Edit " + values.label : key })',
            loader: 'js',
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
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
  try {
    const page = await browser.newPage()
    await page.setContent('<div id="root"></div>')
    await page.addStyleTag({ content: compiled.css })
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    const title = page.getByRole('button', { name: 'Edit columns.title', exact: true })
    await expect(title.locator('strong')).toHaveCSS('font-weight', '500')
    const titleLabel = page
      .getByTestId('literature-information')
      .getByText('columns.title', { exact: true })
    await expect(titleLabel).toHaveCSS('position', 'absolute')
    const abstractLabel = page
      .getByTestId('literature-information')
      .getByText('columns.abstract', { exact: true })
    await expect(abstractLabel).toHaveCSS('position', 'absolute')
    const abstractTrigger = page.getByRole('button', { name: 'information.abstract', exact: true })
    await expect(abstractTrigger).toHaveCSS('border-top-width', '0px')
    await expect(abstractTrigger).toHaveCSS('border-radius', '0px')
    await abstractTrigger.hover()
    await expect(abstractTrigger).toHaveCSS('background-color', 'rgba(103, 73, 15, 0.04)')
    await expect(abstractTrigger).toHaveCSS('padding-left', '0px')
    const abstractContent = page.locator('.vds-collapsible__content').first()
    await expect(abstractContent).toHaveCSS('border-top-width', '0px')
    await expect(abstractContent).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    const authorLabel = page.getByText('columns.creator', { exact: true })
    await expect(authorLabel).toHaveCSS('white-space', 'nowrap')
    const authorWidth = await authorLabel.evaluate(
      (element) => element.getBoundingClientRect().width
    )
    const yearLabel = page.getByText('columns.year', { exact: true })
    assert.equal(
      await yearLabel.evaluate((element) => element.getBoundingClientRect().width),
      authorWidth
    )
    await expect(authorLabel).toHaveCSS('font-size', '12px')
    await expect(title.locator('strong')).toHaveCSS('font-size', '16px')
    const abstractEditor = page.getByRole('button', { name: 'Edit columns.abstract', exact: true })
    await expect(abstractEditor.locator('strong')).toHaveCSS('font-size', '12px')
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 840 })
      for (const valueButton of [
        title,
        abstractEditor,
        page.getByRole('button', { name: 'Edit columns.creator', exact: true }),
      ]) {
        await expect(valueButton).toHaveCSS('justify-content', 'space-between')
        const isTitle = (await valueButton.getAttribute('aria-label')) === 'Edit columns.title'
        await expect(valueButton).toHaveCSS('align-items', isTitle ? 'center' : 'flex-start')
        await expect(valueButton).toHaveCSS('text-align', 'left')
        const valueBounds = await valueButton.evaluate((element) => ({
          left: element.getBoundingClientRect().left,
          textLeft: element.querySelector('strong')!.getBoundingClientRect().left,
        }))
        assert.ok(Math.abs(valueBounds.textLeft - valueBounds.left - (isTitle ? 0 : 6)) <= 1)
      }
      for (const group of ['abstract', 'identifiers', 'publication', 'organization']) {
        const groupButton = page.getByRole('button', {
          name: 'information.' + group,
          exact: true,
        })
        await expect(groupButton).toHaveCSS('justify-content', 'space-between')
        const groupBounds = await groupButton.evaluate((element) => {
          const style = getComputedStyle(element)
          const range = document.createRange()
          range.selectNodeContents(element.querySelector('span')!)
          return {
            left: element.getBoundingClientRect().left + parseFloat(style.paddingLeft),
            textLeft: range.getBoundingClientRect().left,
            right: element.getBoundingClientRect().right - parseFloat(style.paddingRight),
            chevronRight: element.querySelector('svg')!.getBoundingClientRect().right,
          }
        })
        assert.ok(Math.abs(groupBounds.textLeft - groupBounds.left) <= 1)
        assert.ok(Math.abs(groupBounds.chevronRight - groupBounds.right) <= 1)
      }
      assert.equal(
        await page
          .getByTestId('literature-information')
          .evaluate((element) => element.scrollWidth <= element.clientWidth),
        true
      )
    }
    await page.getByRole('button', { name: 'Edit columns.creator', exact: true }).click()
    const creatorInput = page.getByRole('textbox', { name: 'Edit columns.creator', exact: true })
    const centers = await creatorInput.evaluate((input) => {
      const label = input
        .closest('.vds-field')!
        .parentElement!.parentElement!.querySelector('span')!
      const labelBounds = label.getBoundingClientRect()
      const inputBounds = input.getBoundingClientRect()
      return {
        label: labelBounds.top + labelBounds.height / 2,
        input: inputBounds.top + inputBounds.height / 2,
      }
    })
    assert.ok(Math.abs(centers.label - centers.input) <= 1)
    await creatorInput.press('Escape')
    await abstractEditor.click()
    const abstractInput = page.getByRole('textbox', { name: 'Edit columns.abstract', exact: true })
    await expect(abstractInput).toHaveValue('Abstract A')
    await abstractInput.fill('Unsaved abstract')
    await abstractInput.press('Escape')
    await expect(abstractEditor).toHaveText('Abstract A')
    await expect(
      page.getByRole('button', { name: 'information.abstract', exact: true })
    ).toHaveAttribute('aria-expanded', 'true')
    for (const group of ['identifiers', 'publication', 'organization']) {
      await expect(
        page.getByRole('button', { name: 'information.' + group, exact: true })
      ).toHaveAttribute('aria-expanded', 'false')
    }
    await page.getByRole('button', { name: 'Edit columns.title', exact: true }).click()
    const editor = page.getByRole('textbox', { name: 'Edit columns.title', exact: true })
    await editor.fill('Retained draft')
    await editor.press('Enter')
    await expect(editor).toHaveValue('Retained draft')
    await expect(page.getByRole('button', { name: 'detail.retry', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Recover', exact: true }).click()
    await page.getByRole('button', { name: 'detail.retry', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Edit columns.title', exact: true })).toHaveText(
      'Retained draft'
    )
    await page.getByRole('button', { name: 'Switch', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Edit columns.title', exact: true })).toHaveText(
      'Title B'
    )
    await page.getByRole('button', { name: 'Edit columns.title', exact: true }).click()
    await editor.fill('Cancelled')
    await editor.press('Escape')
    await expect(page.getByRole('button', { name: 'Edit columns.title', exact: true })).toHaveText(
      'Title B'
    )
    await page.getByRole('button', { name: 'information.organization', exact: true }).press('Enter')
    await expect(page.getByRole('button', { name: 'relations.chooseProject' })).toBeVisible()
    await page.getByRole('button', { name: 'Project', exact: true }).click()
    await page.getByRole('button', { name: 'information.organization', exact: true }).click()
    await expect(page.getByRole('button', { name: 'relations.chooseProject' })).toHaveCount(0)
    assert.deepEqual(
      await page.evaluate(() =>
        (window as unknown as { calls: { id: string }[] }).calls.map((call) => call.id)
      ),
      ['A', 'A']
    )
    const longAbstract = 'Long abstract with English words and 中文内容. '.repeat(40) + 'END'
    await abstractEditor.click()
    await abstractInput.fill(longAbstract)
    await abstractInput.press('Tab')
    await expect(abstractEditor).toHaveText(longAbstract)
    for (const width of [320, 560]) {
      await page.setViewportSize({ width, height: 840 })
      const geometry = await abstractEditor.locator('strong').evaluate((text) => {
        const bounds = text.getBoundingClientRect()
        const section = text.closest('.vds-collapsible__content')!
        const container = section.getBoundingClientRect()
        return {
          right: bounds.right,
          containerRight: container.right,
          height: bounds.height,
          lineHeight: Number.parseFloat(getComputedStyle(text).lineHeight),
          overflowing: section.scrollWidth > section.clientWidth,
        }
      })
      assert.ok(geometry.right <= geometry.containerRight + 1)
      assert.ok(geometry.height > geometry.lineHeight * 2)
      assert.equal(geometry.overflowing, false)
    }
  } finally {
    await browser.close()
  }
})
