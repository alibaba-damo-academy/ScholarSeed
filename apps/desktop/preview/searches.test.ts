import assert from 'node:assert/strict'
import test from 'node:test'
import { projectOfficialWebSearch, WEB_SEARCH_CANDIDATE_LIMIT } from '../src/renderer/src/features/resources/search.ts'
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

test('official results pass the actual renderer projection with query and execution identity intact', () => {
  const searches = new PreviewSearches()
  const query = 'reviewed mock search'
  const result = searches.webSearch({ query, limit: WEB_SEARCH_CANDIDATE_LIMIT })
  const projection = projectOfficialWebSearch(JSON.stringify(result), query, result.search_id)
  assert.equal(projection.executionEvidenceFound, true)
  assert.equal(projection.structuredOutputFound, true)
  assert.equal(projection.error, undefined)
  assert.equal(projection.candidates.length, 2)
  assert.equal(projection.candidates[0].title, PREVIEW_SEARCH.webTitle)
  assert.ok(projection.candidates.every(candidate => new URL(candidate.url).hostname === PREVIEW_SEARCH.hostname))
  assert.notEqual(result.search_id, searches.webSearch({ query, limit: 1 }).search_id)
  assert.equal(searches.webSearch({ query, limit: 1 }).candidates.length, 1)
})

test('search input boundaries reject malformed, excessive and empty requests without execution', () => {
  const searches = new PreviewSearches()
  for (const body of [null, {}, { query: '' }, { query: 'x', limit: 0 }, { query: 'x', limit: WEB_SEARCH_CANDIDATE_LIMIT + 1 }, { query: 'x', limit: 1.5 }, { query: 'x'.repeat(PREVIEW_SEARCH.maxQuery + 1) }]) {
    assert.throws(() => searches.webSearch(body), { status: 422, code: 'preview_search_invalid' })
  }
  for (const body of [null, {}, { papers: 'invalid' }]) assert.throws(() => searches.resultStatus(body), { status: 422 })
})
