import assert from 'node:assert/strict'
import test from 'node:test'
import { PreviewSearches, PREVIEW_SEARCH } from './searches.ts'

test('literature history is scene scoped, isolated and consumable as a terminal production task', () => {
  assert.deepEqual(new PreviewSearches().listLiterature(), { items: [] })
  const first = new PreviewSearches({ literature: true })
  const second = new PreviewSearches({ literature: true })
  const task = first.listLiterature().items[0]
  assert.equal(task.query, PREVIEW_SEARCH.literatureQuery)
  assert.equal(task.status, 'completed')
  assert.ok(task.completed_at! >= task.created_at)
  assert.notEqual(task.id, second.listLiterature().items[0].id)
  assert.equal(task.result?.papers.length, 2)
  assert.deepEqual(JSON.parse(task.output), task.result)
  task.result!.papers.length = 0
  assert.equal(first.listLiterature().items[0].result?.papers.length, 2)
})

test('library lookup resolves only seeded paper identities and does not fabricate imports', () => {
  const searches = new PreviewSearches({ literature: true })
  const papers = searches.listLiterature().items[0].result!.papers
  const request = { project_id: '', papers: papers.map(paper => ({ id: paper.paper_id, title: paper.title, doi: paper.doi, year: paper.year })) }
  assert.deepEqual(searches.resultStatus(request), { items: Object.fromEntries(papers.map(paper => [paper.paper_id, { library: 'absent' }])) })
  assert.throws(() => new PreviewSearches().resultStatus(request), { status: 422, code: 'preview_search_paper_unknown' })
  assert.throws(() => searches.resultStatus({ papers: [{ id: 'unknown' }] }), { status: 422 })
})


test('library lookup rejects malformed requests without execution', () => {
  const searches = new PreviewSearches()
  for (const body of [null, {}, { papers: 'invalid' }]) assert.throws(() => searches.resultStatus(body), { status: 422 })
})
