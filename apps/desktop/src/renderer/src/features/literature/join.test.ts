import assert from 'node:assert/strict'
import test from 'node:test'
import type { LiteratureSearchPaper } from '../../contracts/literature'
import {
  heldFulltextJoin,
  heldPaperIds,
  joinWithScope,
  pushLibItem,
  type HeldFulltextJoin,
} from './join.ts'
import {
  collectionNodes,
  flattenDestinations,
  joinCollectionOptions,
  type JoinDestination,
} from './hierarchy.ts'
import type { attachHeldFulltext, importBibliography } from './api.ts'
const paper = (id: string): LiteratureSearchPaper => ({
  paper_id: id,
  title: `Paper ${id}`,
  authors: ['Author'],
  year: 2026,
  venue: '',
  abstract: '',
  citation_count: null,
  doi: '',
  arxiv_id: '',
  tier: null,
  reason: '',
  subtopics_covered: [],
  access: '',
  source: '',
})
const openPaper = (id: string): LiteratureSearchPaper => ({ ...paper(id), access: 'open' })

test('join: global and nested project categories retain explicit destination scope', async () => {
  const options = joinCollectionOptions(
    [{ id: 'global', name: 'Smoke' }],
    [
      { id: 'parent', name: 'Parent' },
      { id: 'child', name: 'Child', parent_id: 'parent' },
    ],
    'project',
    { global: 'Global', project: 'Current project' }
  )
  assert.deepEqual(
    options.map(({ label, projectId }) => [label, projectId]),
    [
      ['Global / Smoke', undefined],
      ['Current project / Parent', 'project'],
      ['Current project / Parent / Child', 'project'],
    ]
  )
  const calls: Array<{ projectId?: string; collectionId?: string }> = []
  for (const option of options) {
    await pushLibItem(
      [paper('selected')],
      { ...option, path: [option.label] },
      option.projectId,
      async (_files, destination) => {
        calls.push(destination ?? {})
        return { items: [{ id: 'added' }], count: 1 } as Awaited<
          ReturnType<typeof importBibliography>
        >
      }
    )
  }
  assert.deepEqual(calls, [
    { projectId: undefined, collectionId: 'global' },
    { projectId: 'project', collectionId: 'parent' },
    { projectId: 'project', collectionId: 'child' },
  ])
})

test('join: direct, project, nested project and global destinations use one atomic admission API', async () => {
  for (const [destination, context] of [
    [{ path: [] }, undefined],
    [{ projectId: 'p', path: ['Project'] }, undefined],
    [{ projectId: 'p', collectionId: 'child', path: ['Project', 'Parent', 'Child'] }, undefined],
    [{ collectionId: 'global', path: ['Global'] }, undefined],
    [{ projectId: 'p', path: [] }, 'p'],
    [{ projectId: 'p', collectionId: 'child', path: ['Parent', 'Child'] }, 'p'],
  ] as Array<[JoinDestination, string | undefined]>) {
    let calls = 0
    const admit: typeof importBibliography = async (files, options) => {
      calls++
      assert.equal(options?.projectId, destination.projectId)
      assert.equal(options?.collectionId, destination.collectionId)
      assert.equal(files.length, 1)
      const bib = await files[0].text()
      assert.match(bib, /Paper a/)
      assert.match(bib, /Paper b/)
      return { items: [{ id: 'lib-a' }, { id: 'lib-b' }], count: 2 } as Awaited<
        ReturnType<typeof importBibliography>
      >
    }
    assert.deepEqual(await pushLibItem([paper('a'), paper('b')], destination, context, admit), [
      'lib-a',
      'lib-b',
    ])
    assert.equal(calls, 1)
  }
})
test('join: project context cannot accidentally admit to a global or different project collection', async () => {
  let called = false
  const admit: typeof importBibliography = async () => {
    called = true
    throw new Error('unreachable')
  }
  await assert.rejects(
    pushLibItem([paper('x')], { collectionId: 'global', path: [] }, 'p', admit),
    /scope_mismatch/
  )
  assert.equal(called, false)
})
test('join: duplicate clicks across surfaces are blocked; a failed request releases the guard', async () => {
  let reject!: (error: Error) => void
  const admit: typeof importBibliography = () =>
    new Promise((_, fail) => {
      reject = fail
    })
  const first = pushLibItem([paper('pending')], { path: [] }, undefined, admit)
  await assert.rejects(
    pushLibItem([paper('pending')], { path: [] }, undefined, admit),
    /in_progress/
  )
  reject(new Error('network'))
  await assert.rejects(first, /network/)
  await assert.rejects(
    pushLibItem([paper('pending')], { path: [] }, undefined, async () => {
      throw new Error('retry reached API')
    }),
    /retry reached API/
  )
})
test('join: hierarchy retains full paths and project scope at arbitrary depth', () => {
  const tree = collectionNodes(
    [
      { id: 'a', name: 'Parent' },
      { id: 'b', name: 'Child', parent_id: 'a' },
      { id: 'c', name: 'Grandchild', parent_id: 'b' },
    ],
    'p',
    ['Project']
  )
  const flat = flattenDestinations(tree)
  assert.deepEqual(
    flat.map((value) => value.depth),
    [0, 1, 2]
  )
  assert.deepEqual(flat[2].node.path, ['Project', 'Parent', 'Child', 'Grandchild'])
  assert.equal(flat[2].node.projectId, 'p')
  assert.equal(flat[2].node.collectionId, 'c')
})
test('join: the fulltext option exists only for a precise-search card with held papers', () => {
  const papers = [openPaper('a'), paper('b')]
  assert.equal(heldFulltextJoin(undefined, papers, { a: 'managed' }), undefined)
  assert.equal(heldFulltextJoin(SOURCE, papers, null), undefined)
  assert.equal(heldFulltextJoin(SOURCE, papers, {}), undefined)
  assert.equal(heldFulltextJoin(SOURCE, papers, { z: 'managed' }), undefined)
  // 技能自己下进 run 目录的 PDF 同样算已下载。
  assert.deepEqual(heldFulltextJoin(SOURCE, papers, { b: 'run' }), {
    source: SOURCE,
    paperIds: ['b'],
  })
  assert.deepEqual(heldFulltextJoin(SOURCE, papers, { a: 'managed', b: 'run' }), {
    source: SOURCE,
    paperIds: ['a', 'b'],
  })
})

test('join: held ids follow the selection order, not the response order', () => {
  const papers = [paper('a'), openPaper('b'), paper('c')]
  assert.deepEqual(heldPaperIds(papers, { c: 'run', a: 'managed' }), ['a', 'c'])
  assert.deepEqual(heldPaperIds(papers, null), [])
})

const SOURCE = { sessionId: 'session-1', cardId: 'card-1' }
const heldJoin = (paperIds: string[]): HeldFulltextJoin => ({ source: SOURCE, paperIds })

test('join: metadata scope admits once and never attaches fulltext', async () => {
  const calls: Array<readonly unknown[]> = []
  const outcome = await joinWithScope(
    [openPaper('a'), paper('b')],
    'metadata',
    { path: [] },
    undefined,
    heldJoin(['a', 'b']),
    async () => ['lib-a', 'lib-b'],
    async (_session, _card, papers) => {
      calls.push(papers)
      return { items: [], acquired: 0, fulltext: 0, failed: 0 }
    }
  )
  assert.deepEqual(outcome, { ids: ['lib-a', 'lib-b'], fulltext: 0, fulltextFailed: 0 })
  assert.deepEqual(calls, [])
})

test('join: fulltext scope reuses only the already downloaded papers, in order', async () => {
  const calls: Array<{ literature_id: string; paper_id: string }> = []
  const outcome = await joinWithScope(
    [openPaper('a'), paper('b'), openPaper('c')],
    'fulltext',
    { path: [] },
    undefined,
    heldJoin(['a', 'c']),
    async () => ['lib-a', 'lib-b', 'lib-c'],
    async (session, card, papers) => {
      assert.equal(session, SOURCE.sessionId)
      assert.equal(card, SOURCE.cardId)
      calls.push(...papers)
      return { items: [], acquired: 2, fulltext: 2, failed: 0 }
    }
  )
  assert.deepEqual(calls, [
    { literature_id: 'lib-a', paper_id: 'a' },
    { literature_id: 'lib-c', paper_id: 'c' },
  ])
  assert.deepEqual(outcome, { ids: ['lib-a', 'lib-b', 'lib-c'], fulltext: 2, fulltextFailed: 0 })
})

test('join: without a precise-search source the fulltext scope stays metadata only', async () => {
  const outcome = await joinWithScope(
    [openPaper('a')],
    'fulltext',
    { path: [] },
    undefined,
    undefined,
    async () => ['lib-a'],
    async () => {
      throw new Error('must not download again')
    }
  )
  assert.deepEqual(outcome, { ids: ['lib-a'], fulltext: 0, fulltextFailed: 0 })
})

test('join: a held paper without an admitted id is reported as missing fulltext', async () => {
  const outcome = await joinWithScope(
    [openPaper('a'), openPaper('b')],
    'fulltext',
    { path: [] },
    undefined,
    heldJoin(['a', 'b']),
    async () => ['lib-a'],
    async (_session, _card, papers) => ({
      items: [],
      acquired: papers.length,
      fulltext: papers.length,
      failed: 0,
    })
  )
  assert.deepEqual(outcome, { ids: ['lib-a'], fulltext: 1, fulltextFailed: 0 })
})

test('join: an attach failure keeps the admitted metadata and reports the gap', async () => {
  const outcome = await joinWithScope(
    [openPaper('a')],
    'fulltext',
    { path: [] },
    undefined,
    heldJoin(['a']),
    async () => ['lib-a'],
    async () => {
      throw new Error('literature_held_fulltext_unavailable')
    }
  )
  assert.deepEqual(outcome, { ids: ['lib-a'], fulltext: 0, fulltextFailed: 1 })
})

test('join: serve-reported failures are counted without discarding successes', async () => {
  const outcome = await joinWithScope(
    [openPaper('a'), openPaper('b')],
    'fulltext',
    { path: [] },
    undefined,
    heldJoin(['a', 'b']),
    async () => ['lib-a', 'lib-b'],
    (async () => ({
      items: [],
      acquired: 1,
      fulltext: 1,
      failed: 1,
    })) as unknown as typeof attachHeldFulltext
  )
  assert.deepEqual(outcome, { ids: ['lib-a', 'lib-b'], fulltext: 1, fulltextFailed: 1 })
})
