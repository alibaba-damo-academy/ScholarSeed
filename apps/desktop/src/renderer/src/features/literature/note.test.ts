import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import type { DocumentPanelContext } from '../../contracts/features.ts'
import {
  LITERATURE_NOTES_PANEL_ID,
  literatureIdFromDocument,
  literatureNoteTitle,
  markdownNoteExport,
  exportNoteAsMarkdown
} from './note.ts'

const notesSource = readFileSync(new URL('./Notes.tsx', import.meta.url), 'utf8')

const context = (
  owner: 'literature_attachment' | 'project_asset' | null,
  viewer: DocumentPanelContext['viewer'] = 'pdf'
): DocumentPanelContext => ({
  path: 'paper.pdf',
  viewer,
  sourceKind: owner === 'literature_attachment' ? 'literature' : 'project',
  recordTarget: owner
    ? { owner, scope_id: 'scope-1', subject_id: 'attachment-1' }
    : null,
  documentSessionId: 'session-1',
  tabId: 'tab-1'
})

test('literature notes panel matches only exact literature attachment ownership', () => {
  assert.equal(LITERATURE_NOTES_PANEL_ID, 'literature-notes')
  assert.equal(
    literatureIdFromDocument(context('literature_attachment')),
    'scope-1'
  )
  assert.equal(
    literatureIdFromDocument(context('literature_attachment', 'image')),
    'scope-1'
  )
  assert.equal(literatureIdFromDocument(context('project_asset')), null)
  assert.equal(literatureIdFromDocument(context(null)), null)
})

test('reader note titles prefer persisted titles and use a stable positional fallback', () => {
  const fallback = (position: number): string => `Note ${position}`
  assert.equal(
    literatureNoteTitle({ title: ' Findings ' }, 0, fallback),
    'Findings'
  )
  assert.equal(literatureNoteTitle({ title: '' }, 1, fallback), 'Note 2')
})

test('note editor back discards the draft when an error is visible', () => {
  assert.match(
    notesSource,
    /const requestClose = \(\): void => \{\s+if \(error \|\| exportError\) \{\s+setExportError\(''\)\s+close\(\)\s+return/
  )
})

test('Markdown export preserves headings, lists, links, code and Unicode exactly', () => {
  const text =
    '## 研究\n\n- **贡献**\n- *局限*\n\n[来源](https://example.org)\n\n```python\nprint("你好")\n```\n'
  const result = markdownNoteExport({ title: '阅读笔记', text }, 1, String)
  assert.equal(result.suggestedName, '阅读笔记.md')
  assert.equal(new TextDecoder().decode(result.bytes), `# 阅读笔记\n\n${text}`)
})

test('Markdown export sanitizes every filename separator on both platforms', () => {
  const result = markdownNoteExport(
    { title: 'A/B\\C:D*E?F"G<H>I|J', text: 'body' },
    1,
    String
  )
  assert.equal(result.suggestedName, 'A-B-C-D-E-F-G-H-I-J.md')
})

test('untitled export keeps the original Markdown and uses the localized fallback name', () => {
  const result = markdownNoteExport(
    { title: ' ', text: '# 原标题\n' },
    2,
    (position) => `笔记 ${position}`
  )
  assert.equal(result.suggestedName, '笔记 2.md')
  assert.equal(new TextDecoder().decode(result.bytes), '# 原标题\n')
})

test('Markdown export uses the real save-copy contract and handles cancellation', async () => {
  const calls: { suggestedName: string; bytes: Uint8Array }[] = []
  await exportNoteAsMarkdown({ title: 'Note', text: '- item' }, 1, String, {
    saveFileCopy: async (payload) => {
      calls.push(payload)
      return { ok: true, path: '/tmp/Note.md' }
    }
  })
  assert.equal(calls.length, 1)
  assert.equal(new TextDecoder().decode(calls[0].bytes), '# Note\n\n- item')
  await exportNoteAsMarkdown({ title: 'Note', text: '- item' }, 1, String, {
    saveFileCopy: async () => ({ ok: false, canceled: true })
  })
})

test('Markdown export propagates write failures rather than silently succeeding', async () => {
  await assert.rejects(
    exportNoteAsMarkdown({ title: 'Note', text: 'body' }, 1, String, {
      saveFileCopy: async () => ({ ok: false, error: 'disk full' })
    }),
    /disk full/
  )
})
