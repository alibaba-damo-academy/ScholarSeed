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
const NOTE_LABELS = JSON.parse(
  readFileSync(join(DESKTOP, 'src/localization/locales/zh/literature.json'), 'utf8')
).notes

test('the real autosave hook shares edits and recovers a failed draft across component lifetimes', async () => {
  const bundle = await build({
    stdin: {
      resolveDir: DESKTOP,
      loader: 'tsx',
      contents: `
        import React, { useState } from 'react'
        import { createRoot } from 'react-dom/client'
        import { useNoteAutoSave } from './src/renderer/src/features/literature/autosave'
        import { LiteratureNotesPanel } from './src/renderer/src/features/literature/ReaderNotes'
        window.offline = true
        window.calls = []
        window.fixtureNotes = {}
        function Probe({ itemId, label }) {
          const note = window.fixtureNotes[itemId] ?? { id: itemId + '-note', title: itemId, text: 'Original ' + itemId, version: 1, position: 0, created_at: 1, updated_at: 1 }
          const editor = useNoteAutoSave({ itemId, notes: [note] })
          return <section aria-label={label}>
            <button onClick={() => editor.requestOpen(note)}>Open</button>
            <button onClick={() => editor.requestClose()}>Back</button>
            <button onClick={() => editor.flush()}>Save</button>
            {editor.draft && <input aria-label="Body" value={editor.draft.text} onChange={event => editor.setText(event.target.value)} />}
            <output>{editor.status + ':' + editor.error}</output>
          </section>
        }
        function App() {
          const [itemId, setItemId] = useState('A')
          const [visible, setVisible] = useState(true)
          const [duplicate, setDuplicate] = useState(false)
          const [reader, setReader] = useState(false)
          return <>
            <button onClick={() => setItemId(itemId === 'A' ? 'B' : 'A')}>Switch literature</button>
            <button onClick={() => setVisible(!visible)}>Toggle panel</button>
            <button onClick={() => setDuplicate(!duplicate)}>Duplicate consumer</button>
            <button onClick={() => { window.offline = false }}>Online</button>
            <button onClick={() => setReader(!reader)}>Toggle reader</button>
            {visible && (reader ? <div id="reader" style={{ width: 360, height: 660 }}><LiteratureNotesPanel context={{ recordTarget: { owner: 'literature_attachment', scope_id: itemId } }} /></div> : <Probe key={itemId} itemId={itemId} label="Primary" />)}
            {duplicate && <Probe itemId="A" label="Secondary" />}
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
        name: 'note-api-fixture',
        setup(builder) {
          builder.onResolve({ filter: /^\.\.\/\.\.\/store$/ }, (args) =>
            args.importer.endsWith('/literature/NoteSources.tsx')
              ? { path: 'store', namespace: 'fixture' }
              : undefined
          )
          builder.onResolve({ filter: /^\.\/api$/ }, (args) =>
            /\/literature\/(autosave.ts|ReaderNotes.tsx)$/.test(args.importer)
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
                ? 'export const useApp = () => ({ act: { openLiteratureAttachment: async () => true } })'
                : args.path === 'i18n'
                  ? `export const useTranslation = () => ({ t: key => key.startsWith('notes.mode') ? ${JSON.stringify(NOTE_LABELS)}[key.slice(6)] ?? key : key })`
                  : `
              export class LiteratureApiError extends Error {}
              export async function listLiteratureNotes(itemId) {
                if (window.offline) throw new Error('offline list')
                return window.fixtureNotes[itemId] ? [window.fixtureNotes[itemId]] : []
              }
              export async function updateLiteratureNote(itemId, id, draft) {
                window.calls.push({ itemId, id, ...draft })
                if (window.offline) throw new Error('offline')
                const saved = { id, ...draft, version: draft.version + 1, created_at: 1, updated_at: 2, position: 0 }
                window.fixtureNotes[itemId] = saved
                return saved
              }
              export const addLiteratureNote = () => { throw new Error('Unexpected create') }
              export const deleteLiteratureNote = () => { throw new Error('Unexpected delete') }
            `,
          }))
        },
      },
    ],
  })
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined })
  try {
    const page = await browser.newPage()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.setContent('<div id="root"></div>')
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    const primary = page.getByRole('region', { name: 'Primary' })
    await primary.getByRole('button', { name: 'Open', exact: true }).click()
    await primary.getByRole('textbox', { name: 'Body' }).fill('A unsaved')
    await primary.getByRole('button', { name: 'Back' }).click()
    await expect(primary.locator('output')).toHaveText('dirty:notes.saveFailed')
    await page.getByRole('button', { name: 'Toggle reader' }).click()
    const reader = page.locator('#reader')
    await expect(reader.getByRole('textbox', { name: 'notes.bodyPlaceholder' })).toHaveValue(
      'A unsaved'
    )
    await expect(reader.getByText('readerNotes.loadFailed', { exact: true })).toBeVisible()
    await reader.getByRole('button', { name: 'readerNotes.retry', exact: true }).click()
    await expect(reader.getByRole('textbox', { name: 'notes.bodyPlaceholder' })).toHaveValue(
      'A unsaved'
    )
    const stylesheet = join(DESKTOP, 'src/renderer/src/styles.css')
    const compiled = await postcss([tailwindcss({ base: join(DESKTOP, 'src/renderer') })]).process(
      readFileSync(stylesheet, 'utf8'),
      { from: stylesheet }
    )
    await page.addStyleTag({ content: compiled.css })
    for (const theme of ['light', 'dark']) {
      await page.evaluate((value) => {
        document.documentElement.dataset.theme = value
      }, theme)
      await expect(reader.getByRole('button', { name: 'notes.retrySave' })).toBeVisible()
      assert.equal(
        await reader.evaluate((element) => element.scrollWidth <= element.clientWidth),
        true,
        theme
      )
    }
    await page.getByRole('button', { name: 'Toggle reader' }).click()
    await page.getByRole('button', { name: 'Switch literature' }).click()
    await primary.getByRole('button', { name: 'Open', exact: true }).click()
    await expect(primary.getByRole('textbox', { name: 'Body' })).toHaveValue('Original B')
    await page.getByRole('button', { name: 'Switch literature' }).click()
    await expect(primary.getByRole('textbox', { name: 'Body' })).toHaveValue('A unsaved')
    await page.getByRole('button', { name: 'Duplicate consumer' }).click()
    const secondary = page.getByRole('region', { name: 'Secondary' })
    await expect(secondary.getByRole('textbox', { name: 'Body' })).toHaveValue('A unsaved')
    await secondary.getByRole('textbox', { name: 'Body' }).fill('Shared edit')
    await expect(primary.getByRole('textbox', { name: 'Body' })).toHaveValue('Shared edit')
    await page.getByRole('button', { name: 'Online' }).click()
    await primary.getByRole('button', { name: 'Save' }).click()
    await expect(secondary.locator('output')).toHaveText('saved:')
    await page.getByRole('button', { name: 'Duplicate consumer' }).click()
    await page.getByRole('button', { name: 'Toggle panel' }).click()
    await page.getByRole('button', { name: 'Toggle panel' }).click()
    await expect(primary.getByRole('textbox', { name: 'Body' })).toHaveCount(0)
    await primary.getByRole('button', { name: 'Open', exact: true }).click()
    await expect(primary.getByRole('textbox', { name: 'Body' })).toHaveValue('Shared edit')
    await page.getByRole('button', { name: 'Toggle reader' }).click()
    const back = reader.getByRole('button', { name: 'notes.back', exact: true })
    const modes = reader.getByRole('tablist')
    const backBounds = await back.boundingBox()
    const modeBounds = await modes.boundingBox()
    assert.ok(backBounds && modeBounds)
    assert.ok(
      Math.abs(backBounds.y - modeBounds.y) < Math.max(backBounds.height, modeBounds.height)
    )
    await back.click()
    const create = reader.getByRole('button', { name: 'relations.addNote' })
    await expect(create).toBeVisible()
    assert.match((await create.getAttribute('class')) ?? '', /vds-button--primary/)
    await expect(create.locator('svg')).toHaveCount(0)
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
