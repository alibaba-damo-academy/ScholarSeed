import assert from 'node:assert/strict'
import test from 'node:test'
import { outputCategory, visibleOutputs } from './catalog.ts'
import type { OutputGroup } from './catalog.ts'

const groups: OutputGroup[] = [
  {
    session: { session_id: 'first', title: 'First task' },
    artifacts: [
      {
        artifact_id: 'one',
        publication_id: 'p1',
        path: 'z.csv',
        name: 'z.csv',
        title: 'Data',
        role: 'supporting',
        updated_at: 20,
      },
      {
        artifact_id: 'two',
        publication_id: 'p2',
        path: 'a.md',
        name: 'a.md',
        role: 'final',
        updated_at: 10,
      },
    ],
  },
  {
    session: { session_id: 'second', title: 'Second task' },
    artifacts: [
      {
        artifact_id: 'three',
        publication_id: 'p3',
        path: 'a.md',
        name: 'a.md',
        role: 'intermediate',
        updated_at: 30,
      },
      { artifact_id: 'internal', path: 'run.log', name: 'run.log' },
    ],
  },
]

test('supporting files are process and only final deliveries are output', () => {
  assert.equal(outputCategory(groups[0].artifacts[0]), 'intermediate')
  assert.equal(outputCategory(groups[0].artifacts[1]), 'final')
  assert.equal(outputCategory(groups[1].artifacts[0]), 'intermediate')
})

test('name sorting sorts files inside each session and does not merge duplicate names', () => {
  const rows = visibleOutputs(groups, { sort: 'name', ascending: true, language: 'en' })
  assert.deepEqual(
    rows.map((row) => row.artifacts.map((item) => item.name)),
    [['a.md', 'z.csv'], ['a.md']]
  )
  assert.equal(groups[0].artifacts[0].name, 'z.csv')
})

test('search uses filenames even with a publication title and combines category and type', () => {
  const rows = visibleOutputs(groups, { query: 'z.csv', fileType: 'CSV', stage: 'intermediate' })
  assert.deepEqual(
    rows.map((row) => row.artifacts.map((item) => item.artifact_id)),
    [['one']]
  )
  assert.equal(visibleOutputs(groups, { query: 'Second task', stage: 'final' }).length, 0)
  assert.equal(visibleOutputs(groups, { query: 'missing' }).length, 0)
})

test('updated sorting retains session groups and excludes unpublished execution files', () => {
  const rows = visibleOutputs(groups, { sort: 'updated', ascending: false })
  assert.deepEqual(
    rows.map((row) => row.session.session_id),
    ['second', 'first']
  )
  assert.deepEqual(
    rows.flatMap((row) => row.artifacts.map((item) => item.artifact_id)),
    ['three', 'one', 'two']
  )
})
