import assert from 'node:assert/strict'
import test from 'node:test'
import type { AnswerSource } from '../../model.ts'
import type { CitationResolution } from '../../contracts/citations.ts'
import {
  citationSourceGroupKeys,
  citationSourceType,
  groupCitationReferences,
  groupCitationSources,
  groupWebCitationSources,
} from './grouping.ts'

test('web citations group by declared links and retain unique pages in body order', () => {
  const first = {
    kind: 'searched',
    number: 1,
    url: 'https://example.org/first',
    title: 'First',
    search_kind: 'web',
    search_id: '',
    citation_urls: ['first', 'alias'],
  } satisfies AnswerSource
  const second = {
    ...first,
    number: 2,
    url: 'https://example.org/second',
    citation_urls: ['second'],
  }
  assert.deepEqual(citationSourceGroupKeys([], [first, second]), {
    first: 'searched',
    alias: 'searched',
    second: 'searched',
  })
  const entries = ['second', 'alias', 'first', 'unknown'].map((href, start) => ({
    href,
    start,
    end: start + 1,
    label: href,
  }))
  assert.deepEqual(groupWebCitationSources(entries, [first, second]), [second, first])
})

test('source labels and grouping share explicit origin classes without a local-file fallback', () => {
  const expected = {
    file: 'citations.fileSource',
    literature: 'citations.paperSource',
    resource: 'citations.resourceSource',
    attachment: 'citations.attachmentSource',
    selection: 'citations.selectionSource',
    managed_fulltext: 'citations.fileSource',
  }
  for (const [kind, labelKey] of Object.entries(expected)) {
    assert.deepEqual(citationSourceType(kind), { labelKey, groupKey: kind })
  }
  for (const kind of ['unregistered', '', 'constructor', '__proto__']) {
    assert.deepEqual(citationSourceType(kind), { labelKey: 'citations.unknownSource' })
  }
  const sources = [...Object.keys(expected), 'unregistered'].map(
    (kind) =>
      ({
        handle: kind,
        source_kind: kind,
        title: 'same.pdf',
        bibliography: { title: 'Same title' },
      }) as CitationResolution
  )
  const keys = citationSourceGroupKeys(sources, [
    { kind: 'receipt', handle: 'resource', citation_urls: ['registered-resource'], number: 1 },
  ])
  for (const kind of Object.keys(expected)) assert.equal(keys[`scholarseed-cite:${kind}`], kind)
  assert.equal(keys['registered-resource'], 'resource')
  assert.equal(keys['scholarseed-cite:unregistered'], undefined)
})

test('paragraph groups deduplicate document identity without losing occurrences, snippets or opening ranges', async () => {
  const source = (
    handle: string,
    sourceId: string,
    revision: string,
    page?: number
  ): CitationResolution => ({
    handle,
    source_id: sourceId,
    source_kind: 'file',
    content_level: 'selection',
    project_id: 'project',
    revision,
    path: sourceId,
    title: sourceId,
    pages: page === undefined ? [] : [{ page, quads: [] }],
    quote: 'Identical excerpt',
    version_bound: true,
    state: 'exact',
    matches: [],
    presentation: {
      version: 1,
      mode: 'structured_text',
      precision: page === undefined ? 'source' : 'page',
      text: 'Identical excerpt',
      quality_reasons: [],
      manual_check: false,
    },
  })
  const documents = [
    source('first', 'same.pdf', 'v1', 1),
    source('second', 'same.pdf', 'v1', 2),
    source('third', 'other.pdf', 'v1'),
    source('new-version', 'same.pdf', 'v2'),
    source('first', 'same.pdf', 'v1', 1),
    source('without-page', 'same.pdf', 'v1'),
  ]
  const entries = documents.map((document, index) => ({
    href: `scholarseed-cite:${document.handle}`,
    start: index,
    end: index + 1,
    label: document.title,
  }))
  const opened: number[] = []
  const groups = groupCitationReferences(entries, documents, async (document, entry) => {
    opened.push(entry.start)
    return document
  })
  assert.equal(groups.length, 3)
  assert.equal(groups[0].occurrences, 4)
  assert.deepEqual(
    groups[0].excerpts?.map(({ source }) => source.pages.map(({ page }) => page)),
    [[1], [2], []]
  )
  assert.equal((await groups[0].excerpts?.[1].resolve())?.handle, 'second')
  await groups[1].resolve()
  assert.deepEqual(opened, [1, 2])
})

test('project navigation sources deduplicate across body and table without becoming verified receipts', () => {
  const source = {
    kind: 'project' as const,
    source_kind: 'resource' as const,
    project_id: 'p',
    path: 'output/report.md',
    title: 'report.md',
    url: '/api/resource/raw?project=p&path=output%2Freport.md',
    citation_urls: [],
  }
  const groups = groupCitationSources(
    [
      { ...source, number: 1 },
      { ...source, number: 2 },
      { ...source, project_id: 'other', number: 3 },
    ],
    []
  )
  assert.deepEqual(
    groups.map((group) => group.sources.map((item) => item.number)),
    [[1, 2], [3]]
  )
})

test('turn source groups stay stable with missing or conflicting detail responses', () => {
  const sources = [
    { kind: 'receipt', handle: 'first', number: 1, citation_urls: [], source_group_id: 'file-v1' },
    { kind: 'receipt', handle: 'second', number: 2, citation_urls: [], source_group_id: 'file-v1' },
    {
      kind: 'receipt',
      handle: 'new-version',
      number: 3,
      citation_urls: [],
      source_group_id: 'file-v2',
    },
    {
      kind: 'receipt',
      handle: 'other-file',
      number: 4,
      citation_urls: [],
      source_group_id: 'other-v1',
    },
    { kind: 'receipt', handle: 'unknown', number: 5, citation_urls: [], source_group_id: null },
    {
      kind: 'searched',
      number: 6,
      url: 'https://example.org/',
      title: 'Web',
      search_kind: 'web',
      search_id: '',
      citation_urls: [],
    },
  ] satisfies AnswerSource[]
  const conflictingDetail = {
    handle: 'second',
    project_id: 'project',
    source_kind: 'file',
    source_id: 'other.pdf',
    revision: 'v2',
  } as CitationResolution

  for (const resolutions of [[], [conflictingDetail]]) {
    assert.deepEqual(
      groupCitationSources(sources, resolutions).map((group) =>
        group.sources.map((source) => source.number)
      ),
      [[1, 2], [3], [4], [6]]
    )
  }
})

test('groups sources by verified identity while retaining each occurrence and revision', () => {
  const sources: AnswerSource[] = [
    { kind: 'receipt', handle: 'first', number: 1, citation_urls: ['one'] },
    { kind: 'receipt', handle: 'second', number: 2, citation_urls: ['two'] },
    { kind: 'receipt', handle: 'other-revision', number: 3, citation_urls: ['three'] },
    { kind: 'receipt', handle: 'unresolved', number: 4, citation_urls: [] },
    {
      kind: 'searched',
      url: 'https://example.org/',
      title: '网页',
      number: 5,
      search_kind: 'web',
      search_id: 's1',
      citation_urls: ['a'],
    },
    {
      kind: 'searched',
      url: 'https://example.org/',
      title: '网页',
      number: 6,
      search_kind: 'web',
      search_id: 's2',
      citation_urls: ['b'],
    },
  ]
  const resolution = (handle: string, revision: string) =>
    ({
      handle,
      source_kind: 'file',
      source_id: 'doc',
      project_id: 'project',
      revision,
    }) as CitationResolution
  const groups = groupCitationSources(sources, [
    resolution('first', 'v1'),
    resolution('second', 'v1'),
    resolution('other-revision', 'v2'),
  ])
  assert.deepEqual(
    groups.map((group) => group.sources.map((source) => source.number)),
    [[1, 2], [3], [4], [5, 6]]
  )
})
