import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { loadConversationSearch, createLiteratureSearch, LiteratureApiError, streamLiteratureSearch } from './api.ts'
import { conversationSearchPapers, presentedSearchArtifacts, searchPapersBibtex, searchResultPapers, visibleSearchPapers } from './result.ts'
import { literatureSearchTab, openLiteratureSearchTabs } from '../workbench/tabs.ts'

const papers = [
  { paper_id: 'one', title: 'Zeta', authors: ['A', 'B'], year: 2022, venue: 'V', abstract: 'A {test}', citation_count: 4, doi: '10/one', arxiv_id: '', tier: 2, reason: '', subtopics_covered: [], access: 'open', source: 'paperhub' },
  { paper_id: 'two', title: 'Alpha', authors: ['C'], year: 2024, venue: '', abstract: '', citation_count: 20, doi: '', arxiv_id: '2401.1', tier: 1, reason: '', subtopics_covered: [], access: 'closed_or_unknown', source: 'paperhub' }
]

test('review retrieval evidence stays inside its card rather than making file cards', () => {
  const result = {
    origin: 'literature-review',
    metadata: { artifact_id: 'metadata' },
    selection: { artifact_id: 'selection' },
    report: { artifact_id: 'report' },
    fulltext: { artifact_id: 'fulltext' }
  }
  assert.deepEqual(presentedSearchArtifacts(result), ['metadata', 'selection', 'fulltext', 'report'])
  assert.deepEqual(presentedSearchArtifacts({ ...result, origin: 'precise-search' }), ['metadata', 'selection', 'fulltext'])
})

test('literature search results filter and sort without mutating metadata order', () => {
  assert.deepEqual(visibleSearchPapers(papers, 'all', 'relevance').map((paper) => paper.paper_id), ['two', 'one'])
  assert.deepEqual(visibleSearchPapers(papers, 'open', 'citations').map((paper) => paper.paper_id), ['one'])
  assert.deepEqual(papers.map((paper) => paper.paper_id), ['one', 'two'])
})

test('selected search papers convert to importable BibTeX', () => {
  const bibtex = searchPapersBibtex(papers)
  assert.ok(bibtex.includes('@article{scholarseed20221'))
  assert.ok(bibtex.includes('author = {A and B}'))
  assert.ok(bibtex.includes('abstract = {A \\{test\\}}'))
})

test('literature search content fills the available workbench width', () => {
  const source = readFileSync(new URL('./Search.tsx', import.meta.url), 'utf8')
  assert.match(source, /className="flex min-h-0 w-full min-w-0 flex-1 flex-col/)
  assert.match(source, /aria-label=\{t\('search.selectAll'\)\}\s+checked=\{allShownSelected\}/)
  // 正文列是推荐理由, 全文获取列与详情摘要由列集配置决定, 结果表不再读摘要
  assert.ok(source.includes("paper.reason || t('search.detailUnknown')"))
  assert.match(source, /\$\{columns\.grid\}/)
  assert.ok(!source.includes('paper.abstract ||'))
})

test('AI search results drop abstracts so the library import stays without one', () => {
  const projected = searchResultPapers(papers)
  assert.deepEqual(projected.map((paper) => paper.abstract), ['', ''])
  assert.deepEqual(projected.map((paper) => paper.title), ['Zeta', 'Alpha'])
  assert.ok(!searchPapersBibtex(projected).includes('abstract ='))
  assert.ok(searchPapersBibtex(papers).includes('abstract = {A \\{test\\}}'))
})

test('submitted searches and conversation results share the query summary header', () => {
  const source = readFileSync(new URL('./Search.tsx', import.meta.url), 'utf8')
  const resultsSource = readFileSync(new URL('./Results.tsx', import.meta.url), 'utf8')
  assert.match(source, /query=\{task\.query\}/)
  assert.match(source, /query\?: string/)
  assert.match(source, /i18nKey="search.summary"\s+values=\{\{ query \}\}/)
  assert.match(source, /t\('search.paperCount', \{ count: papers.length \}\)/)
  const header = source.slice(source.indexOf('<header'), source.indexOf('</header>'))
  assert.match(header, /SEARCH_STATUS_KEYS\[status\]/)
  assert.match(header, /<JoinLibraryMenu papers=\{picked\}/)
  assert.match(header, /t\('batch.selected', \{ count: picked.length \}\)/)
  assert.match(resultsSource, /query=\{result\.criteria/)
})

test('project search keeps its scope and imports only into the current project', () => {
  const searchSource = readFileSync(new URL('./Search.tsx', import.meta.url), 'utf8')
  const storeSource = readFileSync(new URL('../../store.tsx', import.meta.url), 'utf8')
  assert.ok(searchSource.includes('const projectId = state.homeSelectedProjectId'))
  const menuSource = readFileSync(new URL('./JoinMenu.tsx', import.meta.url), 'utf8')
  assert.ok(menuSource.includes('listLiteratureCollections(projectId)'))
  assert.ok(menuSource.includes('await pushLibItem(items, destination, projectId)'))
  assert.ok(menuSource.includes('!projectId && Boolean(tree?.projects.length)'))
  const openSearch = storeSource.slice(
    storeSource.indexOf('openLiteratureSearch: (task)'),
    storeSource.indexOf('restoreLiteratureSearches:')
  )
  assert.doesNotMatch(openSearch, /homeSelectedProjectId: null/)
})

test('opening a conversation literature result leaves fullscreen assistant cover', () => {
  const storeSource = readFileSync(new URL('../../store.tsx', import.meta.url), 'utf8')
  const openResult = storeSource.slice(
    storeSource.indexOf('openLiteratureResult: (result)'),
    storeSource.indexOf('openLiteratureSearch: (task)')
  )
  assert.match(openResult, /mainView: 'literature'/)
  assert.match(openResult, /aiPanel: \{ \.\.\.current\.aiPanel, cover: false \}/)
})

test('search imports refresh shared literature counts after persistence succeeds', () => {
  const source = readFileSync(new URL('./JoinMenu.tsx', import.meta.url), 'utf8')
  const state = readFileSync(new URL('./joinState.ts', import.meta.url), 'utf8')
  assert.match(source, /await pushLibItem\(items, destination, projectId\)\s+recordJoined/)
  assert.match(state, /export function recordJoined[\s\S]*?catalogue\.reload\(\)/)
})

test('literature panel filters return focus to the literature overview tab', () => {
  const source = readFileSync(new URL('./LiteraturePanel.tsx', import.meta.url), 'utf8')
  const scopeHelper = source.slice(
    source.indexOf('const selectLiteratureScope ='),
    source.indexOf('const scope =')
  )
  assert.match(scopeHelper, /act\.activateTab\('literature'\)/)
  assert.match(scopeHelper, /catalogue\.query\(patch\)/)
  assert.match(source, /onClick=\{\(\) => selectLiteratureScope\(patch\)\}/)
  assert.match(source, /selectLiteratureScope\(\{ \.\.\.clear, project_id: project\.id \}\)/)
  assert.match(source, /selectLiteratureScope\(\{\s+\.\.\.clear,\s+project_id: project\?\.id \?\? projectId,\s+collection_id: \[collection\.id\]/)
  assert.match(source, /selectLiteratureScope\(\{ \.\.\.clear, tag_id: \[item\.id\] \}\)/)
})

test('attachment deletion refreshes the shared literature catalogue after closing detail', () => {
  const source = readFileSync(new URL('./LiteratureDetail.tsx', import.meta.url), 'utf8')
  assert.ok(source.includes('deleteLiteratureAttachment(itemId, target.id)'))
  assert.match(source, /onClose\(\)\s+catalogue\.reload\(\)/)
})

test('literature search tabs are stable and restored in supplied timestamp order', () => {
  const overview = { id: 'overview', kind: 'overview' as const, title: '总览', closable: false }
  const literature = { id: 'literature', kind: 'literature' as const, title: '文献库', closable: true }
  const first = literatureSearchTab('task-100', 'first')
  assert.deepEqual(first, {
    id: 'literature-search:task-100',
    kind: 'literature_search',
    title: 'AI检索：first',
    titleFallback: { kind: 'literatureSearch', query: 'first' },
    closable: true,
    projectId: null
  })
  assert.equal(literatureSearchTab('task-project', 'scoped', 'project-a').projectId, 'project-a')
  const restored = openLiteratureSearchTabs(
    [overview, literature],
    [{ id: 'task-100', query: 'first' }, { id: 'task-200', query: 'second' }]
  )
  assert.deepEqual(restored.map((tab) => tab.id), [
    'overview',
    'literature',
    'literature-search:task-100',
    'literature-search:task-200'
  ])
  assert.equal(openLiteratureSearchTabs(restored, [{ id: 'task-100', query: 'first' }]), restored)
})

test('literature search SSE parser handles chunk boundaries and seq replay deduplication', async () => {
  const previousWindow = globalThis.window
  const previousFetch = globalThis.fetch
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: { href: 'http://desktop.test/' }, scholarseed: { getApiBase: () => 'http://service.test' } }
  })
  const encoder = new TextEncoder()
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"schema_version":1,"seq":1,"type":"content.delta","data":{"text":"old"}}\n\n'))
      controller.enqueue(encoder.encode('data: {\"schema_version\":1,\"seq\":2,\"type\":\"content.delta\",'))
      controller.enqueue(encoder.encode('"data":{"text":"new"}}\n\n'))
      controller.close()
    }
  }), { headers: { 'Content-Type': 'text/event-stream' } })
  try {
    const observed: number[] = []
    await streamLiteratureSearch('task-1', 1, (event) => observed.push(event.seq))
    assert.deepEqual(observed, [2])
  } finally {
    globalThis.fetch = previousFetch
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
  }
})

test('literature search presents runtime incompatibility instead of raw fetch failure', async () => {
  const previousWindow = globalThis.window
  const previousFetch = globalThis.fetch
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: { href: 'http://desktop.test/' }, scholarseed: { getApiBase: () => 'http://service.test' } }
  })
  globalThis.fetch = async () => Response.json(
    { detail: 'invocation_runtime_unavailable' },
    { status: 503 }
  )
  try {
    await assert.rejects(
      createLiteratureSearch('agent systems'),
      (error: unknown) => error instanceof LiteratureApiError
        && error.failure.status === 503
        && error.failure.code === 'invocation_runtime_unavailable'
        && error.message === 'invocation_runtime_unavailable'
    )
  } finally {
    globalThis.fetch = previousFetch
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
  }
})


test('conversation results reuse library rows without inventing scores or losing source URLs', () => {
  const rows = conversationSearchPapers([
    { id: 'first', title: 'Selected work', authors: ['A'], year: null, venue: null, doi: null,
      url: 'https://example.org/paper', abstract: 'Original abstract', reasons: ['Matches method', 'Matches scope'],
      access: 'yes', sources: ['paperhub', 'web'] },
    { id: 'second', title: 'Another work', authors: [], year: 2026, venue: null, doi: null,
      url: null, abstract: null, reasons: [], access: 'unknown', sources: [] }
  ])
  assert.deepEqual(visibleSearchPapers(rows, 'all', 'relevance').map(row => row.paper_id), ['first', 'second'])
  assert.equal(rows[0].year, null)
  assert.equal(rows[0].citation_count, null)
  assert.equal(rows[0].reason, 'Matches method；Matches scope')
  assert.equal(rows[0].source, 'paperhub、web')
  assert.equal(rows[1].access, 'unknown')
  assert.match(searchPapersBibtex(rows), /url = \{https:\/\/example.org\/paper\}/)
})


test('saved results retain all rows across batched library lookup failures', async () => {
  const previousWindow = globalThis.window
  const previousFetch = globalThis.fetch
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { scholarseed: { getApiBase: () => '' } } })
  const result = { session_id: 'session', papers: Array.from({ length: 25 }, (_, id) => ({ id: String(id), title: `Paper ${id}`, doi: null, year: null })) }
  const calls: string[] = []
  globalThis.fetch = async (url, init) => {
    calls.push(String(url))
    if (String(url).endsWith('/results/card')) return Response.json(result)
    const request = JSON.parse(String(init?.body))
    assert.equal(request.project_id, 'project-two')
    const batch = request.papers
    if (batch.length === 20) return new Response('', { status: 503 })
    return Response.json({ items: Object.fromEntries(batch.map((paper: { id: string }) => [paper.id, { library: 'matched' }])) })
  }
  try {
    const loaded = await loadConversationSearch('session', 'card', new AbortController().signal, 'project-two')
    assert.equal(loaded.result.papers.length, 25)
    assert.deepEqual(loaded.saved, ['20', '21', '22', '23', '24'])
    assert.equal(loaded.warning, true)
    assert.equal(calls.length, 3)
    assert.ok(calls.every(url => url.includes('/api/sessions/session/literature/')))
  } finally { Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow }); globalThis.fetch = previousFetch }
})

test('unknown library states warn without implying absence, and missing snapshots fail', async () => {
  const previousWindow = globalThis.window
  const previousFetch = globalThis.fetch
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { scholarseed: { getApiBase: () => '' } } })
  globalThis.fetch = async url => String(url).endsWith('/results/card')
    ? Response.json({ session_id: 'session', papers: [{ id: 'one', title: 'Paper' }] })
    : Response.json({ items: { one: { library: 'unavailable' } } })
  try {
    const loaded = await loadConversationSearch('session', 'card', new AbortController().signal)
    assert.deepEqual(loaded.saved, [])
    assert.equal(loaded.warning, true)
    globalThis.fetch = async () => new Response('', { status: 404 })
    await assert.rejects(loadConversationSearch('session', 'missing', new AbortController().signal), /result_unavailable/)
  } finally { Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow }); globalThis.fetch = previousFetch }
})
