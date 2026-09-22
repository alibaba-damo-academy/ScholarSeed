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

test('panel refresh does not request a literature list reload', () => {
  const before = catalogue.getSnapshot()
  catalogue.reloadPanel()
  const after = catalogue.getSnapshot()
  assert.equal(after.reload, before.reload)
  assert.equal(after.panelReload, before.panelReload + 1)
})

test('tag filtering narrows the query without dropping the working selection', () => {
  catalogue.scope(null)
  catalogue.query({ collection_id: ['collection-a'] })
  catalogue.select('paper', true)
  catalogue.focus('paper')
  // 标签是在既有勾选上叠加过滤条件, 不是换作用域: 勾选与打开中的文献都要留住。
  catalogue.filter({ tag_id: ['tag-a'] })
  assert.deepEqual(catalogue.getSnapshot().query.tag_id, ['tag-a'])
  assert.deepEqual(catalogue.getSnapshot().query.collection_id, ['collection-a'])
  assert.deepEqual(catalogue.getSnapshot().selected, ['paper'])
  assert.equal(catalogue.getSnapshot().focusedId, 'paper')
  // 撤到最后一个时 tag_id 回到 undefined, 而不是留一个空数组参与查询。
  catalogue.filter({ tag_id: undefined })
  assert.equal(catalogue.getSnapshot().query.tag_id, undefined)
  assert.deepEqual(catalogue.getSnapshot().selected, ['paper'])
  // 换作用域照旧清勾选: filter 只服务标签, 不改变 query 的语义。
  catalogue.query({ collection_id: ['collection-b'] })
  assert.deepEqual(catalogue.getSnapshot().selected, [])
  catalogue.scope(null)
})
