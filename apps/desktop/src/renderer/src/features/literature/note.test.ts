import assert from 'node:assert/strict'
import test from 'node:test'

import type { DocumentPanelContext } from '../../contracts/features.ts'
import {
  LITERATURE_NOTES_PANEL_ID,
  literatureIdFromDocument,
  literatureNoteTitle
} from './note.ts'

const context = (
  owner: 'literature_attachment' | 'project_asset' | null,
  viewer: DocumentPanelContext['viewer'] = 'pdf'
): DocumentPanelContext => ({
  path: 'paper.pdf',
  viewer,
  sourceKind: owner === 'literature_attachment' ? 'literature' : 'project',
  recordTarget: owner ? { owner, scope_id: 'scope-1', subject_id: 'attachment-1' } : null,
  documentSessionId: 'session-1',
  tabId: 'tab-1'
})

test('literature notes panel matches only exact literature attachment ownership', () => {
  assert.equal(LITERATURE_NOTES_PANEL_ID, 'literature-notes')
  assert.equal(literatureIdFromDocument(context('literature_attachment')), 'scope-1')
  assert.equal(literatureIdFromDocument(context('literature_attachment', 'image')), 'scope-1')
  assert.equal(literatureIdFromDocument(context('project_asset')), null)
  assert.equal(literatureIdFromDocument(context(null)), null)
})

test('reader note titles prefer persisted titles and use a stable positional fallback', () => {
  const fallback = (position: number): string => `Note ${position}`
  assert.equal(literatureNoteTitle({ title: ' Findings ' }, 0, fallback), 'Findings')
  assert.equal(literatureNoteTitle({ title: '' }, 1, fallback), 'Note 2')
})
