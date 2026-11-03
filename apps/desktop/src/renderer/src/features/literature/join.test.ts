import assert from 'node:assert/strict'
import test from 'node:test'
import type { LiteratureSearchPaper } from '../../contracts/literature'
import { pushLibItem } from './join.ts'
import { collectionNodes, flattenDestinations, type JoinDestination } from './hierarchy.ts'
import type { importBibliography } from './api.ts'
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
