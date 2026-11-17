import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { chromium, expect } from '@playwright/test'
import { build } from 'esbuild'
import tailwindcss from '@tailwindcss/postcss'
import postcss from 'postcss'

const DESKTOP = fileURLToPath(new URL('../../../../../', import.meta.url))

interface SourceTestWindow {
  clearIndexWarnings: () => void
  showIndexed: () => void
  showUnverified: () => void
  showUnused: () => void
  exported: string
  navigations: unknown[][]
  unavailable: boolean
}

test('source picker inserts real candidate snapshots, stays flat and survives mode switches and unavailable resolution', async () => {
  const bundle = await build({
    stdin: {
      resolveDir: DESKTOP,
      loader: 'tsx',
      contents: `
      import React, { useState } from 'react'
      import { createRoot } from 'react-dom/client'
      import { NoteEditor } from './src/renderer/src/features/literature/NoteEditor'
      import { NoteSources } from './src/renderer/src/features/literature/NoteSources'
      window.unavailable = false
      window.navigations = []
      function App() {
        const [draft, setDraft] = useState({ title: 'Keep title', text: 'Before After' })
        const [provenance, setProvenance] = useState(null)
        window.showUnused = () => setProvenance({version:1,paragraphs:[],unreferenced_sources:Array.from({length:5},(_,i)=>({record_target:{owner:'literature_attachment',scope_id:'paper',subject_id:'attachment'},source_revision:'sha256:one',mark_id:'unused-'+i,comment_id:null,kind:'location',page:2,text:'',attachment_name:'paper.pdf'}))})
        window.showUnverified = () => {setProvenance({version:1,paragraphs:[],status:'unverified'});setDraft(current => ({...current,text:'Raw paragraph [[hint:reader_thought|A048]]'}))}
        window.showIndexed = () => {
          const source = {record_target:{owner:'literature_attachment',scope_id:'paper',subject_id:'attachment'},source_revision:'sha256:one',mark_id:'mark',comment_id:null,kind:'text',page:2,text:'Original snapshot',attachment_name:'paper.pdf'}
          const raw = 'Indexed body [[mixed:A001,B001,A999]]'
          setDraft(current => ({...current,text:raw}))
          setProvenance({version:1,status:'indexed',paragraphs:[{id:'p1',text:raw,display_text:'Indexed body [A999]',sources:[source],paper_sources:[{id:'B001',record_target:source.record_target,source_revision:source.source_revision,page:2,text:'Paper evidence',attachment_name:'paper.pdf'}]}],unreferenced_sources:[{...source,mark_id:'unused'}],unresolved_source_ids:['A999']})
          window.unavailable = false
        }
        window.clearIndexWarnings = () => setProvenance(current => ({...current,unresolved_source_ids:[],skipped_paragraphs:0}))
        window.draft = draft
        return <NoteSources itemId="paper" text={draft.text} provenance={provenance}>{sources => <NoteEditor draft={draft} status="saved" sources={sources} onTextChange={text => setDraft(current => ({...current, text}))} onTitleChange={title => setDraft(current => ({...current,title}))} onExport={() => { window.exported = draft.text }} />}</NoteSources>
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
    loader: { '.css': 'empty', '.webp': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl' },
    plugins: [
      {
        name: 'source-ports',
        setup(builder) {
          builder.onResolve({ filter: /^\.\.\/\.\.\/store$/ }, () => ({
            path: 'store',
            namespace: 'fixture',
          }))
          builder.onResolve({ filter: /^\.\/api$/ }, (args) =>
            args.importer.endsWith('/NoteSources.tsx')
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
                ? `export const useApp = () => ({act: {openLiteratureAttachment: async (...args) => { window.navigations.push(args); return true }}})`
                : args.path === 'i18n'
                  ? `export const useTranslation = () => ({t: (key, values) => key === 'noteSources.sourceLabel' ? 'Page ' + values.page + ' ' + values.kind : key})`
                  : `const source = {record_target:{owner:'literature_attachment',scope_id:'paper',subject_id:'attachment'},source_revision:'sha256:one',mark_id:'mark',comment_id:null,kind:'text',page:2,text:'Original snapshot',attachment_name:'paper.pdf'}
            const sources = [source, ...[1,2,3].map(id => ({...source,comment_id:'comment-'+id,kind:'user_comment',text:('Long annotation excerpt '+id+' ').repeat(18)}))]
            export const notePaperRevision = async () => ({source_revision:window.unavailable ? "changed" : "sha256:one"})
            export class LiteratureApiError extends Error {}
            export const getNoteSources = async () => ({items:sources,unavailable_attachment_ids:[],omitted_count:0})
            export const resolveNoteSources = async (_,group) => ({items:group.sources.map(source => ({source,state:window.unavailable?'unavailable':'available',current:window.unavailable?null:source}))})`,
          }))
        },
      },
    ],
  })
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' })
  try {
    const page = await browser.newPage()
    await page.setViewportSize({ width: 720, height: 520 })
    await page.setContent('<div id="root" style="width:360px;height:800px;display:flex"></div>')
    const stylesheet = join(DESKTOP, 'src/renderer/src/styles.css')
    const compiled = await postcss([tailwindcss({ base: join(DESKTOP, 'src/renderer') })]).process(
      readFileSync(stylesheet, 'utf8'),
      { from: stylesheet }
    )
    await page.addStyleTag({ content: compiled.css })
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    const body = page.getByRole('textbox', { name: 'notes.bodyPlaceholder' })
    await body.evaluate((element: HTMLTextAreaElement) => {
      element.focus()
      element.setSelectionRange(7, 7)
    })
    await page.getByRole('button', { name: 'noteSources.attach' }).click()
    const selectAll = page.getByRole('checkbox', { name: 'generation.all' })
    const choices = page.getByRole('checkbox', { name: /^Page/ })
    await expect(choices).toHaveCount(4)
    await expect(selectAll).toHaveAttribute('aria-checked', 'false')
    await choices.first().click()
    await expect(selectAll).toHaveAttribute('aria-checked', 'mixed')
    await selectAll.click()
    await expect(selectAll).toHaveAttribute('aria-checked', 'true')
    await expect(page.getByRole('checkbox', { name: /^Page/, checked: true })).toHaveCount(4)
    await selectAll.click()
    await expect(selectAll).toHaveAttribute('aria-checked', 'false')
    await expect(page.getByRole('button', { name: 'noteSources.insert' })).toBeDisabled()
    await selectAll.click()
    await page.getByRole('button', { name: 'noteSources.insert' }).click()
    const draft = await body.inputValue()
    assert.match(draft, /^Before \[noteSources.label\]\(#scholarseed-note-sources-/)
    assert.match(draft, /\)After$/)
    await expect(page.getByRole('textbox', { name: 'notes.title' })).toHaveValue('Keep title')
    const group = page.getByTestId('note-source-group')
    const current = group.getByTestId('note-source-current')
    const previous = group.getByRole('button', { name: 'noteSources.previous' })
    const next = group.getByRole('button', { name: 'noteSources.next' })
    await expect(current).toHaveCount(1)
    assert.equal(await current.evaluate((element) => element.tagName), 'SPAN')
    await expect(group.getByRole('button')).toHaveCount(2)
    await current.click()
    assert.equal(
      await page.evaluate(() => (window as unknown as SourceTestWindow).navigations.length),
      0
    )
    await expect(group.getByTestId('note-source-position')).toHaveText('1 / 4')
    await expect(previous).toBeDisabled()
    await next.click()
    await expect(group.getByTestId('note-source-position')).toHaveText('2 / 4')
    await expect(current).toHaveAttribute('title', /Long annotation excerpt 1/)
    await expect(current).toHaveCSS('font-size', '12px')
    await expect(current).toHaveCSS('font-weight', '400')
    await expect(group.getByTestId('note-source-position')).toHaveCSS('font-size', '16px')
    await expect(group.getByTestId('note-source-position')).toHaveCSS('font-weight', '600')
    await next.click()
    await next.click()
    await expect(group.getByTestId('note-source-position')).toHaveText('4 / 4')
    await expect(next).toBeDisabled()
    await previous.click()
    await expect(group.getByTestId('note-source-position')).toHaveText('3 / 4')
    await page.getByRole('tab', { name: 'notes.modePreview' }).click()
    const title = page.getByRole('textbox', { name: 'notes.title' })
    await expect(title).toHaveCSS('border-top-width', '0px')
    await expect(title).toHaveCSS('font-size', '24px')
    await title.fill('Preview remains editable')
    const boxes = await Promise.all(
      [current, previous, group.getByTestId('note-source-position'), next].map((node) =>
        node.boundingBox()
      )
    )
    for (let i = 1; i < boxes.length; i++) assert.ok(boxes[i]!.x > boxes[i - 1]!.x)
    for (const theme of ['light', 'dark']) {
      await page.evaluate((value) => {
        document.documentElement.dataset.theme = value
        document.getElementById('root')!.style.width = '300px'
      }, theme)
      assert.equal(
        await group.evaluate((element) => element.scrollWidth <= element.clientWidth),
        true,
        theme
      )
    }
    await expect(current).toHaveCount(1)
    await page.getByRole('tab', { name: 'notes.modeEdit' }).click()
    await expect(title).toHaveValue('Preview remains editable')
    await expect(body).toHaveValue(draft)
    await page.getByRole('button', { name: 'notes.export' }).click()
    assert.equal(await page.evaluate(() => (window as unknown as SourceTestWindow).exported), draft)
    assert.deepEqual(
      await page.evaluate(() => (window as unknown as SourceTestWindow).navigations[0]),
      [
        'paper',
        'attachment',
        2,
        { annotation: { revision: 'sha256:one', page: 2, markId: 'mark' } },
      ]
    )
    await page.evaluate(() => {
      ;(window as unknown as SourceTestWindow).unavailable = true
      window.dispatchEvent(new Event('focus'))
    })
    await expect(group.getByTestId('note-source-current')).toContainText('noteSources.unavailable')
    await expect(body).toHaveValue(draft)
    await page.evaluate(() => {
      ;(window as unknown as SourceTestWindow).unavailable = false
      ;(window as unknown as SourceTestWindow).showUnused()
    })
    await page.getByRole('tab', { name: 'notes.modePreview' }).click()
    const unused = page.getByTestId('note-unreferenced-sources')
    await expect(unused.getByTestId('note-source-current')).toHaveCount(1)
    await expect(unused.getByTestId('note-source-position')).toHaveText('1 / 5')
    await expect(unused.getByRole('button', { name: 'noteSources.next' })).toBeEnabled()
    assert.equal(
      await unused.evaluate((element) =>
        element.previousElementSibling?.textContent?.includes('Before')
      ),
      true
    )
    await unused.getByRole('button', { name: 'noteSources.next' }).click()
    await expect(unused.getByTestId('note-source-position')).toHaveText('2 / 5')
    assert.deepEqual(
      await page.evaluate(() => (window as unknown as SourceTestWindow).navigations.at(-1)?.[3]),
      { annotation: { revision: 'sha256:one', page: 2, markId: 'unused-1' } }
    )
    await page.evaluate(() => (window as unknown as SourceTestWindow).showUnverified())
    await expect(page.getByTestId('note-provenance-unverified')).toHaveText(
      'noteSources.unverified'
    )
    await expect(
      page.getByText('Raw paragraph [[hint:reader_thought|A048]]', { exact: true })
    ).toBeVisible()
    await expect(page.getByTestId('note-unreferenced-sources')).toHaveCount(0)
    await page.getByRole('button', { name: 'notes.export' }).click()
    assert.equal(
      await page.evaluate(() => (window as unknown as SourceTestWindow).exported),
      'Raw paragraph [[hint:reader_thought|A048]]'
    )
    await page.evaluate(() => (window as unknown as SourceTestWindow).showIndexed())
    await expect(page.getByTestId('note-provenance-indexed')).toBeVisible()
    await expect(page.getByText('noteSources.indexed', { exact: true })).toHaveCount(0)
    await page.evaluate(() => (window as unknown as SourceTestWindow).clearIndexWarnings())
    await expect(page.getByTestId('note-provenance-indexed')).toHaveCount(0)
    await expect(page.getByText('Indexed body [A999]', { exact: true })).toBeVisible()
    await expect(
      page.getByText('Indexed body [[mixed:A001,B001,A999]]', { exact: true })
    ).toHaveCount(0)
    await expect(page.getByTestId('note-unreferenced-sources')).toBeVisible()
    await expect(page.getByTestId('note-paper-sources')).toHaveCount(0)
    await expect(page.getByText('noteSources.paper', { exact: true })).toHaveCount(0)
    await page
      .getByTestId('note-source-group')
      .first()
      .getByRole('button', { name: 'noteSources.next' })
      .click()
    assert.equal(
      (
        (await page.evaluate(
          () => (window as unknown as SourceTestWindow).navigations.at(-1)?.[3]
        )) as { annotation: { markId: string } }
      ).annotation.markId,
      'mark'
    )
    await page.getByRole('button', { name: 'notes.export' }).click()
    assert.equal(
      await page.evaluate(() => (window as unknown as SourceTestWindow).exported),
      'Indexed body [[mixed:A001,B001,A999]]'
    )
  } finally {
    await browser.close()
  }
})
