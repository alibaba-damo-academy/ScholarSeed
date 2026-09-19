import assert from 'node:assert/strict'
import test from 'node:test'

import { catalogue } from './catalog.ts'

test('overview and project catalogue keep filters without pagination state', () => {
  for (const projectId of [null, 'single-page-project']) {
    catalogue.scope(projectId)
    catalogue.query({ q: 'single-page', sort: 'title', order: 'asc' })
    catalogue.imported({ q: undefined })
    const query = catalogue.getSnapshot().query
    assert.equal(query.page, undefined)
    assert.equal(query.page_size, undefined)
    assert.equal(query.sort, 'title')
    assert.equal(query.order, 'asc')
    assert.equal(query.project_id, projectId ?? undefined)
  }
  catalogue.scope(null)
})

test('project catalogue preserves its scope through filters and restores each space independently', () => {
  catalogue.scope(null)
  catalogue.query({ q: 'global filter' })
  catalogue.scope('project-a')
  catalogue.query({ q: 'project filter', project_id: undefined })
  catalogue.focus('shared-paper')
  assert.equal(catalogue.getSnapshot().query.project_id, 'project-a')
  catalogue.query({ project_id: 'project-b' })
  assert.equal(catalogue.getSnapshot().query.project_id, 'project-a')
  catalogue.scope('project-b')
  assert.equal(catalogue.getSnapshot().focusedId, null)
  assert.equal(catalogue.getSnapshot().query.q, undefined)
  catalogue.scope(null)
  assert.equal(catalogue.getSnapshot().query.q, 'global filter')
  assert.equal(catalogue.getSnapshot().query.project_id, undefined)
  catalogue.scope('project-a')
  assert.equal(catalogue.getSnapshot().focusedId, null)
  assert.equal(catalogue.getSnapshot().query.q, 'project filter')
  catalogue.scope(null)
})

test('non-detail catalogue actions dismiss the open literature detail', () => {
  catalogue.scope(null)
  catalogue.focusAttachment('paper', 'attachment')
  catalogue.query({ recent: true })
  assert.equal(catalogue.getSnapshot().focusedId, null)
  assert.equal(catalogue.getSnapshot().focusedAttachmentId, null)
  catalogue.focus('paper')
  catalogue.select('paper', true)
  assert.equal(catalogue.getSnapshot().focusedId, null)
  catalogue.scope(null)
})
