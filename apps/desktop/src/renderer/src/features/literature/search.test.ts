import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  loadConversationSearch,
  requestConversationSearch,
  requestDownloadCard,
  createLiteratureSearch,
  LiteratureApiError,
  streamLiteratureSearch,
} from './api.ts'
import {
  conversationSearchPapers,
  presentedSearchArtifacts,
  searchPapersBibtex,
  searchResultPapers,
  searchWarningKeys,
  visibleSearchPapers,
} from './result.ts'
import { literatureSearchTab, openLiteratureSearchTabs } from '../workbench/tabs.ts'

const papers = [
  {
    paper_id: 'one',
    title: 'Zeta',
    authors: ['A', 'B'],
    year: 2022,
    venue: 'V',
    abstract: 'A {test}',
    citation_count: 4,
    doi: '10/one',
    arxiv_id: '',
    tier: 2,
    reason: '',
    subtopics_covered: [],
    access: 'open',
    source: 'paperhub',
  },
  {
    paper_id: 'two',
    title: 'Alpha',
    authors: ['C'],
    year: 2024,
    venue: '',
    abstract: '',
    citation_count: 20,
    doi: '',
    arxiv_id: '2401.1',
    tier: 1,
    reason: '',
    subtopics_covered: [],
    access: 'closed_or_unknown',
    source: 'paperhub',
  },
]

test('copy loads all saved papers by exact session/card without library lookups or writes', async (context) => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const previousFetch = globalThis.fetch
  context.after(() => {
    globalThis.fetch = previousFetch
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  })
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { scholarseed: { getApiBase: () => 'http://127.0.0.1' } },
  })
  const requests: Array<{ url: string; method?: string }> = []
  const saved = Array.from({ length: 40 }, (_, index) => ({
    id: String(index),
    title: `Paper ${index + 1}`,
  }))
  globalThis.fetch = async (input, options) => {
    requests.push({ url: String(input), method: options?.method })
    return new Response(JSON.stringify({ session_id: 'session', retained: 40, papers: saved }))
  }
  const result = await requestConversationSearch('session', 'saved/card')
  assert.deepEqual(result.papers, saved)
  assert.deepEqual(requests, [
    {
      url: 'http://127.0.0.1/api/sessions/session/literature/results/saved%2Fcard',
      method: undefined,
    },
  ])
  await assert.rejects(
    requestConversationSearch('other-session', 'saved/card'),
    /literature_result_invalid/
  )
})

test('download copy loads every scoped receipt and rejects incomplete or mismatched results', async () => {
  const originalWindow = globalThis.window
  const originalFetch = globalThis.fetch
  const requests: { url: string; method?: string }[] = []
  const saved = Array.from({ length: 5 }, (_, index) => ({
    paper_id: `paper-${index}`,
    literature_id: `literature-${index}`,
    attachment_id: `attachment-${index}`,
    title: `Paper ${index}`,
    revision: `revision-${index}`,
  }))
  const card = {
    schema_version: '1.0' as const,
    session_id: 'session',
    run: 'run/frozen',
    project_id: 'project',
    papers: saved.slice(0, 3),
    omitted_papers: 2,
    failures: [],
  }
  let payload = { ...card, papers: saved }
  globalThis.window = {
    scholarseed: { getApiBase: () => 'http://127.0.0.1' },
  } as unknown as Window & typeof globalThis
  globalThis.fetch = async (input, options) => {
    requests.push({ url: String(input), method: options?.method })
    return new Response(JSON.stringify(payload))
  }
  try {
    const complete = await requestDownloadCard(card)
    assert.deepEqual(complete.papers, saved)
    assert.equal(complete.omitted_papers, 0)
    assert.deepEqual(requests, [
      {
        url: 'http://127.0.0.1/api/sessions/session/literature/downloads?run=run%2Ffrozen&project_id=project',
        method: undefined,
      },
    ])
    for (const invalid of [
      { ...card, session_id: 'other-session', papers: saved },
      { ...card, run: 'other-run', papers: saved },
      { ...card, project_id: 'other-project', papers: saved },
      { ...card, papers: saved.slice(0, 3) },
      { ...card, papers: saved.map((paper) => ({ ...paper, revision: 'changed' })) },
    ]) {
      payload = invalid
      await assert.rejects(requestDownloadCard(card), /download_receipt_invalid/)
    }
  } finally {
    globalThis.window = originalWindow
    globalThis.fetch = originalFetch
  }
})

test('search report evidence stays inside its card rather than making file cards', () => {
  const result = {
    origin: 'literature-review',
    metadata: { artifact_id: 'metadata' },
    selection: { artifact_id: 'selection' },
    report: { artifact_id: 'report' },
    fulltext: { artifact_id: 'fulltext' },
  }
  assert.deepEqual(presentedSearchArtifacts(result), [
    'metadata',
    'selection',
    'fulltext',
    'report',
  ])
  assert.deepEqual(presentedSearchArtifacts({ ...result, origin: 'precise-search' }), [
    'metadata',
    'selection',
    'fulltext',
    'report',
  ])
  assert.deepEqual(presentedSearchArtifacts({ ...result, origin: 'agentic-search' }), [
    'metadata',
    'selection',
    'fulltext',
  ])
})

test('literature search results filter and sort without mutating metadata order', () => {
  assert.deepEqual(
    visibleSearchPapers(papers, 'all', 'relevance').map((paper) => paper.paper_id),
    ['two', 'one']
  )
  assert.deepEqual(
    visibleSearchPapers(papers, 'open', 'citations').map((paper) => paper.paper_id),
    ['one']
  )
  assert.deepEqual(
    papers.map((paper) => paper.paper_id),
    ['one', 'two']
  )
})

test('selected search papers convert to importable BibTeX', () => {
  const bibtex = searchPapersBibtex(papers)
  assert.ok(bibtex.includes('@article{scholarseed20221'))
  assert.ok(bibtex.includes('author = {A and B}'))
  assert.ok(bibtex.includes('abstract = {A \\{test\\}}'))
})

test('literature search content fills the available workbench width', () => {
  const source = readFileSync(new URL('./Matches.tsx', import.meta.url), 'utf8')
  assert.match(source, /className="flex min-h-0 w-full min-w-0 flex-1 flex-col/)
  assert.match(source, /aria-label=\{t\('search.selectAll'\)\}\s+checked=\{allShownSelected\}/)
  // 正文列是推荐理由, 全文获取列与详情摘要由列集配置决定, 结果表不再读摘要
  assert.ok(source.includes("paper.reason || t('search.detailUnknown')"))
  assert.match(source, /\$\{columns\.grid\}/)
  assert.ok(!source.includes('paper.abstract ||'))
})

test('AI search results drop abstracts so the library import stays without one', () => {
  const projected = searchResultPapers(papers)
  assert.deepEqual(
    projected.map((paper) => paper.abstract),
    ['', '']
  )
  assert.deepEqual(
    projected.map((paper) => paper.title),
    ['Zeta', 'Alpha']
  )
  assert.ok(!searchPapersBibtex(projected).includes('abstract ='))
  assert.ok(searchPapersBibtex(papers).includes('abstract = {A \\{test\\}}'))
})

test('submitted searches and conversation results share the query summary header', () => {
  const searchSource = readFileSync(new URL('./Search.tsx', import.meta.url), 'utf8')
  const source = readFileSync(new URL('./Matches.tsx', import.meta.url), 'utf8')
  const resultsSource = readFileSync(new URL('./Report.tsx', import.meta.url), 'utf8')
  assert.match(searchSource, /query=\{task\.query\}/)
  assert.match(searchSource, /<SearchSurface\s+\{\.\.\.props\}/)
  assert.match(
    readFileSync(new URL('./Results.tsx', import.meta.url), 'utf8'),
    /<ResultReport\s+View=\{LiteratureSearchView\}/
  )
  assert.match(source, /query\?: string/)
  assert.match(source, /i18nKey="search.summary"\s+values=\{\{ query \}\}/)
  assert.match(source, /t\('search.paperCount', \{ count: papers.length \}\)/)
  const header = source.slice(source.indexOf('<header'), source.indexOf('</header>'))
  assert.match(header, /SEARCH_STATUS_KEYS\[status\]/)
  assert.match(header, /<JoinLibraryMenu papers=\{picked\}/)
  assert.match(header, /t\('batch.selected', \{ count: picked.length \}\)/)
  assert.match(header, /flex-wrap items-center justify-between/)
  assert.match(header, /flex min-w-0 flex-auto items-center/)
  assert.match(header, /min-w-0 truncate/)
  assert.match(header, /picked\.length > 0 \? \(/)
  assert.doesNotMatch(header, /overflow-x-auto/)
  assert.match(resultsSource, /query=\{result\.criteria/)
})

test('project search keeps its scope and imports only into the current project', () => {
  const searchSource = readFileSync(new URL('./Search.tsx', import.meta.url), 'utf8')
  const storeSource = readFileSync(new URL('../../store.tsx', import.meta.url), 'utf8')
  assert.ok(searchSource.includes('const projectId = state.homeSelectedProjectId'))
  const menuSource = readFileSync(new URL('./JoinMenu.tsx', import.meta.url), 'utf8')
  assert.ok(menuSource.includes('listLiteratureCollections(projectId)'))
  assert.ok(menuSource.includes('await pushLibItem(papers, destination, projectId)'))
  const joiningSource = readFileSync(new URL('./Joining.tsx', import.meta.url), 'utf8')
  assert.ok(joiningSource.includes('!projectId && Boolean(tree?.projects.length)'))
  assert.ok(joiningSource.includes('await ports.admit(items, destination)'))
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
  assert.match(openResult, /literatureResultTab\(result, projectId\)/)
  assert.match(openResult, /projectId \? 'resource' : 'literature'/)
  assert.doesNotMatch(openResult, /homeSelectedProjectId: null/)
  assert.match(openResult, /aiPanel: \{ \.\.\.current\.aiPanel, cover: false \}/)
})

test('search imports refresh shared literature counts after persistence succeeds', () => {
  const source = readFileSync(new URL('./JoinMenu.tsx', import.meta.url), 'utf8')
  const state = readFileSync(new URL('./joinState.ts', import.meta.url), 'utf8')
  assert.match(source, /await pushLibItem\(papers, destination, projectId\)\s+recordJoined/)
  assert.match(state, /export function recordJoined[\s\S]*?catalogue\.reload\(\)/)
})

test('literature panel filters return focus to the literature overview tab', () => {
  const source = readFileSync(new URL('./LiteraturePanel.tsx', import.meta.url), 'utf8')
  const scopeHelper = source.slice(
    source.indexOf('const selectLiteratureScope ='),
    source.indexOf('const scope =')
  )
  assert.match(scopeHelper, /act\.activateTab\('literature'\)/)
  assert.match(scopeHelper, /catalogue\.navigate\(patch\)/)
  assert.match(source, /onClick=\{\(\) => selectLiteratureScope\(patch\)\}/)
  assert.match(source, /selectLiteratureScope\(\{ \.\.\.clear, project_id: project\.id \}\)/)
  assert.match(
    source,
    /selectLiteratureScope\(\{\s+\.\.\.clear,\s+project_id: project\?\.id \?\? projectId,\s+collection_id: \[collection\.id\]/
  )
  // 标签不再是作用域切换而是可叠加的多选过滤: 走 catalogue.filter 保留列表勾选,
  // 且不能再出现「整体替换成单个标签」的旧写法。
  assert.match(
    scopeHelper,
    /catalogue\.filter\(\{ tag_id: next\.length > 0 \? next : undefined \}\)/
  )
  assert.doesNotMatch(source, /tag_id: \[item\.id\]/)
  assert.match(source, /selected=\{activeTagIds\.has\(item\.id\)\}/)
})

test('tag facet scope mirrors the list query so sidebar project picks are counted', () => {
  const source = readFileSync(new URL('./LiteraturePanel.tsx', import.meta.url), 'utf8')
  const facetCall = source.slice(
    source.indexOf('getLiteratureTagFacets({'),
    source.indexOf('pruneStaleTags(value.tags)')
  )
  // 全览里点侧栏的项目行只写 query.project_id, 不改 homeSelectedProjectId; 拿面板
  // 作用域 (projectId) 去请求会让标签计数退回全库。项目文献库里两者恰好相等, 所以
  // 这个 bug 只在全览暴露 —— 断言必须钉住取值来源, 不能只钉住"能跑"。
  assert.match(facetCall, /project_id: query\.project_id/)
  assert.doesNotMatch(facetCall, /project_id: projectId/)
  assert.match(source, /query\.collection_id,\s+query\.project_id,\s+query\.recent,/)
  // 搜索与标签筛选互不相干; 已选标签也不能反向收窄自己的 facet。
  assert.doesNotMatch(facetCall, /\bq:/)
  assert.doesNotMatch(facetCall, /tag_id:/)
})

test('attachment deletion refreshes the shared literature catalogue after closing detail', () => {
  const source = readFileSync(new URL('./LiteratureDetail.tsx', import.meta.url), 'utf8')
  assert.ok(source.includes('deleteLiteratureAttachment(itemId, target.id)'))
  assert.match(source, /onClose\(\)\s+catalogue\.reload\(\)/)
})

test('literature search tabs are stable and restored in supplied timestamp order', () => {
  const overview = { id: 'overview', kind: 'overview' as const, title: '总览', closable: false }
  const literature = {
    id: 'literature',
    kind: 'literature' as const,
    title: '文献库',
    closable: true,
  }
  const first = literatureSearchTab('task-100', 'first')
  assert.deepEqual(first, {
    id: 'literature-search:task-100',
    kind: 'literature_search',
    title: 'AI检索：first',
    titleFallback: { kind: 'literatureSearch', query: 'first' },
    closable: true,
    projectId: null,
  })
  assert.equal(literatureSearchTab('task-project', 'scoped', 'project-a').projectId, 'project-a')
  const restored = openLiteratureSearchTabs(
    [overview, literature],
    [
      { id: 'task-100', query: 'first' },
      { id: 'task-200', query: 'second' },
    ]
  )
  assert.deepEqual(
    restored.map((tab) => tab.id),
    ['overview', 'literature', 'literature-search:task-100', 'literature-search:task-200']
  )
  assert.equal(openLiteratureSearchTabs(restored, [{ id: 'task-100', query: 'first' }]), restored)
})

test('literature search SSE parser handles chunk boundaries and seq replay deduplication', async () => {
  const previousWindow = globalThis.window
  const previousFetch = globalThis.fetch
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: { href: 'http://desktop.test/' },
      scholarseed: { getApiBase: () => 'http://service.test' },
    },
  })
  const encoder = new TextEncoder()
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              'data: {"schema_version":1,"seq":1,"type":"content.delta","data":{"text":"old"}}\n\n'
            )
          )
          controller.enqueue(
            encoder.encode('data: {"schema_version":1,"seq":2,"type":"content.delta",')
          )
          controller.enqueue(encoder.encode('"data":{"text":"new"}}\n\n'))
          controller.close()
        },
      }),
      { headers: { 'Content-Type': 'text/event-stream' } }
    )
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
    value: {
      location: { href: 'http://desktop.test/' },
      scholarseed: { getApiBase: () => 'http://service.test' },
    },
  })
  globalThis.fetch = async () =>
    Response.json({ detail: 'invocation_runtime_unavailable' }, { status: 503 })
  try {
    await assert.rejects(
      createLiteratureSearch('agent systems'),
      (error: unknown) =>
        error instanceof LiteratureApiError &&
        error.failure.status === 503 &&
        error.failure.code === 'invocation_runtime_unavailable' &&
        error.message === 'invocation_runtime_unavailable'
    )
  } finally {
    globalThis.fetch = previousFetch
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
  }
})

test('conversation results reuse library rows without inventing scores or losing source URLs', () => {
  const rows = conversationSearchPapers([
    {
      id: 'first',
      title: 'Selected work',
      authors: ['A'],
      year: null,
      venue: null,
      doi: null,
      url: 'https://example.org/paper',
      abstract: 'Original abstract',
      reasons: ['Matches method', 'Matches scope'],
      access: 'yes',
      sources: ['paperhub', 'web'],
    },
    {
      id: 'second',
      title: 'Another work',
      authors: [],
      year: 2026,
      venue: null,
      doi: null,
      url: null,
      abstract: null,
      reasons: [],
      access: 'unknown',
      sources: [],
    },
  ])
  assert.deepEqual(
    visibleSearchPapers(rows, 'all', 'relevance').map((row) => row.paper_id),
    ['first', 'second']
  )
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
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { scholarseed: { getApiBase: () => '' } },
  })
  const result = {
    session_id: 'session',
    papers: Array.from({ length: 25 }, (_, id) => ({
      id: String(id),
      title: `Paper ${id}`,
      doi: null,
      year: null,
    })),
  }
  const calls: string[] = []
  globalThis.fetch = async (url, init) => {
    calls.push(String(url))
    if (String(url).endsWith('/results/card')) return Response.json(result)
    const request = JSON.parse(String(init?.body))
    assert.equal(request.project_id, 'project-two')
    const batch = request.papers
    if (batch.length === 20) return new Response('', { status: 503 })
    return Response.json({
      items: Object.fromEntries(
        batch.map((paper: { id: string }) => [paper.id, { library: 'matched' }])
      ),
    })
  }
  try {
    const loaded = await loadConversationSearch(
      'session',
      'card',
      new AbortController().signal,
      'project-two'
    )
    assert.equal(loaded.result.papers.length, 25)
    assert.deepEqual(loaded.saved, ['20', '21', '22', '23', '24'])
    assert.equal(loaded.warning, true)
    assert.equal(calls.length, 3)
    assert.ok(calls.every((url) => url.includes('/api/sessions/session/literature/')))
  } finally {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
    globalThis.fetch = previousFetch
  }
})

test('unknown library states warn without implying absence, and missing snapshots fail', async () => {
  const previousWindow = globalThis.window
  const previousFetch = globalThis.fetch
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { scholarseed: { getApiBase: () => '' } },
  })
  globalThis.fetch = async (url) =>
    String(url).endsWith('/results/card')
      ? Response.json({ session_id: 'session', papers: [{ id: 'one', title: 'Paper' }] })
      : Response.json({ items: { one: { library: 'unavailable' } } })
  try {
    const loaded = await loadConversationSearch('session', 'card', new AbortController().signal)
    assert.deepEqual(loaded.saved, [])
    assert.equal(loaded.warning, true)
    globalThis.fetch = async () => new Response('', { status: 404 })
    await assert.rejects(
      loadConversationSearch('session', 'missing', new AbortController().signal),
      /result_unavailable/
    )
  } finally {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
    globalThis.fetch = previousFetch
  }
})

test('forty published papers keep individual library states without reporting ambiguous matches as outages', async (context) => {
  const previousWindow = globalThis.window
  const previousFetch = globalThis.fetch
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { scholarseed: { getApiBase: () => '' } },
  })
  context.after(() => {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
    globalThis.fetch = previousFetch
  })
  const result = {
    session_id: 'session',
    retained: 40,
    papers: Array.from({ length: 40 }, (_, index) => ({
      id: String(index),
      title: `Paper ${index}`,
      doi: null,
      year: 2025,
    })),
  }
  const batches: number[] = []
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/results/card')) return Response.json(result)
    const body = JSON.parse(String(init?.body))
    assert.equal(body.project_id, 'project-two')
    batches.push(body.papers.length)
    return Response.json({
      items: Object.fromEntries(
        body.papers.map((paper: { id: string }) => [
          paper.id,
          {
            library: paper.id === '0' ? 'matched' : paper.id === '1' ? 'ambiguous' : 'absent',
          },
        ])
      ),
    })
  }
  const loaded = await loadConversationSearch(
    'session',
    'card',
    new AbortController().signal,
    'project-two'
  )
  assert.equal(loaded.warning, false)
  assert.deepEqual(batches, [20, 20])
  assert.equal(loaded.result.retained, 40)
  assert.deepEqual(loaded.result.papers, result.papers)
  assert.deepEqual(loaded.saved, ['0'])
  assert.equal(loaded.libraryStatuses['0'], 'matched')
  assert.equal(loaded.libraryStatuses['1'], 'ambiguous')
  assert.equal(loaded.libraryStatuses['39'], 'absent')
})

test('failed and malformed status batches remain unknown without losing successful matches or papers', async (context) => {
  const previousWindow = globalThis.window
  const previousFetch = globalThis.fetch
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { scholarseed: { getApiBase: () => '' } },
  })
  context.after(() => {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
    globalThis.fetch = previousFetch
  })
  const result = {
    session_id: 'session',
    retained: 40,
    papers: Array.from({ length: 40 }, (_, index) => ({
      id: String(index),
      title: `Paper ${index}`,
      doi: null,
      year: 2025,
    })),
  }
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/results/card')) return Response.json(result)
    const body = JSON.parse(String(init?.body))
    if (body.papers[0].id === '0') return new Response('', { status: 503 })
    return Response.json({
      items: { '20': { library: 'matched' }, '21': { library: 'future_status' } },
    })
  }
  const loaded = await loadConversationSearch('session', 'card', new AbortController().signal)
  assert.equal(loaded.warning, true)
  assert.equal(loaded.result.papers.length, 40)
  assert.deepEqual(loaded.saved, ['20'])
  assert.equal(loaded.libraryStatuses['0'], 'unavailable')
  assert.equal(loaded.libraryStatuses['20'], 'matched')
  assert.equal(loaded.libraryStatuses['21'], 'unavailable')
  assert.equal(loaded.libraryStatuses['39'], 'unavailable')
})

test('retrieval warnings map legacy diagnostics to localized keys without exposing internal parameters', () => {
  assert.deepEqual(
    searchWarningKeys([
      'agentic-search used degraded retrieval (source_mode=web_only)',
      'agentic-search used degraded retrieval (source_mode=web_only)',
      'agentic-search returned a partial result',
      'unknown-tool secret_parameter=value',
    ]),
    ['result.warning.webOnly', 'result.warning.partial', 'result.warning.limited']
  )
  assert.deepEqual(searchWarningKeys([]), [])
  for (const language of ['zh', 'en']) {
    const resource = JSON.parse(
      readFileSync(
        new URL(`../../../../localization/locales/${language}/literature.json`, import.meta.url),
        'utf8'
      )
    )
    const messages = searchWarningKeys([
      'agentic-search used degraded retrieval (source_mode=web_only)',
      'agentic-search used degraded retrieval (source_mode=metadata_only)',
      'agentic-search returned a partial result',
      'search trace unavailable; only metadata.json was supplied',
      'search abstracts filtered',
      'supplemental search shortfall',
      '检索来源统计未记录。',
      '来源候选数与候选池口径不一致，候选总数无法核对。',
      'private-tool raw_parameter=value',
    ]).map((key) => key.split('.').reduce((value, part) => value[part], resource))
    assert.equal(messages.length, 9)
    for (const message of messages) {
      assert.equal(typeof message, 'string')
      assert.ok(message.length > 0)
      assert.doesNotMatch(
        message,
        /agentic-search|source_mode|web_only|metadata\.json|private-tool|raw_parameter/
      )
      if (language === 'zh') assert.match(message, /[\u4e00-\u9fff]/)
    }
  }
})

test('unrestorable searches surface as an interrupted status instead of an internal code', () => {
  // 重启后 serve 只给投影状态: 前端必须把它当终态, 既不能再订阅 SSE, 也不能退回 unknown 文案。
  const source = readFileSync(new URL('./Search.tsx', import.meta.url), 'utf8')
  const presentation = readFileSync(new URL('./Matches.tsx', import.meta.url), 'utf8')
  assert.match(presentation, /search_interrupted: 'search\.status\.search_interrupted'/)
  const terminal = source.slice(
    source.indexOf('const TERMINAL_STATUSES'),
    source.indexOf('const RESULT_SORT_LABELS')
  )
  assert.match(terminal, /'search_interrupted'/)
  const contract = readFileSync(new URL('../../contracts/literature.ts', import.meta.url), 'utf8')
  assert.match(contract, /\| 'search_interrupted'/)
  const copies: Record<string, string> = { zh: '搜索被中断', en: 'Search interrupted' }
  for (const [locale, expected] of Object.entries(copies)) {
    const messages = JSON.parse(
      readFileSync(
        new URL(`../../../../localization/locales/${locale}/literature.json`, import.meta.url),
        'utf8'
      )
    )
    assert.equal(messages.search.status.search_interrupted, expected)
  }
})
