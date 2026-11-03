import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { catalogue } from './catalog.ts'

test('download batch navigation clears stale state and preserves its scope while refining', () => {
  catalogue.scope(null)
  catalogue.query({ q: 'old search' })
  catalogue.focus('old-paper')
  catalogue.select('old-paper', true)
  catalogue.downloads('session', 'run', null, ['shown'])
  assert.equal(catalogue.getSnapshot().query.q, undefined)
  assert.equal(catalogue.getSnapshot().focusedId, null)
  assert.deepEqual(catalogue.getSnapshot().selected, [])
  assert.deepEqual(catalogue.getSnapshot().items, [])
  assert.equal(catalogue.getSnapshot().itemsReady, false)
  catalogue.query({ q: 'Transformer', sort: 'title' })
  assert.equal(catalogue.getSnapshot().query.download_run, 'run')
  assert.deepEqual(catalogue.getSnapshot().query.exclude_paper_id, ['shown'])
  catalogue.navigate({ recent: true })
  assert.equal(catalogue.getSnapshot().query.download_session_id, undefined)
  assert.equal(catalogue.getSnapshot().query.recent, true)
})

test('switching download batches replaces project, exclusions, and selection', () => {
  catalogue.downloads('session-a', 'run-a', 'project-a', ['shown-a'])
  catalogue.select('batch-a-paper', true)
  catalogue.downloads('session-b', 'run-b', 'project-b', ['shown-b'])
  assert.equal(catalogue.getSnapshot().projectId, 'project-b')
  assert.equal(catalogue.getSnapshot().query.project_id, 'project-b')
  assert.equal(catalogue.getSnapshot().query.download_session_id, 'session-b')
  assert.equal(catalogue.getSnapshot().query.download_run, 'run-b')
  assert.deepEqual(catalogue.getSnapshot().query.exclude_paper_id, ['shown-b'])
  assert.deepEqual(catalogue.getSnapshot().selected, [])
  catalogue.scope(null)
  catalogue.navigate()
})

test('fulltext admission invalidates the visible catalogue, not only the legacy store', () => {
  const source = readFileSync(new URL('./Card.tsx', import.meta.url), 'utf8')
  const delivery = readFileSync(new URL('./Delivery.tsx', import.meta.url), 'utf8')
  assert.match(delivery, /const result = await ports\.save\(/)
  assert.match(source, /saveDelivery\([\s\S]*?if \(reply\.ok\) \{\s*catalogue\.reload\(\)/)
  for (const projectId of [null, 'delivery-project']) {
    catalogue.scope(projectId)
    catalogue.query({ q: 'retained filter' })
    catalogue.items([])
    const before = catalogue.getSnapshot().reload
    catalogue.reload()
    assert.equal(catalogue.getSnapshot().reload, before + 1)
    assert.equal(catalogue.itemsFresh(), false)
    assert.equal(catalogue.getSnapshot().projectId, projectId)
    assert.equal(catalogue.getSnapshot().query.q, 'retained filter')
  }
  catalogue.scope(null)
})

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

test('turn selection follows only the visible matching literature scope', () => {
  catalogue.scope('turn-project')
  catalogue.select('paper', true)
  assert.deepEqual(catalogue.selectedForTurn('turn-project', true), ['paper'])
  assert.deepEqual(catalogue.selectedForTurn('turn-project', false), [])
  assert.deepEqual(catalogue.selectedForTurn('another-project', true), [])
  catalogue.select('paper', false)
  assert.deepEqual(catalogue.selectedForTurn('turn-project', true), [])
  catalogue.scope(null)
})

test('panel refresh does not request a literature list reload', () => {
  const before = catalogue.getSnapshot()
  catalogue.reloadPanel()
  const after = catalogue.getSnapshot()
  assert.equal(after.reload, before.reload)
  assert.equal(after.panelReload, before.panelReload + 1)
})

const PANEL_SNAPSHOT = {
  counts: { all: 1, recent: 1, without_collection: 0, unread: 0, without_fulltext: 0 },
  facets: { collections: [], tags: [], item_types: [], publications: [], years: [] },
  projects: [],
} as never
const OVERVIEW_COUNTS = {
  all: 193,
  recent: 0,
  without_collection: 0,
  unread: 0,
  without_fulltext: 0,
}

test('scope remount keeps cached rows for instant paint but revalidates them', () => {
  catalogue.scope(null)
  catalogue.items([{ id: 'cached-paper' }] as never)
  catalogue.panel(PANEL_SNAPSHOT)
  catalogue.tags([{ id: 'cached-tag' }] as never)
  assert.equal(catalogue.itemsFresh(), true)
  assert.equal(catalogue.panelFresh(), true)
  assert.equal(catalogue.tagsFresh(), true)
  catalogue.scope('cached-project')
  catalogue.scope(null)
  // 数据留着: 切回来不闪空态、不转 loading。
  assert.equal(catalogue.getSnapshot().itemsReady, true)
  assert.equal(catalogue.getSnapshot().items[0]?.id, 'cached-paper')
  assert.equal(catalogue.getSnapshot().panel?.counts.all, 1)
  assert.equal(catalogue.getSnapshot().scopedTags[0]?.id, 'cached-tag')
  // 新鲜度清零: 挂载后必须重新取数, 而不是把上一次的快照当成事实。
  assert.equal(catalogue.itemsFresh(), false)
  assert.equal(catalogue.panelFresh(), false)
  assert.equal(catalogue.tagsFresh(), false)
})

test('a mutation in one scope does not freeze the other scope snapshot', () => {
  catalogue.scope(null)
  catalogue.items([{ id: 'overview-paper' }] as never)
  catalogue.panel(PANEL_SNAPSHOT)
  catalogue.scope('mutating-project')
  catalogue.items([{ id: 'project-paper' }] as never)
  // 项目文献库里删除文献: 只失效当前作用域, 全览的存档时间戳原封不动。
  catalogue.reload()
  catalogue.scope(null)
  assert.equal(catalogue.getSnapshot().items[0]?.id, 'overview-paper')
  assert.equal(catalogue.itemsFresh(), false)
  assert.equal(catalogue.panelFresh(), false)
  catalogue.scope(null)
})

test('literature mutations expire the home overview counts cache', () => {
  catalogue.scope(null)
  for (const mutate of [
    () => catalogue.reload(),
    () => catalogue.reloadPanel(),
    () => catalogue.imported({ q: undefined }),
  ]) {
    catalogue.cacheOverviewCounts(OVERVIEW_COUNTS)
    assert.equal(catalogue.overviewCountsFresh(), true)
    mutate()
    assert.equal(catalogue.overviewCountsFresh(), false)
    // 旧值仍然可读: 首页先用它秒开, 再后台刷新成真实计数。
    assert.equal(catalogue.overviewCounts()?.all, 193)
  }
  catalogue.scope(null)
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
